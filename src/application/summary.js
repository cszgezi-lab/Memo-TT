import {MAX_PARALLEL_SUMMARY_BATCHES,shouldPauseProviderBatch} from '../provider-scheduler.js';
import { HostAdapter } from '../host-adapter.js';
import { sha256, makeId, stableStringify } from '../utils.js';
import { numberedSummaryBatches, planSummaryRanges, batchRecords, MEMORY_CATEGORIES, batchOperationIds, sameBatchRange, savedBatchOperation, summaryOverwritePlan, canRetryInParallel } from '../product-batches.js';
import { failureText } from '../product-feedback.js';
import { createWorkspace } from '../product-workspace.js';
import { summaryCoverage, missingSummaryRanges, retireIncompleteSyncTails } from '../product-auto-summary.js';
import { errorDiagnostics } from '../diagnostics.js';
import { qualityTargets } from '../product-quality-plan.js';
import { runStorageOperation } from '../reliable-storage.js';

/** summary orchestration. Dependencies are limited by service-contracts.js. */
export function createSummaryService(appScope) {
let parallelPreview=null;
async function prepareSummaryChat(){
    if(appScope.following)await appScope.following;
    if(appScope.active||appScope.opening)throw new Error('已有任务正在运行，请等待完成或停止');
    const version=appScope.cancelVersion;appScope.hostAdapter??=new HostAdapter(appScope.host);
    let target;try{target=await appScope.hostAdapter.currentRef();}catch{throw Object.assign(new Error('无法读取 TT 当前聊天'),{code:'CHAT_REF_UNAVAILABLE'});}
    if(version!==appScope.cancelVersion)throw Object.assign(new Error('任务已停止'),{code:'CANCELED'});
    if(!target)throw Object.assign(new Error('TT 当前没有打开聊天'),{code:'CHAT_REF_UNAVAILABLE'});
    if(appScope.workspace?.isCurrent()&&!appScope.state.stale&&appScope.boundRefKey===stableStringify(target)){if(appScope.state.sourceStatus?.pending)await appScope.refresh({boundOnly:true});return;}
    appScope.summaryFeedback('running','正在读取 TT 当前聊天…','manual');
    await appScope.open({enable:appScope.enabled,expectedRef:target});
    if(appScope.state.sourceStatus?.pending)await appScope.refresh({boundOnly:true});
  }

async function previewSummary(options={}){
    if(options.parallelConcurrency!==undefined)return previewParallel(options);
    await prepareSummaryChat();const lastIndex=await appScope.core.historyTail(),list=await appScope.workspace.read('summary-batches',[]);
    const size=options.batchSize??appScope.core.settings.summaryBatchSize;
    const ranges=planSummaryRanges({...options,count:options.count??appScope.core.settings.messageCount,lastIndex,batchSize:size});
    const plan=summaryOverwritePlan(ranges,list,size,lastIndex);
    return {...plan,previewHash:appScope.overwriteHash(plan)};
  }

const parallelSelection=options=>[options.count,options.startIndex,options.endIndex,options.batchSize,options.focus??'',options.parallelConcurrency,options.retryBatchIds];
const overlaps=(a,b)=>a.startIndex<=b.endIndex&&a.endIndex>=b.startIndex;
const unfinished=b=>['queued','running','failed','interrupted'].includes(b.status);
const batchFingerprint=rows=>rows.map(b=>[b.id,b.startIndex,b.endIndex,b.status,b.operationId,b.savedOperationId,b.partialSummary?.savedFloors,b.focus,b.parallelSourceRevision,b.parallelRecipe,b.replacement?.id]);

function parallelRuntimes(check){
    const runtimes=new Map();
    return {
      get(focus){
        if(!runtimes.has(focus))runtimes.set(focus,appScope.core.prepareParallelSummary({focus,check}));
        return runtimes.get(focus);
      },
      signatures:()=>[...runtimes].map(([focus,runtime])=>[focus,runtime.signature]),
    };
  }

async function previewParallel(options){
    await prepareSummaryChat();
    const check=appScope.continuationCheck();
    const concurrency=options.parallelConcurrency;
    if(!Number.isInteger(concurrency)||concurrency<1||concurrency>MAX_PARALLEL_SUMMARY_BATCHES)throw new Error(`并行批数应为 1–${MAX_PARALLEL_SUMMARY_BATCHES} 的整数`);
    const batchSize=options.batchSize??appScope.core.settings.summaryBatchSize;
    const lastIndex=await appScope.core.historyTail();check();
    await appScope.refresh({check});check();
    const allRows=appScope.state.batches;
    let retryRows=null;
    if(options.retryBatchIds!==undefined){
      if(!Array.isArray(options.retryBatchIds)||!options.retryBatchIds.length)throw new Error('请选择要重试的批次');
      retryRows=[...new Set(options.retryBatchIds)].map(id=>allRows.find(b=>b.id===id));
      if(retryRows.some(b=>!b||b.status!=='saved'&&!canRetryInParallel(b)))throw new Error('请分开选择并行批次和顺序批次');
      retryRows=retryRows.filter(canRetryInParallel);
      if(!retryRows.length)return {concurrency,plannedBatches:0,maxRequests:0,ranges:[]};
      retryRows.sort((a,b)=>a.startIndex-b.startIndex);
    }
    const selected=retryRows??planSummaryRanges({...options,count:options.count??appScope.core.settings.messageCount,lastIndex,batchSize});
    const requested={startIndex:selected[0].startIndex,endIndex:selected.reduce((end,row)=>Math.max(end,row.endIndex),0)};
    const rows=allRows.filter(b=>overlaps(b,requested));
    const coverage=summaryCoverage(rows,{startFloor:requested.startIndex,lastIndex:requested.endIndex,keepRecent:0,batchSize});
    const retryTargets=retryRows;
    const pending=rows.filter(b=>unfinished(b)&&coverage.missingRanges.some(r=>overlaps(b,r))&&(!retryTargets||retryTargets.some(r=>overlaps(b,r))));
    if(pending.some(b=>!b.parallelBatch&&(b.operationId||b.replacement)))throw new Error('选区有原先未完成的总结。请在批次列表重试或撤下原批次，再并行补缺口。');
    const prior=retryTargets??pending.filter(b=>b.parallelBatch);
    if(prior.some(b=>!coverage.missingRanges.some(r=>b.startIndex>=r.startIndex&&b.endIndex<=r.endIndex)))
      throw new Error('选区切到了未完成的并行批次。请选完整批次，或从批次列表单独重试。');
    const gaps=retryTargets?retryTargets.map(row=>({startIndex:row.startIndex,endIndex:row.endIndex,prior:row})):coverage.missingRanges.flatMap(gap=>{
      const within=prior.filter(b=>overlaps(gap,b)).sort((a,b)=>a.startIndex-b.startIndex);
      const parts=[];let cursor=gap.startIndex;
      for(const row of within){
        if(row.startIndex<cursor)throw new Error('已有重叠的并行批次，请从批次列表处理');
        if(cursor<row.startIndex)parts.push({startIndex:cursor,endIndex:row.startIndex-1});
        parts.push({startIndex:row.startIndex,endIndex:row.endIndex,prior:row});
        cursor=row.endIndex+1;
      }
      if(cursor<=gap.endIndex)parts.push({startIndex:cursor,endIndex:gap.endIndex});
      return parts;
    });
    if(retryTargets?.some((row,i)=>i>0&&overlaps(row,retryTargets[i-1])))throw new Error('所选批次有重叠，请先处理其中一批');
    const runtimes=parallelRuntimes(check);
    const planned=[];
    async function admit(range){
      check();
      const prior=range.prior;
      const focus=(retryTargets?prior.focus:options.focus)??'';
      const runtime=runtimes.get(focus);
      let operationId=prior?.operationId??makeId('product-summary');
      let sourceRevision;
      try{sourceRevision=await runtime.inspect({...range,operationId});}
      catch(error){
        if(error.code!=='INPUT_BUDGET_EXCEEDED'||prior||range.startIndex===range.endIndex)throw error;
        const middle=Math.floor((range.startIndex+range.endIndex)/2);
        await admit({startIndex:range.startIndex,endIndex:middle});
        await admit({startIndex:middle+1,endIndex:range.endIndex});
        return;
      }
      if(prior&&(prior.parallelRecipe!==runtime.recipe||prior.parallelSourceRevision!==sourceRevision))operationId=makeId('product-summary');
      planned.push({id:prior?.id??makeId('summary-batch'),operationId,startIndex:range.startIndex,endIndex:range.endIndex,
        parallelBatch:true,parallelRecipe:runtime.recipe,parallelSourceRevision:sourceRevision,focus,trigger:'manual',
        status:'queued',freshStart:true,createdAt:prior?.createdAt??Date.now(),error:null});
    }
    for(const gap of gaps)for(const range of gap.prior?[gap]:planSummaryRanges({...gap,lastIndex,batchSize}))await admit(range);
    check();
    const selection=parallelSelection(options),fingerprint=batchFingerprint(rows),signature=runtimes.signatures();
    const previewHash=sha256([appScope.workspace.scope,requested,selection,fingerprint,planned,signature]);
    parallelPreview={previewHash,requested,selection,fingerprint,signature,planned,concurrency,retry:Boolean(retryTargets)};
    return {previewHash,requested,concurrency,plannedBatches:planned.length,maxRequests:planned.length,
      ranges:planned.map(({startIndex,endIndex})=>({startIndex,endIndex})),coveredFloors:coverage.coveredFloors};
  }

async function runParallel(options,diagnosticRun){
    await prepareSummaryChat();
    const op=appScope.begin(),plan=parallelPreview;
    parallelPreview=null;
    op.parallelBatchIds=new Set();
    op.monitor={trigger:'manual',phase:'preparing',completedBatches:0,totalBatches:plan?.planned.length??0,requestNumber:0,
      ...plan?.requested};
    appScope.activeSummaryOperation=op;
    let saved=0,requests=0,cursor=0,failed=0,pauseError=null,saveTail=Promise.resolve();
    const check=()=>op.check();
    const saveRow=async row=>{
      await op.workspace.update('summary-batches',rows=>rows.map(b=>b.id===row.id&&b.operationId===row.operationId?row:b),[],{check});
      appScope.state.batches=appScope.state.batches.map(b=>b.id===row.id?{...b,...row}:b);
      appScope.notify();
    };
    try{
      if(!plan||plan.previewHash!==options.previewHash||stableStringify(plan.selection)!==stableStringify(parallelSelection(options)))
        throw new Error('请重新预览并行批次');
      if(!plan.planned.length)return {status:'complete',batches:0,requests:0};
      await appScope.refresh({check});check();
      const runtimes=parallelRuntimes(check);
      for(const row of plan.planned)runtimes.get(row.focus);
      if(stableStringify(runtimes.signatures())!==stableStringify(plan.signature)||stableStringify(batchFingerprint(appScope.state.batches.filter(b=>overlaps(b,plan.requested))))!==stableStringify(plan.fingerprint))
        throw new Error('总结设置或已保存范围有变化，请重新预览');
      const planned=await op.workspace.update('summary-batches',rows=>{
        const max=Math.max(0,...rows.map(b=>b.number??0));
        const next=plan.planned.map((row,i)=>({...row,number:rows.find(b=>b.id===row.id)?.number??max+i+1}));
        const ids=new Set(next.map(b=>b.id));
        return [...rows.filter(b=>!ids.has(b.id)),...next];
      },[],{check});
      const rows=plan.planned.map(row=>planned.find(b=>b.id===row.id));
      appScope.state.batches=[...appScope.state.batches.filter(b=>!rows.some(row=>row.id===b.id)),...rows];
      const title=plan.retry?'并行重试':'并行补总结';
      appScope.summaryFeedback('running',`${title} · 共 ${rows.length} 批 · 同时最多 ${plan.concurrency} 批`,'manual');
      const group=makeId('summary-parallel');
      async function worker(){
        while(!pauseError&&!op.signal.aborted&&cursor<rows.length){
          const row={...rows[cursor++],status:'running',freshStart:false};
          const runtime=runtimes.get(row.focus);
          let generating=false;
          op.parallelBatchIds.add(row.id);
          try{
            await saveRow(row);check();
            if(pauseError){await saveRow({...row,status:'queued',freshStart:true});return;}
            generating=true;
            const result=await runtime.generate(row,{signal:op.signal,parallelGroup:group,parallelLimit:plan.concurrency,onDiagnostic:event=>{
              if(event.phase==='request'&&event.level==='info')requests++;
              appScope.runtimeLog.record({run:diagnosticRun,task:'summary',...event,details:{...event.details,batchNumber:row.number}});
            }});
            generating=false;
            const save=saveTail.then(async()=>{
              check();
              await runtime.save(row,result);check();
              saved++;
              await saveRow({...row,status:'saved',savedOperationId:row.operationId,requests:result.requests});
              appScope.summaryMonitor(op,{phase:'saving',completedBatches:saved,requestNumber:requests});
              await appScope.refresh({check,summaryCommit:true});
              appScope.summaryFeedback('running',`${title} · 已保存 ${saved}/${rows.length} 批`,'manual');
            });
            saveTail=save.catch(()=>{});
            await save;
          }catch(error){
            failed++;
            if(!plan.retry||!generating||shouldPauseProviderBatch(error)||
              ['PERSISTENCE_ERROR','CHAT_CHANGED','CANCELED'].includes(error.code)||
              ['invalid_api_key','insufficient_quota','outbound_host_denied'].includes(error.details?.upstreamCode))pauseError??=error;
            if(!op.signal.aborted)await saveRow({...row,status:'failed',error:failureText(error)}).catch(()=>{});
          }finally{op.parallelBatchIds.delete(row.id);}
        }
      }
      await Promise.all(Array.from({length:Math.min(plan.concurrency,rows.length)},worker));
      check();
      await appScope.refresh({check,summaryCommit:true});
      if(pauseError){
        appScope.summaryFeedback('warning',`${title}已暂停，保存 ${saved}/${rows.length} 批。未完成批次可继续。${failureText(pauseError)}`,'manual');
        return {status:'paused',batches:saved,requests,failed,level:'warning'};
      }
      if(failed){
        appScope.summaryFeedback('warning',`${title}已保存 ${saved} 批，${failed} 批失败，可在批次列表继续处理。`,'manual');
        return {status:'partial',batches:saved,requests,failed,level:'warning'};
      }
      appScope.summaryFeedback('success',`${title}已保存 ${saved} 批。`,'manual');
      return {status:'saved',batches:saved,requests};
    }finally{
      if(appScope.activeSummaryOperation===op)appScope.activeSummaryOperation=null;
      op.finish();
    }
  }

async function publishSummaryReplacement(replacement,op){
    const rows=await appScope.workspace.read('summary-batches',[]);op.check();
    // Existing formal coverage is replaced atomically (U118). Individual
    // candidates can be retried, regenerated and split without publishing
    // an incomplete replacement or retiring the original tail.
    const memberIds=replacement.memberIds;
    const members=memberIds.map(id=>rows.find(b=>b.id===id));
    if(members.some(b=>!b?.replacementReady||b.status==='deleted'))return false;
    const view=await appScope.core.readMemoryView();op.check();
    if(members.some(b=>view.controls?.operations?.[b.operationId]==='deleted'))throw Object.assign(new Error('所选候选已被删除，未重新应用；可在回收站恢复仍开放的任务'),{code:'CANCELED'});
    if(replacement.editsHash&&appScope.replacementEditsHash(replacement.recordIds,view.controls)!==replacement.editsHash)throw Object.assign(new Error('覆盖期间旧记忆有新的人工修改，请撤下候选后重新预览；没有覆盖该修改'),{code:'SUMMARY_REBUILD_CONFLICT'});
    if(appScope.summaryRecipeHash()!==replacement.recipeHash)throw Object.assign(new Error('覆盖期间记录规则已变化；请撤下候选后重新覆盖，旧记忆保留'),{code:'SOURCE_INVALIDATED'});
    for(const b of members){
      const current=await appScope.core.readRange({startIndex:b.startIndex,endIndex:b.endIndex});op.check();
      if(current.status!=='ready'||current.sourceRevision!==b.sourceRevision)throw Object.assign(new Error(`覆盖候选 #${b.startIndex}–${b.endIndex} 的原文已变化；请撤下候选后重新覆盖，旧记忆保留`),{code:'SOURCE_INVALIDATED'});
    }
    // Source reads can yield to settings or manual edits. Verify the current
    // commit snapshot again, including authoritative deletion controls, before
    // activating any cached candidate.
    const currentView=await appScope.core.readMemoryView();op.check();
    if(members.some(b=>currentView.controls?.operations?.[b.operationId]==='deleted'))throw Object.assign(new Error('所选候选已被删除，没有重新应用'),{code:'CANCELED'});
    if(replacement.editsHash&&appScope.replacementEditsHash(replacement.recordIds,currentView.controls)!==replacement.editsHash)throw Object.assign(new Error('覆盖期间旧记忆有新的人工修改，没有覆盖该修改'),{code:'SUMMARY_REBUILD_CONFLICT'});
    if(appScope.summaryRecipeHash()!==replacement.recipeHash)throw Object.assign(new Error('覆盖期间记录规则已变化，旧记忆保留；请重新建立覆盖计划'),{code:'SOURCE_INVALIDATED'});
    const canceledIds=replacement.canceledIds??[];
    const retire=[...replacement.oldOperations,...members.flatMap(b=>b.attempts??[]),...rows.filter(b=>canceledIds.includes(b.id)).flatMap(batchOperationIds)];
    const oldBatchIds=replacement.oldIds;
    const hold=replacement.discardedTail||replacement.explicitCutoff?{id:replacement.id,endIndex:replacement.requested.endIndex,discardedTail:replacement.discardedTail}:null;
    await appScope.core.updateMemoryControls({operations:{...Object.fromEntries(retire.map(id=>[id,'deleted'])),...Object.fromEntries(members.map(b=>[b.operationId,'active']))},...(hold?{automation:{summaryHold:hold}}:{})});op.check();
    if(hold){appScope.state.summaryHold=hold;appScope.state.savedThrough=replacement.requested.endIndex;}
    await appScope.workspace.update('summary-batches',list=>list.map(b=>memberIds.includes(b.id)?{...b,status:'saved',savedOperationId:b.operationId,error:null}:oldBatchIds.includes(b.id)||canceledIds.includes(b.id)?{...b,status:'deleted',replacedBy:replacement.id}:b),[]).catch(()=>{});
    return true;
  }

async function summarize(options={}){return appScope.logged('summary',run=>options.parallelConcurrency!==undefined
    ?runParallel(options,run):summarizeTask({...options,diagnosticRun:run}),{trigger:options.trigger??'manual'});}

async function summarizeTask({count,startIndex,endIndex,batchSize,focus='',trigger='manual',replaceBatchId=null,resume=false,rebuildCandidate=false,missingOnly=false,fullBatchesOnly=false,previewHash=null,diagnosticRun,allowInvalidToolRetry=false}={}){
    const taskStarted=Date.now();let firstRequestAt=null,modelMs=0,publishMs=0;
    if(trigger==='manual'&&!replaceBatchId){
      const version=appScope.cancelVersion;
      try{await prepareSummaryChat();if(version!==appScope.cancelVersion)throw Object.assign(new Error('任务已停止'),{code:'CANCELED'});}catch(error){appScope.summaryFeedback(['CANCELED','CHAT_CHANGED','SOURCE_INVALIDATED'].includes(error.code)?'info':'error',`总结未完成：${failureText(error)}`,trigger);throw error;}
    }
    if(!appScope.workspace)throw Object.assign(new Error('当前聊天尚未读取'),{code:'CHAT_REF_UNAVAILABLE'});
    batchSize??=appScope.core.settings.summaryBatchSize;
    const op=appScope.begin();op.monitor={trigger:trigger==='auto'?'auto':'manual',phase:'preparing',completedBatches:0,totalBatches:0,requestNumber:0,...(Number.isSafeInteger(startIndex)?{startIndex}:{}),...(Number.isSafeInteger(endIndex)?{endIndex}:{})};appScope.activeSummaryOperation=op;
    if(trigger==='auto'&&appScope.autoRunOwner)appScope.autoRunOwner.controller=appScope.active;
    let saved=0,currentBatch=null,remainingPlanned=0,bookkeepingWarning=false,deferredRecords=0,skippedRecords=0,skippedLinks=0,automaticQualityIds=[],usedVerification=appScope.core.settings.summaryReviewEnabled,stagedOnly=false,partialSummary=null;
    appScope.summaryFeedback('running','正在读取总结范围…',trigger);
    try{
      // Read current source again only inside the same bound chat.
      if(appScope.state.stale){const probe=await appScope.core.readRange({count:1});if(probe.status!=='ready')throw new Error('请重新打开当前聊天');appScope.workspace=createWorkspace(appScope.core.workspace());}
      op.check();const lastIndex=await appScope.core.historyTail();op.check();
      appScope.state.autoLastIndex=lastIndex;
      if(missingOnly){await appScope.syncAutoStartFloor(diagnosticRun,{check:op.check,resumeAfterDeletion:true});op.check();batchSize=appScope.core.settings.autoSummaryEvery;}
      const coverage=missingOnly?summaryCoverage(appScope.validAutomaticBatches(),{advanceFromLatest:true,startFloor:appScope.state.autoStartFloor??1,originFloor:appScope.state.autoOriginFloor,lastIndex,keepRecent:appScope.core.settings.autoKeepRecent,batchSize}):null;
      if(missingOnly&&fullBatchesOnly){
        const oldRows=await appScope.workspace.read('summary-batches',[]);op.check();
        const rows=retireIncompleteSyncTails(oldRows,coverage,batchSize);
        if(rows.some((row,i)=>row!==oldRows[i])){
          await appScope.workspace.write('summary-batches',rows);op.check();
          const byId=new Map(rows.map(row=>[row.id,row]));
          appScope.state.batches=appScope.state.batches.map(row=>byId.get(row.id)?.retiredReason==='sync_incomplete_tail'?{...row,status:'deleted',retiredReason:'sync_incomplete_tail'}:row);appScope.notify();
        }
      }
      const missing=missingOnly?missingSummaryRanges(coverage,batchSize,{fullBatchesOnly}):null;
      let ranges=missingOnly?missing.map(r=>({...r,startIndex:Math.max(r.startIndex,startIndex??r.startIndex),endIndex:Math.min(r.endIndex,endIndex??r.endIndex)})).filter(r=>r.startIndex<=r.endIndex):planSummaryRanges({count:count??appScope.core.settings.messageCount,startIndex,endIndex,lastIndex,batchSize});
      if(!ranges.length){appScope.summaryFeedback('success','当前可处理楼层没有缺口；没有调用总结模型。',trigger);return {status:'complete',batches:0};}
      let groupId=makeId('summary-group');
      const list=await appScope.workspace.read('summary-batches',[]);
      let previous=replaceBatchId?list.find(b=>b.id===replaceBatchId):null;
      if(replaceBatchId&&!previous)throw new Error('总结批次不存在');
      if(previous&&ranges.length!==1)throw new Error('重生保留原批次范围');
      if(list.some(b=>b.replacement&&b.status!=='deleted'&&b.status!=='saved'&&b.replacement.id!==previous?.replacement?.id&&ranges.some(r=>b.startIndex<=r.endIndex&&b.endIndex>=r.startIndex)))throw new Error('所选范围已有未完成覆盖候选。请展开本页“总结批次”，勾选后“重试所选”；要重建则“删除所选”候选，旧正式记忆保留。');
      let overwrite=null;
      if(!missingOnly&&!replaceBatchId){
        overwrite=summaryOverwritePlan(ranges,list,batchSize,lastIndex,{truncateTail:trigger==='manual'});
        if(previewHash&&previewHash!==appScope.overwriteHash(overwrite))throw new Error('总结覆盖范围已变化，请重新确认预览');
        if(list.some(b=>b.replacement&&b.status!=='deleted'&&b.status!=='saved'&&b.startIndex<=overwrite.endIndex&&b.endIndex>=overwrite.startIndex))throw new Error('所选范围已有未完成覆盖候选。请展开本页“总结批次”，勾选后“重试所选”；要重建则“删除所选”候选，旧正式记忆保留。');
        ranges=overwrite.ranges;
      }
      if((resume||rebuildCandidate)&&previous?.groupId)groupId=previous.groupId;
      const plan=(resume||rebuildCandidate)&&previous?.plan?previous.plan:{startIndex:ranges[0].startIndex,endIndex:ranges.at(-1).endIndex,batchSize};
      let planned=ranges.map((range,i)=>{
        const prior=previous??(overwrite?.grouped?null:list.find(b=>sameBatchRange(b,range)));
        return {...prior,id:prior?.id??makeId('summary-batch'),number:prior?.number??Math.max(0,...list.map(b=>b.number??0))+i+1,groupId,plan,...range,focus,trigger,status:'queued',freshStart:resume&&prior?.status!=='saved'&&prior?.status!=='deleted'?prior?.freshStart??!prior?.operationId:true,operationId:prior?.operationId??null,createdAt:prior?.createdAt??Date.now(),attempts:prior?.attempts??[]};
      });
      const replacement=((resume||rebuildCandidate)?previous?.replacement:null)??(overwrite?.grouped?{id:groupId,memberIds:planned.map(p=>p.id),oldIds:overwrite.affected.map(b=>b.id),oldOperations:[...new Set(overwrite.affected.flatMap(batchOperationIds))],affected:overwrite.affected.map(({id,startIndex,endIndex})=>({id,startIndex,endIndex})),recipeHash:appScope.summaryRecipeHash(),requested:overwrite.requested,discardedTail:overwrite.discardedTail}:null);
      if(replacement&&!resume&&!rebuildCandidate){
        const view=await appScope.core.readMemoryView();op.check();
        replacement.recordIds=[...new Set(replacement.oldOperations.flatMap(id=>Object.values(batchRecords(view.records.history,id)).flat().map(r=>r.id)))];
        replacement.editsHash=appScope.replacementEditsHash(replacement.recordIds,view.controls);
      }
      if(!resume)planned=planned.map(p=>({...p,replacement:null,replacementReady:false,replacedBy:null,splitInto:null,retiredReason:null}));
      if(replacement)planned=planned.map(p=>({...p,replacement,replacementReady:resume?Boolean(p.replacementReady):false}));
      if(overwrite)planned=planned.map(p=>({...p,excludeOperations:overwrite.excludeOperations}));
      appScope.summaryMonitor(op,{totalBatches:planned.length});
      // Atomic replacement groups require the full candidate manifest. Ordinary
      // sync/manual work persists only the batch it is about to execute.
      if(replacement){
        const planById=new Map(planned.map(p=>[p.id,p]));
        await appScope.workspace.write('summary-batches',[...list.map(b=>planById.get(b.id)??b),...planned.filter(p=>!list.some(b=>b.id===p.id))]);op.check();
      }
      appScope.runtimeLog.record({run:diagnosticRun,task:'summary',phase:'queue_plan',details:{trigger,startIndex:plan.startIndex,endIndex:plan.endIndex,batchSize:plan.batchSize,plannedBatches:planned.length}});
      for(let i=0;i<planned.length;i++){
        remainingPlanned=planned.length-i-1;
        op.check();const item=planned[i],continuing=resume&&!item.freshStart&&Boolean(item.operationId),operationId=continuing?item.operationId:makeId('product-summary');
        const oldOperation=item.status==='deleted'?null:savedBatchOperation(item);
        currentBatch={...item,status:'running',freshStart:!continuing,error:null,operationId,autoIndex:Boolean(appScope.core.settings.vectorEnabled),previousOperation:oldOperation??null,attempts:batchOperationIds(item).filter(id=>id!==operationId),updatedAt:Date.now()};
        appScope.activeSummaryBatchId=item.id;
        await appScope.workspace.update('summary-batches',rows=>rows.some(b=>b.id===item.id)?rows.map(b=>b.id===item.id?currentBatch:b):[...rows,currentBatch],[]);op.check();
        // Staged generations survive crashes but are never available for recall.
        if(!continuing)await appScope.core.updateMemoryControls({operations:{[operationId]:'pending'}});op.check();
        const range=await appScope.core.readRange({startIndex:item.startIndex,endIndex:item.endIndex});
        op.check();if(range.status!=='ready')throw Object.assign(new Error((appScope.core.readViewState?.()??appScope.core.state).errorMessage??'范围读取失败'),{code:range.errorCode??'HISTORY_UNAVAILABLE',details:range.errorDetails});
        await appScope.readBatches(await appScope.core.readMemoryView());
        const displayNumber=numberedSummaryBatches(appScope.state.batches).find(b=>b.id===item.id)?.displayNumber??i+1;
        appScope.state.progress=`第 ${i+1}/${planned.length} 批 · 已读取 #${item.startIndex}–${item.endIndex}，共 ${range.count} 楼`;
        appScope.runtimeLog.record({run:diagnosticRun,task:'summary',phase:'range',details:{batchNumber:displayNumber,startIndex:item.startIndex,endIndex:item.endIndex,sourceCount:range.count,...range.readStats}});
        appScope.summaryFeedback('running',`正在总结 ${appScope.state.progress}`,trigger);
        currentBatch={...currentBatch,freshStart:false};
        await appScope.workspace.update('summary-batches',rows=>rows.map(b=>b.id===item.id?currentBatch:b),[]);op.check();
        const result=await appScope.core.startSummary({focus,confirmedFocus:true,trigger,operationId,resume:continuing,excludeOperations:[...currentBatch.attempts,...(currentBatch.excludeOperations??[])],requireFloorSummaries:true,allowInvalidToolRetry,onDiagnostic:event=>{
          // A settings edit during the request applies to future work. It must
          // not append another paid review/merge after a two-pass generation.
          usedVerification ||= event.details.purpose==='summary_verification';
          if(event.phase==='request'&&event.level==='info')firstRequestAt??=Date.now();
          if(event.phase==='wait_complete')modelMs+=event.details.modelMs??0;
          appScope.runtimeLog.record({run:diagnosticRun,task:'summary',...event,details:{...event.details,batchNumber:displayNumber}});
          if(op.token!==appScope.epoch||op.signal.aborted)return;
          const phase=event.phase==='commit'?'saving':['response','normalize','character_details','floors','validate','repair_complete'].includes(event.phase)?'validating':event.phase==='retry_wait'?'waiting':event.phase==='request'&&event.level==='info'?'composing':null;
          if(phase)appScope.summaryMonitor(op,{phase,...(Number.isSafeInteger(event.details.requestNumber)?{requestNumber:event.details.requestNumber}:{})});
          if(event.phase==='plan')appScope.summaryFeedback('running',`第 ${i+1}/${planned.length} 批 · ${event.details.plannedRequests===0?'已复用完成进度，无需模型请求':event.details.plannedRequests===1?'本批一次总结请求':`本批预计 ${event.details.plannedRequests} 次请求（${appScope.core.settings.summaryReviewEnabled?'主总结＋原文复核':appScope.core.settings.summaryStaged?'已开启分工':'输入预算或续跑计划'}）`} · 后台处理，可继续聊天`,trigger);
          if(event.phase==='request'&&event.level==='info'){
            const repairing=['enum_repair','reference_repair','floor_repair','category_repair'].includes(event.details.purpose);
            const action=event.details.purpose==='summary_verification'?'正在对照原文补漏纠错':repairing?(event.details.purpose==='enum_repair'?'正在自动纠正字段':'正在补全缺失内容'):'正在总结';
            appScope.summaryFeedback('running',`${action} · 第 ${i+1}/${planned.length} 批 · #${event.details.startIndex}–${event.details.endIndex} · 本批第 ${event.details.requestNumber} 次请求${event.details.recoveryCalls?'（恢复重试）':''}${repairing?'，无需重做整批总结':''}`,trigger);
          }
          if(event.phase==='records_skipped'){skippedRecords+=event.details.skippedRecords??0;skippedLinks+=event.details.skippedLinks??0;appScope.summaryFeedback('warning',`${skippedRecords?`已跳过 ${skippedRecords} 条无效明细。`:''}${skippedLinks?`已忽略 ${skippedLinks} 处无效事件关联，正文保留。`:''}正在继续校验，尚未确认保存；详情见运行日志。`,trigger);}
          if(event.phase==='records_deferred'){deferredRecords+=event.details.deferredRecords??0;appScope.summaryFeedback('warning','个别记忆待核对，暂不注入；其余内容正常保存，稍后可在内容校对中单独处理。',trigger);}
          if(event.phase==='repair_request')appScope.summaryFeedback('running',`正在自动纠正 ${event.details.repairFields} 个字段 · #${item.startIndex}–${item.endIndex}，无需重做整批总结`,trigger);
          if(event.phase==='repair_complete')appScope.summaryFeedback('running',`字段纠错通过，正在保存 #${item.startIndex}–${item.endIndex}`,trigger);
          if(event.phase==='partial_repair')appScope.summaryFeedback(event.details.purpose==='summary_verification'?'warning':'running',event.details.purpose==='summary_verification'?`已缓存 ${event.details.accepted??0} 项复核改动，${event.details.rejected??0} 项待修复；本批尚未发布到记忆`:`正在补齐缺失内容 · #${item.startIndex}–${item.endIndex}，不重做整批总结`,trigger);
          if(event.phase==='resume_response')appScope.summaryFeedback('running',`已读取上次模型结果 · #${item.startIndex}–${item.endIndex}，继续校验和保存`,trigger);
          if(event.phase==='resume_commit')appScope.summaryFeedback('running',`已确认上次提交成功，跳过这部分模型请求`,trigger);
          if(event.phase==='recovery_compact')appScope.summaryFeedback('running',`接口响应异常，正在压缩无关历史后重试 · #${item.startIndex}–${item.endIndex}`,trigger);
          if(event.phase==='retry_wait')appScope.summaryFeedback('running',`接口暂时异常，${Math.max(1,Math.ceil(event.details.retryDelayMs/1000))} 秒后重试当前片段；已保存内容不重做`,trigger);
        }});
        op.check();if(result.status!=='saved')throw Object.assign(new Error((appScope.core.readViewState?.()??appScope.core.state).errorMessage??'总结未保存'),{code:result.failure?.code??result.errorCode??'SUMMARY_RESPONSE_ERROR',details:result.errorDetails});
        if(result.partialSummary&&(currentBatch.replacement||oldOperation&&oldOperation!==operationId))throw Object.assign(new Error('覆盖候选只有部分有效内容，尚未替换旧正式记忆；可从失败缓存查看。'),{code:'COVERAGE_INCOMPLETE'});
        const publishingAt=Date.now();let publishedView=null;
        if(currentBatch.replacement){
          currentBatch={...currentBatch,status:'queued',replacementReady:true,sourceRevision:range.sourceRevision,requests:result.requests,updatedAt:Date.now()};
          // This checkpoint is required: no old operation is retired before
          // every replacement member has a durable, source-verified result.
          await appScope.workspace.update('summary-batches',rows=>rows.map(b=>b.id===item.id?currentBatch:b),[]);op.check();
          stagedOnly=!await publishSummaryReplacement(currentBatch.replacement,op);
        }else{
          const applied=await appScope.core.updateMemoryControls({operations:{...Object.fromEntries(currentBatch.attempts.map(id=>[id,'deleted'])),[operationId]:'active'}},{returnView:'deferred'});op.check();
          publishedView=applied?.memoryView;
          currentBatch={...currentBatch,status:'saved',savedOperationId:operationId,partialSummary:result.partialSummary??null,requests:result.requests,updatedAt:Date.now()};
          await appScope.workspace.update('summary-batches',rows=>rows.map(b=>b.id===item.id?currentBatch:b),[]).catch(error=>{bookkeepingWarning=true;appScope.runtimeLog.record({run:diagnosticRun,task:'summary',phase:'checkpoint_warning',level:'warning',details:{...errorDiagnostics(error),storageArtifact:'checkpoint'}});});
        }
        saved++;appScope.summaryMonitor(op,{phase:'saving',completedBatches:saved});if(!stagedOnly)appScope.state.savedThrough=Math.max(appScope.state.savedThrough,item.endIndex);appScope.state.stale=false;
        await appScope.workspace.write('ui',{savedThrough:appScope.state.savedThrough}).catch(error=>{bookkeepingWarning=true;void appScope.reportError(error,{task:'storage',stage:'storage'});});await appScope.refresh({summaryCommit:true,view:publishedView});currentBatch=null;
        // Use the refreshed committed batches, not the pre-request running row.
        try{await appScope.syncAutoStartFloor(diagnosticRun);}catch(error){void appScope.reportError(error,{task:'summary',stage:'background'});}
        publishMs+=Date.now()-publishingAt;
        if(result.partialSummary){partialSummary=result.partialSummary;break;}
        if(!result.currentOnly&&appScope.core.settings.autoQualityEnabled&&!usedVerification&&!appScope.core.settings.summaryReviewEnabled){
          const batch=appScope.state.batches.find(b=>b.operationId===operationId),ids=MEMORY_CATEGORIES.flatMap(k=>batch?.records?.[k]??[]).map(r=>r.id);
          const risks=new Set(qualityTargets(appScope.state.rawRecords,appScope.qualitySaved).map(r=>r.id));
          automaticQualityIds.push(...ids.filter(id=>risks.has(id)));
        }
        // op.finish() wakes the bounded vector queue after releasing the
        // summary lock. The batch's durable autoIndex marker survives reloads.
      }
      if(stagedOnly){appScope.summaryFeedback('info','覆盖候选已保存，旧记忆仍在使用；请继续未完成批次，整组成功后替换。',trigger);return {status:'staged',batches:saved};}
      if(partialSummary){
        appScope.summaryFeedback('warning',`部分已保存：${partialSummary.savedFloors.length} 楼摘要及通过校验的明细已入库，${partialSummary.missingFloors.length} 楼未保存。本轮已停止；未保存楼层可在批次详情查看并用手动更新补建。`,trigger);
        return {status:'saved',batches:saved,partialSummary,level:'warning',timings:{prepareMs:(firstRequestAt??Date.now())-taskStarted,modelMs,publishMs}};
      }
      // Event decisions were finalized by the committed memory refresh.
      if(automaticQualityIds.length)appScope.queueAutomaticQuality(automaticQualityIds);
      if(op.token===appScope.epoch)appScope.summaryFeedback(bookkeepingWarning||deferredRecords||skippedRecords||skippedLinks?'warning':'success',`总结成功并已保存：#${ranges[0].startIndex}–${ranges.at(-1).endIndex}，共 ${saved} 批。${skippedRecords?`已跳过 ${skippedRecords} 条无效明细，未写入正式记忆；详情见运行日志。`:''}${skippedLinks?`已忽略 ${skippedLinks} 处无效事件关联，摘要正文已保留。`:''}${deferredRecords?`${deferredRecords} 条记忆待核对，暂不注入；可在记忆 → 内容校对中单独修正。`:''}${bookkeepingWarning?'批次进度资料待恢复，记忆正文已确认保存，无需重新生成。':''}`,trigger);
      return {status:'saved',batches:saved,level:bookkeepingWarning||deferredRecords||skippedRecords||skippedLinks?'warning':'success',timings:{prepareMs:(firstRequestAt??Date.now())-taskStarted,modelMs,publishMs}};
    }catch(error){
      // Report the API failure before potentially slow native bookkeeping.
      // The final log also carries the durable logical-batch count, not just
      // a model/validation success or a commit-start marker.
      error.details={...error.details,savedBatches:saved,pendingBatches:remainingPlanned,modelMs,publishMs,
        ...(currentBatch?{startIndex:currentBatch.startIndex,endIndex:currentBatch.endIndex}:{})};
      if(op.token===appScope.epoch&&appScope.activeSummaryOperation===op)appScope.summaryFeedback(op.signal.aborted?'info':'error',`${op.signal.aborted?'总结已停止':'总结未完成'}；已保存 ${saved} 批。${failureText(error)}`,trigger);
      if(currentBatch&&appScope.workspace?.isCurrent()&&op.token===appScope.epoch&&appScope.activeSummaryOperation===op){
        const failed={...currentBatch,status:op.signal.aborted?'interrupted':'failed',error:failureText(error)};
        appScope.state.batches=appScope.state.batches.map(b=>b.id===failed.id&&b.operationId===failed.operationId?{...b,status:failed.status,error:failed.error}:b);
        appScope.summaryFeedback(op.signal.aborted?'info':'error',failed.error,trigger);
        await appScope.workspace.update('summary-batches',rows=>rows.map(b=>b.id===failed.id&&b.operationId===failed.operationId&&b.status==='running'?failed:b),[]).catch(()=>{});
        // Persist the forward cursor, but do not dispatch another batch here.
        if(!op.signal.aborted)await appScope.syncAutoStartFloor(diagnosticRun,{check:op.check});
        // A rejected provider request has no newly activated memory. Avoid a
        // full archive/source scan solely to display its failed batch status.
        if(!['request','read_body','parse_envelope','parse_content'].includes(error.details?.stage))await appScope.refresh().catch(()=>{});
      }
      appScope.runtimeLog.record({run:diagnosticRun,task:'summary',phase:'queue_remaining',details:{savedBatches:saved,pendingBatches:remainingPlanned}});
      if(op.token===appScope.epoch&&appScope.activeSummaryOperation===op)appScope.summaryFeedback(op.signal.aborted?'info':'error',`${op.signal.aborted?'总结已停止':'总结未完成'}；已保存 ${saved} 批${remainingPlanned?`，另有 ${remainingPlanned} 批尚未开始` :''}。${failureText(error)}`,trigger);
      throw error;
    }finally{if(appScope.activeSummaryOperation===op){appScope.activeSummaryOperation=null;appScope.activeSummaryBatchId=null;}op.finish();}
  }

async function regenerateBatch(id,{trigger='manual',check:parentCheck}={}){
    const check=appScope.continuationCheck(parentCheck);check();const rows=await appScope.workspace.read('summary-batches',[]);check();const row=rows.find(b=>b.id===id);
    if(!row)throw new Error('批次不存在');
    if(row.replacedBy||row.status==='deleted'&&rows.some(b=>b.id!==row.id&&b.status==='saved'&&b.startIndex<=row.endIndex&&b.endIndex>=row.startIndex))throw new Error('旧批次已被范围覆盖，请从手动总结选择需要重新覆盖的范围');
    if(!Number.isInteger(row.startIndex)||!Number.isInteger(row.endIndex))throw new Error('旧版未保存楼层范围，请在手动总结中指定范围重新整理');
    check();
    return summarize({startIndex:row.startIndex,endIndex:row.endIndex,batchSize:row.endIndex-row.startIndex+1,focus:row.focus,replaceBatchId:id,trigger,rebuildCandidate:Boolean(row.replacement&&row.status!=='saved'&&row.status!=='deleted')});
  }

async function retryBatch(id,{check:parentCheck,explicit=true}={}){
    const check=appScope.continuationCheck(parentCheck);check();
    // A stale retry button can be clicked again before the busy UI paints.
    // Keep the current operation (and its progress) intact; never start a twin.
    // The skip stays silent to the caller but tells the user why nothing ran.
    if(appScope.active||appScope.opening){appScope.summaryFeedback('info','已有总结任务正在运行；本批重试已跳过，当前任务结束后可再试。','manual');return {status:'running',requests:0,level:'warning'};}
    await appScope.refresh({check});check();const row=appScope.state.batches.find(b=>b.id===id);
    if(appScope.active||appScope.opening){appScope.summaryFeedback('info','已有总结任务正在运行；本批重试已跳过，当前任务结束后可再试。','manual');return {status:'running',requests:0,level:'warning'};}
    if(!row)throw new Error('批次不存在');
    if(row.status==='saved'){appScope.summaryFeedback('info','该批总结已保存，无需重复总结；索引未完成时可单独补建。','manual');return {status:'saved',requests:0};}
    if(!['failed','interrupted','queued'].includes(row.status))throw new Error('此批次当前不能续跑');
    if(canRetryInParallel(row)){
      const options={retryBatchIds:[row.id],parallelConcurrency:1};
      const preview=await previewSummary(options);check();
      if(!preview.plannedBatches)return {status:'saved',requests:0};
      return summarize({...options,previewHash:preview.previewHash});
    }
    if(!row.replacementReady&&!row.freshStart&&row.operationId&&appScope.core.inspectSummaryResume){
      const recovery=await appScope.core.inspectSummaryResume(row.operationId,{focus:row.focus});check();
      if((!recovery.frozen||recovery.revisionChanged)&&!recovery.hasCachedResponse&&!recovery.hasCommittedChildren){
        appScope.summaryFeedback('info','其它批次已保存，本批尚无可复用的成功答复；正在单独重试此批，已成功批次保留。','manual');
        return regenerateBatch(id,{trigger:row.trigger??'manual',check});
      }
    }
    if(row.replacementReady&&row.replacement){
      // Reuse the successful candidate with no model call. The original
      // formal results remain active while any required member is missing.
      const op=appScope.begin();try{const applied=await publishSummaryReplacement(row.replacement,op);check();await appScope.refresh({check});check();return {status:applied?'saved':'staged',requests:0};}finally{op.finish();}
    }
    check();
    return summarize({startIndex:row.startIndex,endIndex:row.endIndex,batchSize:row.endIndex-row.startIndex+1,focus:row.focus,replaceBatchId:id,resume:true,trigger:row.trigger??'manual',allowInvalidToolRetry:explicit});
  }

async function retryIncompleteBatches(){
    await prepareSummaryChat();await appScope.refresh();const ids=appScope.state.batches.filter(b=>['failed','interrupted','queued'].includes(b.status)).map(b=>b.id);
    if(!ids.length){const message='没有未完成的总结批次；如需补建向量，请点击“补建全部未完成索引”，不会重新总结。';appScope.summaryFeedback('info',message,'manual');return {status:'idle',processed:0,failed:0,message,level:'info'};}
    return manageBatches(ids,'retry');
  }

async function splitSummaryBatch(id,{batchSize}={}){
    appScope.assertCurrent();if(appScope.active||appScope.opening)throw new Error('请先停止总结');
    const op=appScope.begin();
    try{
      const rows=await op.workspace.read('summary-batches',[]);op.check();
      const row=rows.find(b=>b.id===id);
      if(!row||!['failed','interrupted','queued'].includes(row.status)||row.replacementReady)throw new Error('只能拆分未完成的总结批次；已完成结果无需重做');
      const length=row.endIndex-row.startIndex+1;
      if(!Number.isSafeInteger(row.startIndex)||!Number.isSafeInteger(row.endIndex)||length<=1)throw new Error('此批次只有一楼或没有范围，不能继续按楼层拆分');
      batchSize??=Math.ceil(length/2);
      if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>=length||batchSize>200)throw new Error('拆分后每批楼数应小于当前批次，且为1–200的整数');
      const ranges=planSummaryRanges({startIndex:row.startIndex,endIndex:row.endIndex,batchSize,lastIndex:await appScope.core.historyTail()});op.check();
      const children=ranges.map((range,index)=>({...row,...range,id:makeId('summary-batch'),number:Math.max(0,...rows.map(b=>b.number??0))+index+1,status:'queued',operationId:null,savedOperationId:null,previousOperation:null,attempts:[],freshStart:true,replacementReady:false,error:null,requests:undefined,sourceRevision:undefined,splitFrom:id,updatedAt:Date.now()}));
      let replacement=row.replacement;
      // A failed regeneration may still have a live former generation. Its
      // smaller children form one atomic replacement of that old range.
      const oldOperation=savedBatchOperation(row);
      if(!replacement&&oldOperation){
        const view=await appScope.core.readMemoryView();op.check();
        const oldOperations=batchOperationIds(row),recordIds=[...new Set(Object.values(batchRecords(view.records.history,oldOperation)).flat().map(r=>r.id))];
        replacement={id:makeId('summary-group'),memberIds:[id],oldIds:[id],oldOperations,affected:[row],recipeHash:appScope.summaryRecipeHash(),requested:{startIndex:row.startIndex,endIndex:row.endIndex},discardedTail:null,recordIds,editsHash:appScope.replacementEditsHash(recordIds,view.controls)};
      }
      if(replacement){
        replacement={...replacement,memberIds:replacement.memberIds.flatMap(member=>member===id?children.map(c=>c.id):[member])};
        for(const child of children){child.replacement=replacement;child.groupId=replacement.id;child.excludeOperations=[...new Set([...(row.excludeOperations??[]),...(replacement.oldOperations??[])])];}
      }
      const deletedOperations=Object.fromEntries(batchOperationIds(row).filter(operation=>operation!==oldOperation).map(operation=>[operation,'deleted']));
      if(Object.keys(deletedOperations).length)await appScope.core.updateMemoryControls({operations:deletedOperations});op.check();
      const next=rows.map(b=>b.id===id?{...b,status:'deleted',splitInto:children.map(c=>c.id),updatedAt:Date.now()}:replacement&&b.replacement?.id===replacement.id?{...b,replacement}:b);
      await op.workspace.write('summary-batches',[...next,...children]);op.check();await appScope.refresh();
      appScope.summaryFeedback('info',`已把 ${row.startIndex}–${row.endIndex} 楼拆为 ${children.length} 批；其它批次和已完成结果保留，选择后可单独重试。`,'manual');
      return {status:'queued',ids:children.map(c=>c.id),plannedBatches:children.length,requests:0,diagnostics:{reason:'summary_batch_split',startIndex:row.startIndex,endIndex:row.endIndex,plannedBatches:children.length,modelRequested:false}};
    }finally{op.finish();}
  }

async function summaryPrefixPreview(id){
    const rows=await appScope.workspace.read('summary-batches',[]),row=rows.find(b=>b.id===id);
    if(!row?.replacement||row.savedOperationId||row.status==='saved')throw new Error('请选择尚未应用的覆盖候选；普通成功批次已经保存');
    const replacement=row.replacement,members=replacement.memberIds.map(member=>rows.find(b=>b.id===member));
    if(members.some(b=>!b))throw new Error('覆盖计划成员缺失，请先恢复或重新建立所选批次');
    const ordered=[...members].sort((a,b)=>a.startIndex-b.startIndex),ready=[];
    let next=ordered[0].startIndex;
    for(const candidate of ordered){
      if(candidate.startIndex!==next||!candidate.replacementReady||!candidate.operationId||candidate.status==='deleted')break;
      ready.push(candidate);next=candidate.endIndex+1;
    }
    if(!ready.length)throw new Error('计划最前一批尚未成功，请先重试或拆小该批；没有撤下旧记忆');
    const startIndex=ready[0].startIndex,endIndex=ready.at(-1).endIndex,memberIds=ready.map(b=>b.id),canceledIds=members.filter(b=>!memberIds.includes(b.id)).map(b=>b.id);
    const oldThrough=Math.max(endIndex,...(replacement.affected??[]).map(b=>b.endIndex));
    const plannedThrough=Math.max(endIndex,...members.map(b=>b.endIndex));
    const discardedTail=oldThrough>endIndex?{startIndex:endIndex+1,endIndex:oldThrough}:null;
    const unappliedRange=plannedThrough>endIndex?{startIndex:endIndex+1,endIndex:plannedThrough}:null;
    const previewHash=sha256([replacement,ordered.map(b=>[b.id,b.startIndex,b.endIndex,b.status,b.operationId,b.replacementReady,b.sourceRevision]),memberIds,endIndex]);
    return {groupId:replacement.id,startIndex,endIndex,discardedTail,unappliedRange,readyBatches:ready.length,pendingBatches:canceledIds.length,previewHash,memberIds,canceledIds,replacement};
  }

async function previewApplySummaryPrefix(id){
    appScope.assertCurrent();if(appScope.active||appScope.opening)throw new Error('请先停止总结');
    const {memberIds,canceledIds,replacement,...preview}=await summaryPrefixPreview(id);return preview;
  }

async function applySummaryPrefix(id,{previewHash}={}){
    appScope.assertCurrent();if(appScope.active||appScope.opening)throw new Error('请先停止总结');
    const op=appScope.begin();
    try{
      const preview=await summaryPrefixPreview(id);op.check();
      if(!previewHash||previewHash!==preview.previewHash)throw new Error('已完成范围发生变化，请重新查看并确认应用范围');
      const replacement={...preview.replacement,memberIds:preview.memberIds,canceledIds:preview.canceledIds,requested:{...preview.replacement.requested,endIndex:preview.endIndex},discardedTail:preview.discardedTail,explicitCutoff:true};
      if(!await publishSummaryReplacement(replacement,op))throw new Error('已完成候选状态变化，没有应用覆盖');
      await appScope.refresh({summaryCommit:true});
      appScope.summaryFeedback('success',`已应用 ${preview.startIndex}–${preview.endIndex} 楼的 ${preview.readyBatches} 批，取消剩余 ${preview.pendingBatches} 批；旧结果保留可追溯归档，本聊天自动接续已暂停。`,'manual');
      return {status:'saved',batches:preview.readyBatches,requests:0,endIndex:preview.endIndex,diagnostics:{reason:'summary_prefix_applied',startIndex:preview.startIndex,endIndex:preview.endIndex,savedBatches:preview.readyBatches,pendingBatches:preview.pendingBatches,archived:true,modelRequested:false}};
    }finally{op.finish();}
  }

async function manageBatches(ids,action,options={}){
    appScope.assertCurrent();if(appScope.active)throw new Error('请先停止总结');
    if(!['delete','restore'].includes(action))return manageBatchesTask(ids,action,options,appScope.continuationCheck());
    const op=appScope.begin();
    appScope.setMessage(`${action==='delete'?'正在撤下':'正在恢复'}所选批次；等待存储确认，可停止等待`);
    try{return await runStorageOperation(check=>manageBatchesTask(ids,action,options,check),{check:op.check,signal:op.signal,waitMs:30000,storageArtifact:'memory'});}
    catch(error){
      if(error?.details?.operationPending){
        const text=error.code==='CANCELED'?'已停止等待存储；本次操作尚未全部确认，已完成的步骤保留，可稍后刷新重试':'存储未响应，本次操作尚未全部确认；已完成的步骤保留，可稍后刷新重试';
        appScope.setMessage(text);appScope.state.feedback={id:++appScope.feedbackSequence,level:'warning',text};appScope.notify();
      }
      throw error;
    }finally{op.finish();}
  }

async function manageBatchesTask(ids,action,options,check){
    check();let selected=[...new Set(ids)];const rows=await appScope.workspace.read('summary-batches',[],{check});check();
    if(action==='delete'||action==='restore'){
      // U237: 人设连续性需要时，显式 cascade=true 才级联——保持默认单批删除语义不变。
      // 任何被删的 saved 批次，后续所有 saved 批次一起删（按 startIndex 排序）。
      // 失败的批次保留，方便用户重试；进行中的新批次保留。
      if(action==='delete'&&options.cascade===true){
        const deletedStarts=rows.filter(b=>selected.includes(b.id)&&b.status==='saved'&&Number.isInteger(b.startIndex)).map(b=>b.startIndex);
        if(deletedStarts.length){
          const minStart=Math.min(...deletedStarts);
          const cascaded=rows.filter(b=>b.status==='saved'&&Number.isInteger(b.startIndex)&&b.startIndex>minStart);
          if(cascaded.length)selected=[...new Set([...selected,...cascaded.map(b=>b.id)])];
        }
      }
    }
    const targets=selected.map(id=>rows.find(b=>b.id===id));
    if(!targets.length||targets.some(b=>!b))throw new Error('请选择仍存在的批次');
    const directCount=ids.length;
    const cascadedCount=selected.length-directCount;
    const token=appScope.epoch,version=appScope.cancelVersion;
    if(action==='regenerate'||action==='retry'){
      if(targets.some(b=>!Number.isInteger(b.startIndex)||!Number.isInteger(b.endIndex)))throw new Error('所选旧批次没有楼层范围，请取消选择');
      if(action==='retry'&&targets.some(canRetryInParallel)&&targets.every(b=>b.status==='saved'||canRetryInParallel(b))){
        const request={retryBatchIds:selected,parallelConcurrency:options.parallelConcurrency??2};
        const preview=await previewSummary(request);check();
        if(!preview.plannedBatches)return {processed:0,failed:0,requests:0};
        const result=await summarize({...request,previewHash:preview.previewHash});
        return {...result,processed:result.batches,failed:result.failed??0};
      }
      let failed=0,processed=0;
      for(const row of targets.sort((a,b)=>a.startIndex-b.startIndex)){
        appScope.assertCurrent(token);if(version!==appScope.cancelVersion)throw new Error('已停止');
        try{await (action==='retry'?retryBatch(row.id):regenerateBatch(row.id));processed++;}
        catch(error){if(action!=='retry'||version!==appScope.cancelVersion||['CANCELED','CHAT_CHANGED','SOURCE_INVALIDATED'].includes(error.code))throw error;failed++;}
      }
      await appScope.refresh();const pending=action==='retry'?appScope.state.batches.filter(b=>selected.includes(b.id)&&!['saved','deleted'].includes(b.status)).length:0;
      const text=action==='retry'?`续跑已结束：已处理 ${processed} 批，${failed} 批失败，${pending} 批尚未应用；覆盖候选可继续所选，或明确应用已完成前段。`:`已重新生成 ${targets.length} 批`;
      appScope.setMessage(text);appScope.state.feedback={id:++appScope.feedbackSequence,level:failed||pending?'warning':'success',text};appScope.notify();return {processed,failed};
    }
    if(!['delete','restore'].includes(action))throw new Error('未知批量操作');
    const operations={};
    // Empty queued/failed attempts have no formal records to reproject.
    const beforeView=action==='delete'?await appScope.core.readMemoryView({check}):null;check();
    const affectedOps=new Set(targets.flatMap(batchOperationIds));
    const bookkeepingOnly=action==='delete'&&targets.every(b=>!savedBatchOperation(b)&&!b.replacementReady)&&!(beforeView.records?.history??[]).some(h=>[...affectedOps].some(id=>h.operationId===id||h.operationId?.startsWith(id+'/child-')));
    // Removing a queued member does not manufacture a completed group. It
    // can be restored to the same pending slot until that plan is explicitly
    // cut off; a split parent or an abandoned tail belongs to a closed plan.
    const restorableCandidate=row=>Boolean(row.replacement&&!row.savedOperationId&&!row.replacedBy&&!row.splitInto?.length&&!(appScope.state.summaryHold?.id===row.replacement.id&&row.endIndex>appScope.state.summaryHold.endIndex));
    if(action==='restore'){
      const view=await appScope.core.readMemoryView({check});check();
      for(const target of targets)if(!restorableCandidate(target)&&rows.some(b=>!selected.includes(b.id)&&view.controls?.operations?.[b.operationId]==='active'&&b.startIndex<=target.endIndex&&b.endIndex>=target.startIndex))throw new Error('此范围已有生效的覆盖结果，请先撤下重叠批次再恢复；没有叠加旧记忆');
    }
    for(const row of targets){
      const staged=restorableCandidate(row);
      const keep=savedBatchOperation(row)??(staged?row.operationId:null);
      if(action==='restore'&&!keep&&!staged)throw new Error('所选批次尚无结果可恢复');
      for(const id of batchOperationIds(row))operations[id]='deleted';
      if(action==='restore'&&keep)operations[keep]=staged?'pending':'active';
    }
    appScope.assertCurrent(token);check();const mutation=appScope.beginMemoryMutation();
    // Persist the pause with the same controls commit as withdrawal. Otherwise
    // releasing the last manual barrier immediately buys the deleted range again.
    // Reuse the existing chat-level hold; keep a prior explicit cutoff intact.
    const firstStart=Math.min(...targets.map(b=>b.startIndex).filter(Number.isSafeInteger));
    const hold=action==='delete'&&!appScope.state.summaryHold?{id:makeId('summary-delete-hold'),reason:'batch_deleted',endIndex:Math.max(-1,Math.min(Number.isSafeInteger(appScope.state.autoStartFloor)?appScope.state.autoStartFloor:firstStart,Number.isFinite(firstStart)?firstStart:appScope.state.autoStartFloor??1)-1)}:null;
    const applied=await appScope.trackedMemoryMutation(mutation,()=>appScope.core.updateMemoryControls({operations,...(hold?{automation:{summaryHold:hold}}:{})},{check,returnView:'deferred'}));
    if(hold)appScope.state.summaryHold=hold;
    check();
    await appScope.trackedMemoryMutation(mutation,()=>appScope.workspace.update('summary-batches',list=>list.map(row=>selected.includes(row.id)?{...row,status:action==='delete'?'deleted':restorableCandidate(row)?'queued':'saved',...(action==='restore'&&restorableCandidate(row)&&!row.replacementReady?{freshStart:true}:{}),savedOperationId:savedBatchOperation(row),operationId:action==='restore'?(savedBatchOperation(row)??row.operationId):row.operationId}:row),[],{check}));check();
    await appScope.refresh({check,view:applied?.memoryView,bookkeepingOnly});check();appScope.setMessage(action==='delete'?cascadedCount>0?`已撤下 ${directCount} 批（另有 ${cascadedCount} 批因人设连续性自动撤下）；已应用记忆可恢复，未应用候选不会进入正式记忆；聊天原文未改变`:`已撤下 ${targets.length} 批；已应用记忆可恢复，未应用候选不会进入正式记忆；聊天原文未改变`:`已恢复 ${targets.length} 批`);
    await appScope.runtimeLog.record({task:'summary',phase:'commit',level:'success',details:{reason:action==='delete'?'summary_batches_deleted':'summary_batches_restored',startIndex:Math.min(...targets.map(b=>b.startIndex)),endIndex:Math.max(...targets.map(b=>b.endIndex)),beforeBatches:rows.filter(b=>b.status!=='deleted').length,afterBatches:appScope.state.batches.filter(b=>b.status!=='deleted').length,modelRequested:false}});
    // 撤下或恢复批次都会改变真实覆盖，起算楼层跟着回到正确位置（删除的楼层重新变成待总结）。
    check();try{await appScope.syncAutoStartFloor(undefined,{check});}catch(error){check();void appScope.reportError(error,{task:'summary',stage:'auto_start_floor'});}check();
  }

async function deleteBatch(id,options={}){return manageBatches([id],'delete',options);}

async function restoreBatch(id){return manageBatches([id],'restore');}
  return Object.freeze({ prepareSummaryChat, previewSummary, summarize, regenerateBatch, retryBatch, retryIncompleteBatches, splitSummaryBatch, previewApplySummaryPrefix, applySummaryPrefix, manageBatches, deleteBatch, restoreBatch });
}
