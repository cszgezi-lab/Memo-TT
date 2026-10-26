import { failureText } from '../product-feedback.js';
import { QUALITY_STORE_KEY, qualityStatus, qualityFingerprint, validateQualityReviewPartial, projectQualityRecords, finishQualityAttempt } from '../product-memory-quality.js';
import { RETROSPECTIVE_STORE_KEY, projectRetrospectiveRecords } from '../product-memory-retrospective.js';
import { runMemoryRetrospective, undoMemoryRetrospective, retrospectiveEntries, retrospectiveState } from '../product-memory-retrospective-controller.js';
import { MERGE_STORE_KEY, mergeDecision, projectMergedCards, eventFingerprint } from '../product-event-merge.js';
import { memoryCards } from '../product-memory.js';
import { MEMORY_CATEGORIES } from '../product-batches.js';
import { buildDictionary } from '../product-dictionary.js';
import { clone, sha256, makeId, estimateUnits } from '../utils.js';
import { safeLogDetails } from '../product-runtime-log.js';
import { errorDiagnostics, diagnosticRequestId } from '../diagnostics.js';
import { shouldPauseProviderBatch } from '../provider-scheduler.js';
import { planQuality, qualityTargets, qualityRows, mergeQualityEntry } from '../product-quality-plan.js';
import { persistedProductSettings } from '../product-settings.js';
import { summaryRecord } from '../summary-context.js';
import { manualQualityFields } from '../product-memory-quality.js';
import { validateKnowledgeReview } from '../product-knowledge-review.js';
import { jsonContent, completion } from './shared.js';

/** reviews orchestration. Dependencies are limited by service-contracts.js. */
export function createReviewsService(appScope) {
function queueAutomaticQuality(ids){
    appScope.automaticQualityQueue=[...new Set([...appScope.automaticQualityQueue,...ids])];
    if(appScope.qualityJob||appScope.disposed)return;
    // Let the summary action finish and release its exclusive operation first.
    // Automatic校对 is a background follow-up, never part of the summary's
    // critical path and never allowed to make a saved batch look failed.
    appScope.qualityJob=new Promise(resolve=>setTimeout(resolve,0)).then(async()=>{
      while(appScope.automaticQualityQueue.length&&!appScope.disposed){
        while(appScope.active&&!appScope.disposed)await new Promise(resolve=>setTimeout(resolve,25));
        if(appScope.disposed)break;
        const pending=appScope.automaticQualityQueue.splice(0),op=appScope.begin(false);
        appScope.qualityOperation=op;
        try{
          const result=await processQuality(op,{recordIds:pending,automatic:true});
          if(result.paused)appScope.automaticQualityQueue.length=0;
          if(op.token===appScope.epoch&&(result.failed||result.remaining))appScope.setMessage(`总结已保存；后台校对本次解决 ${result.resolved}/${result.attempted} 条，${result.attempted-result.resolved} 条仍需确认，不会自动重复校对；${result.failed} 次请求未完成。${result.paused?'接口异常，本次校对队列已暂停；':''}可展开待确认条目人工处理或主动重试。`);
        }catch(error){
          if(!['CANCELED','CHAT_CHANGED','SOURCE_INVALIDATED'].includes(error?.code)&&!appScope.disposed){
            void appScope.reportError(error,{task:'quality',stage:'background'});
            if(op.token===appScope.epoch)appScope.setMessage(`总结已保存；后台内容校对未完成：${failureText(error)}，可稍后单独重试。`);
          }
        }finally{if(op.preempted&&op.token===appScope.epoch&&!appScope.disposed)appScope.automaticQualityQueue=[...new Set([...pending,...appScope.automaticQualityQueue])];if(appScope.qualityOperation===op)appScope.qualityOperation=null;op.finish();}
      }
    }).finally(()=>{appScope.qualityJob=null;if(appScope.automaticQualityQueue.length&&!appScope.disposed)queueAutomaticQuality([]);});
  }

function publishRetrospectiveView(){
    const base=projectQualityRecords(appScope.state.rawRecords,appScope.qualitySaved,appScope.state.memoryControls,{copyUnchanged:false});
    const dictionary=appScope.activeDictionary();
    appScope.state.records=projectRetrospectiveRecords(base,retrospectiveEntries(appScope.retrospectiveSaved),appScope.state.memoryControls,{dictionary});
    appScope.state.memoryRetrospective=retrospectiveState(appScope.retrospectiveSaved,{records:base,controls:appScope.state.memoryControls,dictionary});
    appScope.state.cards=projectMergedCards(appScope.modules.cards(memoryCards(appScope.state.records,{hidden:appScope.state.hidden,includeAwareness:true})),appScope.state.records,appScope.mergeDecisions).filter(c=>!appScope.state.hidden.includes(c.id));
    appScope.recallChanged({vectors:true});appScope.committedRecall=appScope.captureRecallSnapshot();appScope.notify();
  }

async function reviewMemoryConsistency(){
    await appScope.prepareSummaryChat();
    if(appScope.personaLaunch||appScope.state.dynamicPersona?.busy||appScope.foregroundBusy()){
      const personaBusy=Boolean(appScope.personaLaunch||appScope.state.dynamicPersona?.busy);
      throw Object.assign(new Error(personaBusy?'人物任务尚未结束，请暂停或等它完成后再复盘':'聊天回复尚未结束，请等回复完成后再复盘'),{code:'RETROSPECTIVE_BUSY',details:{stage:'ui',reason:personaBusy?'retrospective_persona_busy':'retrospective_chat_busy',modelRequested:false}});
    }
    const op=appScope.begin();appScope.retrospectiveOperation=op;
    try{return await appScope.logged('memory-retrospective',async()=>{
      const snapshot=async()=>{
        const view=await appScope.core.readMemoryView();op.check();
        const saved=await op.workspace.read(QUALITY_STORE_KEY,{});op.check();
        const accepted=new Set(MEMORY_CATEGORIES.flatMap(k=>(appScope.state.rawRecords[k]??[]).map(r=>r.id)));
        const records=Object.fromEntries(MEMORY_CATEGORIES.map(k=>[k,(view.records?.[k]??[]).filter(r=>accepted.has(r.id))]));
        const base=projectQualityRecords(records,saved,view.controls,{copyUnchanged:false}),profiles=appScope.dynamicPersona.profiles();
        return {records:base,profiles,controls:view.controls??{},revision:qualityFingerprint(view.records),dictionary:buildDictionary(memoryCards(base),{aliases:appScope.core.settings.aliases,automatic:appScope.core.settings.dictionaryEnabled,profiles})};
      };
      appScope.retrospectiveSaved=await runMemoryRetrospective({workspace:op.workspace,snapshot,client:appScope.client('summary'),settings:appScope.core.settings,readSources:rows=>appScope.core.readQualitySources(rows),check:op.check,signal:op.signal,onChange:value=>{if(op.token===appScope.epoch){appScope.state.memoryRetrospective=value;appScope.notify();}},parseResponse:r=>jsonContent(completion(r).content)});
      op.check();publishRetrospectiveView();return {diagnostics:{expected:appScope.state.memoryRetrospective.total,received:appScope.state.memoryRetrospective.scanned,accepted:appScope.state.memoryRetrospective.repaired,pendingItems:appScope.state.memoryRetrospective.unresolved}};
    });}finally{
      try{if(op.token===appScope.epoch&&op.workspace.isCurrent()){
        const saved=await op.workspace.read(RETROSPECTIVE_STORE_KEY,null);
        if(op.token===appScope.epoch){appScope.retrospectiveSaved=saved;appScope.state.memoryRetrospective=retrospectiveState(saved);publishRetrospectiveView();}
      }}finally{if(appScope.retrospectiveOperation===op)appScope.retrospectiveOperation=null;op.finish();appScope.dynamicPersona.wake();}
    }
  }

async function undoMemoryConsistency(){
    await appScope.prepareSummaryChat();const op=appScope.begin();
    try{appScope.retrospectiveSaved=await undoMemoryRetrospective({workspace:op.workspace,check:op.check});op.check();appScope.state.memoryRetrospective=retrospectiveState(appScope.retrospectiveSaved);publishRetrospectiveView();}
    finally{op.finish();}
  }

async function processMergeQueue(op,ids=null){
    await appScope.refresh();op.check();
    const jobs=(appScope.state.merges??[]).filter(j=>!ids||ids.includes(j.id));
    return {merged:jobs.filter(j=>j.status==='merged').length,failed:0,processed:jobs.length,remaining:0,paused:false};
  }

async function prepareQuality(op,recordIds=null,automatic=false){
    const started=Date.now(),run=await appScope.runtimeLog.start('quality',{});
    try{
    appScope.state.qualityProgress='正在准备校对计划，不会调用模型';appScope.notify();
    await appScope.refresh();op.check();
    const records=appScope.state.rawRecords,targetIds=new Set(qualityTargets(records,appScope.qualitySaved,recordIds,appScope.state.quality,automatic).map(r=>r.id));
    const targets=qualityRows(appScope.state.records).filter(r=>targetIds.has(r.id));
    const sources=targets.length?await appScope.core.readQualitySources(targets):[];op.check();
    const c=appScope.client('supplement');
    const plan=await planQuality({records,effectiveRecords:appScope.state.records,saved:appScope.qualitySaved,sources,settings:appScope.core.settings,model:c.profile.model,recordIds,preparedStatus:appScope.state.quality,automatic,check:op.check});op.check();
    const baseline=await appScope.core.readMemoryView();op.check();
    const value={...plan,id:makeId('quality-plan'),token:op.token,sources,targets:clone(targets),stamp:qualityFingerprint(records),baseline:qualityFingerprint(baseline.records??{}),settingsStamp:sha256(persistedProductSettings(appScope.core.settings)),savedStamp:sha256(appScope.qualitySaved)};
    const requestChars=plan.jobs.map(j=>JSON.stringify(j.payload).length);
    appScope.state.qualityPlan={id:value.id,requests:plan.jobs.length,records:plan.targetCount,sources:plan.sourceCount,blocked:plan.blocked,inputLimit:plan.inputLimit,requestChars,inputChars:requestChars.reduce((a,b)=>a+b,0)};
    appScope.state.qualityProgress='';appScope.notify();
    appScope.runtimeLog.record({run,task:'quality',phase:'plan',details:{plannedRequests:plan.jobs.length,expected:plan.targetCount,sourceCount:sources.length,inputLimit:plan.inputLimit,prepareMs:Date.now()-started}});
    appScope.runtimeLog.record({run,task:'quality',phase:'complete'});
    return value;
    }catch(error){appScope.runtimeLog.record({run,task:'quality',phase:['CANCELED','CHAT_CHANGED','SOURCE_INVALIDATED'].includes(error.code)?'canceled':'failed',level:'warning',details:{...errorDiagnostics(error),prepareMs:Date.now()-started}});throw error;}
  }

async function previewQuality(recordIds=null){
    await appScope.prepareSummaryChat();const op=appScope.begin();
    try{appScope.preparedQuality=await prepareQuality(op,recordIds);return clone(appScope.state.qualityPlan);}
    finally{appScope.state.qualityProgress='';op.finish();}
  }

async function inspectQualityRecord(id){
    appScope.assertCurrent();const token=appScope.epoch;
    const record=qualityRows(appScope.state.records).find(r=>r.id===id);if(!record)throw new Error('这条记忆已变化，请刷新');
    const sources=await appScope.core.readQualitySources([record]);appScope.assertCurrent(token);
    return {record:summaryRecord(record),expected:sha256(record),sources:sources.map(({id,index,text})=>({id,index,text}))};
  }

async function saveQualityRecord(id,{fields={},expected}={}){
    appScope.assertCurrent();if(appScope.active)throw new Error('请先停止当前任务，再保存人工校对');
    const token=appScope.epoch;await appScope.refresh();appScope.assertCurrent(token);
    const record=qualityRows(appScope.state.records).find(r=>r.id===id);
    if(!record||sha256(record)!==expected)throw new Error('这条记忆已被更新，请重新打开后修改');
    const patch=manualQualityFields(record,fields),view=await appScope.core.readMemoryView();appScope.assertCurrent(token);
    await appScope.core.updateMemoryControls({edits:{[id]:{...view.controls?.edits?.[id],...patch}}});appScope.assertCurrent(token);
    appScope.preparedQuality=null;appScope.state.qualityPlan=null;await appScope.refresh();
    await appScope.refreshVectorStatus({schedule:true});appScope.setMessage('人工校对已保存；原总结与批次保留，只更新受影响的检索内容');
  }

async function processQuality(op,{recordIds=null,automatic=false,planId=null}={}){
    let plan;
    if(planId){
      plan=appScope.preparedQuality;
      if(!plan||plan.id!==planId||plan.token!==op.token||plan.settingsStamp!==sha256(persistedProductSettings(appScope.core.settings)))throw new Error('校对计划已变化，请重新预览');
      await appScope.refresh();op.check();
      if(plan.stamp!==qualityFingerprint(appScope.state.rawRecords)||plan.savedStamp!==sha256(appScope.qualitySaved))throw new Error('记忆已变化，请重新预览校对计划');
      await appScope.core.readQualitySources(plan.targets.filter(r=>plan.jobs.some(j=>j.ids.includes(r.id))));op.check();
    }else plan=await prepareQuality(op,recordIds,automatic);
    appScope.preparedQuality=null;
    const rows=r=>MEMORY_CATEGORIES.flatMap(k=>(r[k]??[]).map(record=>({category:k,...record})));
    const raw=appScope.state.rawRecords,reviewRecords=clone(appScope.state.records),all=rows(raw),sourceMap=new Map(plan.sources.map(s=>[s.id,s])),groups=plan.jobs;
    let corrected=0,failed=0,unresolved=0,paused=false,pending=0,resolved=0,attempted=0;
    for(const job of groups){
      await new Promise(r=>setTimeout(r,0));op.check();
      const ids=job.ids,targets=all.filter(r=>ids.includes(r.id));
      if(targets.length!==ids.length)throw Object.assign(new Error('待校对记忆已变化'),{code:'SOURCE_INVALIDATED'});
      const key=sha256([...ids].sort()),anchors=job.anchors;
      const requestId=diagnosticRequestId(),run=await appScope.runtimeLog.start('quality',{expected:ids.length,requestId,requestNumber:groups.indexOf(job)+1,plannedRequests:groups.length});op.check();
      let entry;
      try{
        appScope.state.qualityProgress=`AI 校对 ${corrected+failed+1}/${groups.length} 次请求`;appScope.notify();
        const sources=job.sourceIds.map(id=>sourceMap.get(id));
        const payload=job.payload,input=JSON.parse(payload.messages[1].content),inputUnits=job.inputUnits,qualityLimit=plan.inputLimit;
        const c=appScope.client('supplement');
        appScope.runtimeLog.record({run,task:'quality',phase:'request',details:{requestId,modelRole:'supplement',inputUnits,inputLimit:qualityLimit,sourceInputUnits:estimateUnits(JSON.stringify(input.cases?.map(c=>c.sources)??input.sources)),historyInputUnits:estimateUnits(JSON.stringify(input.referenceRecords??[])),maxTokens:appScope.core.settings.outputBudgetUnits,sourceCount:sources.length,expected:ids.length}});
        const response=await c.chatCompletions(payload,{signal:op.signal,timeoutMs:appScope.core.settings.summaryDeadlineMs??appScope.core.settings.deadlineMs,requestId,onDiagnostic:e=>appScope.runtimeLog.record({run,task:'quality',...e})});op.check();
        appScope.runtimeLog.record({run,task:'quality',phase:'response',details:{finishReason:response.choices?.[0]?.finish_reason??'unknown',promptTokens:response.usage?.prompt_tokens,completionTokens:response.usage?.completion_tokens}});
        const modelOutput=jsonContent(completion(response).content);
        entry=job.knowledgeReviewContext?validateKnowledgeReview(reviewRecords,ids,sources,modelOutput,{...appScope.state.memoryControls,context:job.knowledgeReviewContext}):validateQualityReviewPartial(reviewRecords,ids,sources,modelOutput,{...appScope.state.memoryControls,evidenceCatalog:job.evidenceCatalog});
        if(entry.normalizedFields)appScope.runtimeLog.record({run,task:'quality',phase:'normalize',details:{requestId,normalizedFields:entry.normalizedFields}});
        if(entry.rejected?.length){
          appScope.runtimeLog.record({run,task:'quality',phase:'partial_repair',level:'warning',details:{requestId,accepted:entry.updates.length+entry.additions.length,rejected:entry.rejected?.length??0,qualityRejections:entry.rejected}});
        }
        // The validator reads the same accepted projection as the model.
        // Persistence still anchors each accepted row to its original version.
        entry.anchors={...anchors};
        await appScope.core.readQualitySources(plan.targets.filter(r=>ids.includes(r.id)));op.check();
        corrected++;unresolved+=entry.issues.length+(entry.rejected?.length??0);
        appScope.runtimeLog.record({run,task:'quality',phase:'validate',level:entry.issues.length||entry.rejected?.length?'warning':'success',details:{received:entry.updates.length+entry.additions.length,invalidRows:entry.issues.length,rejectedRows:entry.rejected?.length??0}});
      }catch(error){
        if(op.signal.aborted||['CANCELED','CHAT_CHANGED','SOURCE_INVALIDATED'].includes(error.code)){appScope.runtimeLog.record({run,task:'quality',phase:'canceled',level:'warning',details:errorDiagnostics(error)});throw error;}
        failed++;paused=shouldPauseProviderBatch(error);entry={status:'failed',anchors,at:Date.now(),error:failureText(error)};
        appScope.runtimeLog.record({run,task:'quality',phase:'failed',level:'error',details:errorDiagnostics(error)});
      }
      const current=await appScope.core.readMemoryView();op.check();
      if(qualityFingerprint(current.records??{})!==plan.baseline)throw Object.assign(new Error('校对期间记忆已变化，结果未应用'),{code:'SOURCE_INVALIDATED'});
      try{appScope.qualitySaved=await op.workspace.update(QUALITY_STORE_KEY,value=>{
        if(entry.status==='failed')return {...value,[`${key}-retry`]:entry};
        const next={...value,[key]:mergeQualityEntry(value[key],entry)};delete next[`${key}-retry`];next[key]=finishQualityAttempt(raw,next,key,ids,appScope.state.memoryControls);return next;
      },{});op.check();}
      catch(error){appScope.runtimeLog.record({run,task:'quality',phase:'failed',level:'error',details:{...errorDiagnostics(error),requestId}});throw error;}
      appScope.runtimeLog.record({run,task:'quality',phase:'commit',level:'success',details:{requestId}});
      appScope.runtimeLog.record({run,task:'quality',phase:'complete',level:entry.status==='failed'||entry.issues?.length||entry.rejected?.length?'warning':'success'});
      appScope.state.quality=qualityStatus(raw,appScope.qualitySaved,appScope.state.memoryControls);appScope.notify();
      if(entry.status!=='failed'){
        const outcomes=appScope.qualitySaved[key].outcomes??{};attempted+=ids.length;resolved+=ids.filter(id=>outcomes[id]?.result==='resolved').length;
        appScope.runtimeLog.record({run,task:'quality',phase:'resolution',level:ids.every(id=>outcomes[id]?.result==='resolved')?'success':'warning',details:{expected:ids.length,received:ids.filter(id=>outcomes[id]?.result==='resolved').length,deferredRecords:ids.filter(id=>outcomes[id]?.result!=='resolved').length}});
      }
      if(paused){pending=groups.length-groups.indexOf(job)-1;appScope.runtimeLog.record({run,task:'quality',phase:'service_paused',level:'warning',details:{pendingItems:pending}});break;}
    }
    appScope.state.qualityProgress='';await appScope.refresh();op.check();await appScope.runtimeLog.flush();
    const remaining=appScope.state.quality?.items?.length??0;
    return {corrected,failed,unresolved,remaining,resolved,attempted,paused,pending,blocked:plan.blocked.length,level:failed||unresolved||remaining||plan.blocked.length?'warning':'success'};
  }

async function reviewMemory({planId=null,recordIds=null}={}){
    await appScope.prepareSummaryChat();const op=appScope.begin();
    let completed=false;
    try{const result=await processQuality(op,{planId,recordIds});completed=true;const text=`本次解决 ${result.resolved}/${result.attempted} 条；${result.failed} 次请求未完成。${result.attempted-result.resolved} 条仍需确认，不会自动重复校对。${result.blocked?`${result.blocked} 项超过预算或缺少来源，未请求，可逐条人工修改。`:''}${result.paused?`接口异常，本次队列已暂停，另有 ${result.pending} 组尚未请求。`:''}原总结保留；可人工确认或显式重试待确认条目。`;appScope.state.feedback={id:++appScope.feedbackSequence,level:result.level,text};appScope.setMessage(text);return result;}
    finally{appScope.state.qualityProgress='';appScope.state.qualityPlan=null;appScope.preparedQuality=null;op.finish();if(!completed&&appScope.workspace?.isCurrent())await appScope.refresh();}
  }

async function undoQuality(){
    const op=appScope.begin();
    try{op.check();await op.workspace.write(QUALITY_STORE_KEY,{});op.check();await appScope.refresh();appScope.setMessage('已撤销自动校对，原总结和人工修改保留。');}finally{op.finish();}
  }

async function retryMerges(ids=null){
    await appScope.prepareSummaryChat();const op=appScope.begin();
    try{const result=await processMergeQueue(op,ids);const text=`本次合并 ${result.merged} 对，${result.failed} 对失败，${result.remaining} 对待处理。${result.paused?'接口异常，本次队列已暂停，可稍后重试。':''}已保存总结未重跑。`;appScope.setMessage(text);appScope.state.feedback={id:++appScope.feedbackSequence,level:result.failed?'warning':'success',text};appScope.notify();return result;}
    finally{op.finish();}
  }

async function keepMergeSeparate(id){
    appScope.assertCurrent();const op=appScope.begin();
    try{await appScope.refresh();op.check();const job=appScope.state.merges.find(j=>j.id===id);if(!job)throw new Error('合并记录已变化');
      const from=appScope.state.records.events.find(e=>e.id===id),to=appScope.state.records.events.find(e=>e.id===job.targetId);
      const decision=to?mergeDecision(appScope.state.records,job,{status:'separate',reason:'已由用户保持独立；可单独重试合并。'},job.attempts):{targetId:job.targetId,fromHash:eventFingerprint(from,appScope.state.records),status:'separate',reason:'已由用户保持独立',attempts:0};
      await op.workspace.update(MERGE_STORE_KEY,rows=>({...rows,[id]:decision}),{});op.check();await appScope.refresh();appScope.setMessage('已保持独立，原始记录完整保留。');
    }finally{op.finish();}
  }

async function chooseMergeTarget(id,targetId){
    appScope.assertCurrent();const op=appScope.begin();
    try{await appScope.refresh();op.check();const job={id,targetId};
      const decision=mergeDecision(appScope.state.records,job,{status:'pending',reason:'已改选目标。'});
      await op.workspace.update(MERGE_STORE_KEY,rows=>({...rows,[id]:decision}),{});op.check();await appScope.refresh();appScope.setMessage('事件已处理。');
    }finally{op.finish();}
  }
  return Object.freeze({ queueAutomaticQuality, reviewMemoryConsistency, undoMemoryConsistency, processMergeQueue, previewQuality, inspectQualityRecord, saveQualityRecord, reviewMemory, undoQuality, retryMerges, keepMergeSeparate, chooseMergeTarget });
}
