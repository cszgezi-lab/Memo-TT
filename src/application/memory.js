import { documentPartKey } from '../product-workspace.js';
import { mvuContext } from '../product-custom-modules.js';
import { sourceKey } from '../product-sources.js';
import { batchRecords, MEMORY_CATEGORIES, editedMemoryFields, consolidateSummaryBatches } from '../product-batches.js';
import { QUALITY_STORE_KEY, qualityStatus, qualityEntryCurrent, projectQualityRecords } from '../product-memory-quality.js';
import { RETROSPECTIVE_STORE_KEY, projectRetrospectiveRecords } from '../product-memory-retrospective.js';
import { retrospectiveEntries, retrospectiveState } from '../product-memory-retrospective-controller.js';
import { MERGE_STORE_KEY, mergeJobs, projectMergedCards } from '../product-event-merge.js';
import { memoryCards, memoryCardsAsync } from '../product-memory.js';
import { sha256, makeId, stableStringify } from '../utils.js';
import { editKeepsakePatch } from '../character-journal.js';
import { normalizeTags } from '../product-dictionary.js';
import { factSubject, factKey, factValue } from '../product-person-profiles.js';

/** memory orchestration. Dependencies are limited by service-contracts.js. */
export function createMemoryService(appScope) {
async function migrateWorkspace(){
    if(await appScope.globalWorkspace.read('legacy-imported'))return;
    // Only the chat explicitly opened by the user is eligible. Never scan chats.
    if(!appScope.state.documents.length){
      const docs=await appScope.workspace.read('documents',[]);
      for(const doc of docs){
        for(let i=0;i<doc.chunks;i++)await appScope.globalWorkspace.write(documentPartKey(doc,i),await appScope.workspace.read(documentPartKey(doc,i)));
        await appScope.globalWorkspace.write(documentPartKey(doc,'analysis'),await appScope.workspace.read(documentPartKey(doc,'analysis'),[]));
      }
      appScope.state.documents=await appScope.globalWorkspace.write('documents',docs);
    }
    if(!appScope.state.history.length&&appScope.state.conversations.length===1&&appScope.state.conversationId==='main'){
      const list=await appScope.workspace.read('conversations',[{id:'main',title:'配置对话'}]);
      for(const item of list)await appScope.globalWorkspace.write(`assistant-${item.id}`,await appScope.workspace.read(`assistant-${item.id}`,[]));
      appScope.state.conversations=await appScope.globalWorkspace.write('conversations',list);
      const ui=await appScope.workspace.read('ui',{});appScope.state.conversationId=ui.conversationId??'main';appScope.state.draft=ui.draft??appScope.state.draft;
      appScope.state.history=await appScope.globalWorkspace.read(`assistant-${appScope.state.conversationId}`,[]);
      await appScope.globalWorkspace.write('ui',{conversationId:appScope.state.conversationId,draft:appScope.state.draft});
    }
    await appScope.globalWorkspace.write('legacy-imported',{at:Date.now()});
  }

async function refresh({boundOnly=false,summaryCommit=false,check:parentCheck,view:reusableView}={}) {
    parentCheck?.();
    if(appScope.tracking&&!boundOnly&&(!appScope.workspace?.isCurrent()||appScope.state.stale)){await appScope.followCurrentChat();parentCheck?.();if(!appScope.workspace?.isCurrent())throw Object.assign(new Error('当前没有可读取的聊天'),{code:'CHAT_REF_UNAVAILABLE'});return;}
    const mutationKey=appScope.memoryMutationKey(),mutation=appScope.memoryMutationGuards.get(mutationKey),mutationRevision=mutation?.revision;
    if(mutation?.pending.size)throw appScope.pendingMemoryMutation();
    appScope.recallBusy++; if(!summaryCommit)appScope.recallChanged();
    try {
    const token = appScope.epoch, bound = appScope.workspace,check=()=>{appScope.assertCurrent(token);parentCheck?.();};check();
    const view = await appScope.core.readMemoryView({check,...(reusableView?{reuse:reusableView}:{})});check();
    const validity = await appScope.core.sourceValidity(view.records ?? {},{includeMessages:true});
    check();
    const liveChat=mvuContext(appScope.host)?.chat;
    appScope.sourcePrefixVerified=validity.totalCount===null&&!appScope.sourceEventRelevant('SOURCE_REFRESH')||Array.isArray(liveChat)&&liveChat.length===validity.totalCount&&!validity.invalidKeys.length&&!validity.unknownKeys.length&&(validity.messages??[]).every(m=>{
      const raw=liveChat[m.index];return raw&&String(raw.text??raw.mes??raw.content??'')===m.text&&(raw.version??raw.swipeId??raw.swipe_id??0)===m.version&&(!(raw.id??raw.messageId??raw.uuid??raw.sourceId)||(raw.id??raw.messageId??raw.uuid??raw.sourceId)===m.id);
    });
    appScope.runtimeLog.record({task:'background',phase:'reading',details:{stage:'prepare',...validity.readStats}});
    const valid = new Set(validity.validKeys);
    const filtered = Object.fromEntries(Object.entries(view.records ?? {}).map(([key, records]) => [key, Array.isArray(records) ? records.filter(record => (record.sourceRefs ?? []).every(ref => valid.has(sourceKey(ref)))) : records]));
    const all=Object.values(view.records?.history??{}).flatMap(h=>MEMORY_CATEGORIES.flatMap(k=>h.categories?.[k]??[]));
    appScope.state.deletedRecords=[...new Map(all.filter(r=>view.controls?.deletedRecords?.[r.id]).map(r=>[r.id,r])).values()];
    appScope.state.rawRecords=filtered;appScope.state.memoryControls=view.controls??{};
    appScope.state.summaryHold=view.controls?.automation?.summaryHold??null;
    const loadedQuality=await bound.read(QUALITY_STORE_KEY,{});check();appScope.qualitySaved=loadedQuality;
    appScope.state.records=projectQualityRecords(filtered,appScope.qualitySaved,view.controls,{copyUnchanged:false});
    appScope.state.quality=qualityStatus(filtered,appScope.qualitySaved,view.controls,appScope.state.records);
    const loadedRetrospective=await bound.read(RETROSPECTIVE_STORE_KEY,null);check();appScope.retrospectiveSaved=loadedRetrospective;
    if(!appScope.retrospectiveOperation)appScope.state.memoryRetrospective=retrospectiveState(appScope.retrospectiveSaved,{records:appScope.state.records,controls:view.controls,dictionary:appScope.activeDictionary()});
    appScope.state.records=projectRetrospectiveRecords(appScope.state.records,retrospectiveEntries(appScope.retrospectiveSaved),view.controls,{dictionary:appScope.activeDictionary()});
    const qualityDeleted=Object.values(appScope.qualitySaved).filter(e=>qualityEntryCurrent(e,filtered)).flatMap(e=>(e.additions??[]).map(a=>a.record)).filter(r=>view.controls?.deletedRecords?.[r.id]);
    appScope.state.deletedRecords.push(...qualityDeleted);
    const loadedMerges=await bound.read(MERGE_STORE_KEY,{});check();appScope.mergeDecisions=loadedMerges;
    appScope.state.merges=mergeJobs(appScope.state.records,appScope.mergeDecisions);
    try{await appScope.modules.sync();}catch(error){check();void appScope.reportError(error,{task:'background',stage:'background'});appScope.state.message='MVU 暂不可读，扩展区块没有使用旧值；可点击刷新重试';}
    const cards=await memoryCardsAsync(appScope.state.records,{hidden:appScope.state.hidden,includeAwareness:true},{check});
    check();appScope.state.cards = projectMergedCards(appScope.modules.cards(cards),appScope.state.records,appScope.mergeDecisions,appScope.state.merges).filter(c=>!appScope.state.hidden.includes(c.id));
    await readBatches(view,{check});check();
    // Publish a completed view atomically for sends. Pure additions do not
    // invalidate an in-flight recall of the preceding committed snapshot.
    // Replacements/deletions/knowledge changes still invalidate it immediately.
    const nextCards=new Map(appScope.state.cards.map(card=>[card.id,card]));
    const additive=summaryCommit&&appScope.committedRecall&&appScope.committedRecall.memoryCards.every(card=>stableStringify(card)===stableStringify(nextCards.get(card.id)));
    appScope.recallChanged({publicationOnly:Boolean(additive)});
    appScope.state.sourceStatus = {invalid:validity.invalidKeys.length,unknown:validity.unknownKeys.length};
    appScope.autoInvalidSources=new Set([...validity.invalidKeys,...validity.unknownKeys]);
    const docs = await appScope.globalWorkspace.read('documents', []);check();
    appScope.state.documents = docs; await appScope.warmRecall();check();
    if(appScope.memoryMutationKey()!==mutationKey||appScope.memoryMutationGuards.get(mutationKey)!==mutation||mutation&&(mutation.pending.size||mutation.revision!==mutationRevision))throw appScope.pendingMemoryMutation();
    if(mutation)appScope.memoryMutationGuards.delete(mutationKey);
    appScope.committedRecall=appScope.captureRecallSnapshot();
    appScope.rememberModuleSources();
    appScope.notify(); return view;
    } finally { appScope.recallBusy--; }
  }

async function syncModulesQuietly(){
    if(!appScope.workspace?.isCurrent()||appScope.state.stale||!appScope.state.modules.some(m=>m.mode==='mvu'&&m.enabled&&!m.archived))return;
    const token=appScope.epoch,version=appScope.cancelVersion,bound=appScope.workspace,current=()=>!appScope.disposed&&token===appScope.epoch&&version===appScope.cancelVersion&&appScope.workspace===bound&&bound.isCurrent();
    try{const different=await appScope.modules.sync();if(!current())return;appScope.rememberModuleSources();if(!different)return;appScope.state.cards=projectMergedCards(appScope.modules.cards(memoryCards(appScope.state.records,{hidden:appScope.state.hidden,includeAwareness:true})),appScope.state.records,appScope.mergeDecisions).filter(c=>!appScope.state.hidden.includes(c.id));appScope.recallChanged();appScope.notify();}
    catch(error){if(!current())return;void appScope.reportError(error,{task:'background',stage:'background'});appScope.state.cards=appScope.state.cards.filter(c=>!c.readonly);appScope.recallChanged();appScope.setMessage('MVU 读取未完成，旧变量未注入；请重新加载当前聊天或刷新变量');}
  }

async function normalizeBatchRanges(){
    const list=await appScope.workspace.read('summary-batches',[]),view=await appScope.core.readMemoryView();
    const consolidated=consolidateSummaryBatches(list,view.controls?.operations);
    if(!consolidated.removed)return;
    // Save a recovery copy before hiding duplicate generations. A failed write
    // leaves the old batch list available so normalization can safely retry.
    if(!await appScope.workspace.read('summary-batches-before-range-dedup-v1'))await appScope.workspace.write('summary-batches-before-range-dedup-v1',list);
    if(Object.keys(consolidated.retire).length)await appScope.core.updateMemoryControls({operations:consolidated.retire});
    await appScope.workspace.write('summary-batches',consolidated.rows);
  }

async function readBatches(view,{check:parentCheck}={}){
    const token=appScope.epoch,bound=appScope.workspace,check=()=>{appScope.assertCurrent(token);parentCheck?.();};check();
    let list=await bound.read('summary-batches',[]);check();
    const known=new Set(list.flatMap(b=>[b.operationId,b.previousOperation,...(b.attempts??[])]));
    const parents=[...new Set((view.records?.history??[]).map(h=>h.operationId?.split('/child-')[0]).filter(id=>id?.startsWith('product-summary_')&&!known.has(id)))];
    const legacy=parents.map((operationId,i)=>{
      const records=batchRecords(view.records?.history,operationId),indices=Object.values(records).flatMap(rows=>rows.flatMap(r=>[r.floorIndex,...(r.sourceRefs??[]).map(ref=>{const match=/^message:(\d+):/.exec(ref.sourceId);return match?Number(match[1]):null;})])).filter(Number.isInteger);
      return {id:makeId('legacy-batch'),number:list.length+i+1,operationId,startIndex:indices.length?Math.min(...indices):null,endIndex:indices.length?Math.max(...indices):null,status:'saved',legacy:true,attempts:[],focus:''};
    });
    if(legacy.length)list=await bound.write('summary-batches',[...list,...legacy]);
    check();
    appScope.state.batches=list.map(item=>{
      const mode=view.controls?.operations?.[item.operationId];
      const records=batchRecords(view.records?.history,item.operationId);
      const scheduled=item.status==='queued'&&item.freshStart;
      const cutoff=view.controls?.automation?.summaryHold;
      const abandonedTail=Boolean(cutoff&&item.replacement&&cutoff.id===item.replacement.id&&item.endIndex>cutoff.endIndex);
      const status=abandonedTail?'deleted':scheduled?'queued':mode==='active'?'saved':mode==='deleted'?'deleted':item.status==='running'&&appScope.activeSummaryBatchId!==item.id?'interrupted':item.status;
      return {...item,status,...(!scheduled&&mode==='active'?{error:null,savedOperationId:item.operationId}:{}),records,counts:Object.fromEntries(MEMORY_CATEGORIES.map(k=>[k,records[k].length]))};
    });
    if(view.controls?.automation?.summaryHold){
      appScope.state.summaryHold=view.controls.automation.summaryHold;
      appScope.state.autoStartFloor=appScope.state.summaryHold.endIndex+1;
      appScope.state.savedThrough=Math.max(-1,...appScope.state.batches.filter(b=>b.status==='saved').map(b=>b.endIndex).filter(Number.isInteger));
    }
    // Reconcile UI bookkeeping against the committed view after a restart.
    // This never activates pending content or changes memory evidence.
    const recovered=appScope.state.batches.filter(b=>list.some(old=>old.id===b.id&&(b.status==='saved'&&(old.status!=='saved'||old.savedOperationId!==b.operationId||old.error)||b.status==='deleted'&&old.status!=='deleted'||b.status==='interrupted'&&old.status==='running')));
    if(recovered.length){
      await bound.update('summary-batches',rows=>rows.map(row=>{
        check();
        const valid=recovered.find(b=>b.id===row.id&&b.operationId===row.operationId);
        return valid?{...row,status:valid.status,...(valid.status==='saved'?{savedOperationId:valid.operationId,error:null}:{})}:row;
      }),[]).catch(()=>{});check();
      appScope.state.savedThrough=Math.max(appScope.state.savedThrough,...recovered.filter(b=>b.status==='saved').map(b=>b.endIndex).filter(Number.isInteger));
    }
  }

async function deleteRecord(id){
    return deleteRecords([id]);
  }

function prepareRecordDeletion(selected,keepsakes,{originalParts=false}={}){
    if(!Array.isArray(selected)||!Array.isArray(keepsakes)||!selected.length&&!keepsakes.length||selected.some(id=>!appScope.state.cards.some(c=>c.id===id)))throw new Error('记忆不存在');
    const ids=[...new Set(selected.flatMap(id=>appScope.state.cards.find(c=>c.id===id).mergedIds??[id]))];
    const edits={},seen=new Set();
    for(const row of [...keepsakes].sort((a,b)=>(b.index??0)-(a.index??0))){
      const record=originalParts?appScope.keepsakeSourceCard(row?.recordId):appScope.state.cards.find(c=>c.id===row?.recordId),key=JSON.stringify([row?.kind,row?.recordId,row?.index]);
      if(!record||sha256(record)!==row.expected)throw new Error('原记录已变化，请刷新人物页后重试');
      if(record.mergedIds?.length)throw new Error('请先撤销事件合并，再移除其中的台词或心迹');
      if(seen.has(key)||ids.includes(record.id))continue;seen.add(key);
      edits[record.id]={...edits[record.id],...editKeepsakePatch({...record,...edits[record.id]},{...row,remove:true})};
    }
    return {ids,edits};
  }

async function deletePerson(input){
    appScope.assertCurrent();
    if(appScope.state.stale)throw appScope.personDeleteFailure('person_delete_stale');
    if(appScope.active||appScope.personaLaunch||appScope.dynamicPersona.state.busy||appScope.retrospectiveOperation)throw appScope.personDeleteFailure('person_delete_busy');
    if(!input||!Array.isArray(input.records)||!Array.isArray(input.keepsakes)||!Array.isArray(input.profiles)||!input.records.length&&!input.keepsakes.length&&!input.profiles.length)throw appScope.personDeleteFailure('person_delete_missing');
    const token=appScope.epoch;
    return appScope.reservePersonaCommand(async()=>{
      const op=appScope.begin();let memoryAttempted=false;
      const prepare=()=>{
        op.check();if(input.scopeKey!==JSON.stringify((appScope.core.readViewState?.()??appScope.core.state).scope))throw appScope.personDeleteFailure('person_delete_stale');
        for(const row of input.records){const card=appScope.state.cards.find(c=>c.id===row?.id);if(!card||sha256(card)!==row.expected)throw appScope.personDeleteFailure('person_delete_stale');}
        if(!input.records.length&&!input.keepsakes.length)return {ids:[],edits:{}};
        try{return prepareRecordDeletion(input.records.map(r=>r.id),input.keepsakes,{originalParts:true});}
        catch(error){throw appScope.personDeleteFailure('person_delete_stale',error);}
      };
      const commitRelated=async()=>{
        const prepared=prepare();if(!prepared.ids.length&&!Object.keys(prepared.edits).length)return;
        const view=await appScope.core.readMemoryView();op.check();const checked=prepare();
        for(const id of Object.keys(checked.edits))checked.edits[id]={...view.controls?.edits?.[id],...checked.edits[id]};
        memoryAttempted=true;
        await appScope.core.updateMemoryControls({deletedRecords:Object.fromEntries(checked.ids.map(id=>[id,true])),edits:checked.edits});op.check();
      };
      try{
        appScope.assertCurrent(token);prepare();
        if(input.profiles.length)await appScope.dynamicPersona.deleteProfiles(input.profiles,{checkRelated:prepare,commitRelated});
        else await commitRelated();
        op.check();await refresh();op.check();
        const message='人物关联记忆已移入回收站，动态档案保留旧版；共享事件、其他人物台词和聊天原文保留。';
        appScope.setMessage(message);return {message,level:'success'};
      }catch(error){
        if(memoryAttempted||error?.details?.reason==='person_delete_partial'){
          // A storage readback can fail after a real write. Reconcile this chat's
          // actual saved state; if it cannot be read, do not keep injecting a stale view.
          if(appScope.epoch===token&&op.workspace.isCurrent()){
            try{op.check();if(input.profiles.length)await appScope.dynamicPersona.reconcileSaved();op.check();await refresh();op.check();}
            catch{if(appScope.epoch===token&&op.workspace.isCurrent()){appScope.state.stale=true;appScope.recallChanged({clear:true});appScope.notify();}}
          }
          throw appScope.personDeleteFailure('person_delete_partial',error);
        }
        if(error?.code==='PERSISTENCE_ERROR')throw appScope.personDeleteFailure('person_delete_storage',error);
        throw error;
      }finally{op.finish();}
    });
  }

async function deleteRecords(selected,{keepsakes=[]}={}){
    appScope.assertCurrent();if(appScope.active)throw new Error('请先停止总结');
    const {ids,edits}=prepareRecordDeletion(selected,keepsakes);
    const op=appScope.begin();
    try{const view=await appScope.core.readMemoryView();op.check();for(const id of Object.keys(edits))edits[id]={...view.controls?.edits?.[id],...edits[id]};await appScope.core.updateMemoryControls({deletedRecords:Object.fromEntries(ids.map(key=>[key,true])),edits});op.check();}
    finally{op.finish();}
    await refresh();appScope.setMessage('选中记忆已移入回收站；指定心迹/台词已移除，共享事件和聊天原文保留');
  }

async function restoreRecord(id){appScope.assertCurrent();await appScope.core.updateMemoryControls({deletedRecords:{[id]:false}});await refresh();}

async function editRecord(id,text,metadata={}){
    appScope.assertCurrent();if(appScope.active)throw new Error('请先停止总结');
    const record=appScope.state.cards.find(c=>c.id===id);if(!record)throw new Error('记忆不存在');
    if(record.mergedIds?.length)throw new Error('这是合并视图，请先在记录 → 事件合并中撤销合并，再修改对应原记录。');
    const patch=editedMemoryFields(record.category,record,text);
    if(record.category==='entityFactChanges'&&!record.customModuleId){
      for(const [name,aliases]of [['entity',['entity','entityId']],['field',['field','key']]])if(Object.hasOwn(metadata,name)){
        if(typeof metadata[name]!=='string'||!metadata[name].trim()||metadata[name].length>160)throw new Error('人物和属性名称需要 1–160 字');
        for(const key of aliases)patch[key]=metadata[name].trim();
      }
      if(metadata.field&&metadata.field!==(record.field??record.key))patch.fieldLabel=null;
      if(metadata.valueFormat==='json'){
        let value;try{value=JSON.parse(text);}catch{throw new Error('属性内容不是有效的 JSON，请检查格式');}
        Object.assign(patch,{to:value,value,newValue:value});
      }
      // Derived aliases must not survive a manual identity/value rewrite.
      patch.entities=[];patch.recallSummary=null;
    }
    for(const name of ['title','recallSummary'])if(Object.hasOwn(metadata,name)){if(typeof metadata[name]!=='string'||metadata[name].length>(name==='title'?160:2000))throw new Error('标题或召回速览过长');patch[name]=metadata[name].trim()||null;}
    if(Object.hasOwn(metadata,'tags'))patch.tags=normalizeTags(metadata.tags);
    const existing=await appScope.core.readMemoryView();appScope.assertCurrent();
    await appScope.core.updateMemoryControls({edits:{[id]:{...existing.controls?.edits?.[id],...patch}}});
    await refresh();appScope.setMessage('修改已保存，后续召回使用新内容');
  }

async function editPersonProfile(subject,rows){
    appScope.assertCurrent();if(appScope.active)throw new Error('请先停止总结');
    if(!Array.isArray(rows)||!rows.length||rows.length>200)throw new Error('人物档案需要 1–200 项属性');
    const edits={},deletedRecords={},added=[],seen=new Set();
    for(const row of rows){
      if(typeof row.field!=='string'||!row.field.trim()||row.field.length>160)throw new Error('属性名称需要 1–160 字');
      if(typeof row.text!=='string'||row.text.length>12000)throw new Error('每项属性内容不能超过 12000 字');
      let value=row.text;if(row.format==='json'){try{value=JSON.parse(row.text);}catch{throw new Error(`“${row.field}”不是有效 JSON`);}}
      if(row.id){
        const record=appScope.state.cards.find(c=>c.id===row.id&&c.category==='entityFactChanges'&&!c.customModuleId&&factSubject(c)===subject);
        if(!record||seen.has(row.id))throw new Error('人物属性已变化，请重新打开档案');seen.add(row.id);
        if(row.expected!==sha256(record))throw new Error('人物属性已被更新，请重新打开档案后修改');
        if(row.remove){deletedRecords[row.id]=true;continue;}
        if(factKey(record)===row.field.trim()&&stableStringify(factValue(record))===stableStringify(value))continue;
        edits[row.id]={...editedMemoryFields('entityFactChanges',record,row.text),field:row.field.trim(),key:row.field.trim(),fieldLabel:null,to:value,value,newValue:value,title:null,recallSummary:null,entities:[]};
      }else if(!row.remove){if(!row.text.trim())throw new Error('新增属性内容不能为空');added.push({field:row.field.trim(),value});}
    }
    const op=appScope.begin();
    try{
      const controlsPatch={edits,deletedRecords};
      if(added.length)await appScope.core.remember('用户编辑人物档案',{category:'entityFactChanges',subject,profileFacts:added,controlsPatch});
      else await appScope.core.updateMemoryControls(controlsPatch);
      op.check();
    }finally{op.finish();}
    await refresh();appScope.setMessage('人物档案已保存；原始来源与删除记录可追溯');
  }

async function saveCharacterKeepsake(input){
    appScope.assertCurrent();if(appScope.active)throw new Error('请先停止总结');
    if(!input||typeof input!=='object'||input.origins!==undefined&&(!Array.isArray(input.origins)||!input.origins.length||input.origins.length>10000))throw new Error('角色记录的编辑来源无效，请重新打开');
    const edits={},rows=input.origins?.length?input.origins:[input];
    for(const row of [...rows].sort((a,b)=>(b.index??0)-(a.index??0))){
      const record=appScope.keepsakeSourceCard(row.recordId);
      if(!record||sha256(record)!==row.expected)throw new Error('原记录已变化，请重新打开后修改');
      if(record.mergedIds?.length)throw new Error('请先在事件合并中撤销合并，再修改原记录的台词');
      edits[record.id]={...edits[record.id],...editKeepsakePatch({...record,...edits[record.id]},{...input,index:row.index})};
    }
    const op=appScope.begin();
    try{const view=await appScope.core.readMemoryView();op.check();for(const id of Object.keys(edits))edits[id]={...view.controls?.edits?.[id],...edits[id]};await appScope.core.updateMemoryControls({edits});op.check();}
    finally{op.finish();}
    await refresh();appScope.setMessage(input.remove?'已移除此项，原事件和聊天原文保留':'角色记录已保存，后续注入使用新内容');
  }

async function hideRecord(id){appScope.assertCurrent();const ids=appScope.state.cards.find(c=>c.id===id)?.mergedIds??[id];appScope.recallBusy++;appScope.recallChanged();try{appScope.state.hidden=await appScope.workspace.update('hidden',list=>[...new Set([...list,...ids])],[]);await refresh();}finally{appScope.recallBusy--;}}

async function restoreHidden(){appScope.assertCurrent();appScope.state.hidden=await appScope.workspace.write('hidden',[]);await refresh();}
  return Object.freeze({ migrateWorkspace, refresh, syncModulesQuietly, normalizeBatchRanges, readBatches, deleteRecord, deletePerson, deleteRecords, restoreRecord, editRecord, editPersonProfile, saveCharacterKeepsake, hideRecord, restoreHidden });
}
