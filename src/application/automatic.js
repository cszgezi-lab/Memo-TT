import { sourceKey } from '../product-sources.js';
import { autoSummaryPlan, summaryCoverage, advancedStartFloor, summaryFrontier, hasNewerSavedCoverage } from '../product-auto-summary.js';
import { savedBatchOperation } from '../product-batches.js';
import { stableStringify } from '../utils.js';
import { mvuContext } from '../product-custom-modules.js';
import { errorDiagnostics } from '../diagnostics.js';
import { backgroundRetryDelay } from '../provider-scheduler.js';
import { failureText } from '../product-feedback.js';

/** automatic orchestration. Dependencies are limited by service-contracts.js. */
export function createAutomaticService(appScope) {
function validAutomaticBatches(){return appScope.state.batches.filter(b=>!Object.values(b.records??{}).flat().some(r=>r.sourceRefs?.some(ref=>appScope.autoInvalidSources.has(sourceKey(ref)))));}

function automaticPlan(){return autoSummaryPlan(validAutomaticBatches(),{advanceFromLatest:true,startFloor:appScope.state.autoStartFloor??1,batchSize:appScope.core.settings.autoSummaryEvery,keepRecent:appScope.core.settings.autoKeepRecent,lastIndex:appScope.state.autoLastIndex??null});}

async function syncAutoStartFloor(diagnosticRun,{check=()=>{}}={}){
    check();
    if(!appScope.workspace)return null;
    const start=appScope.state.autoStartFloor??1;
    const hold=appScope.state.summaryHold;
    // Explicit replacement cutoffs keep their contract. A deletion pause
    // must still reconcile later withdrawals of earlier published batches.
    if(hold&&hold.reason!=='batch_deleted'){const floor=hold.endIndex+1;await appScope.workspace.write('auto-progress',{startFloor:floor,updatedAt:Date.now()},{check});check();appScope.state.autoStartFloor=floor;return floor;}
    const next=summaryFrontier(validAutomaticBatches(),start);
    if(hold?.reason==='batch_deleted'){await appScope.core.updateMemoryControls({automation:{summaryHold:null}},{check,returnView:'deferred'});check();appScope.state.summaryHold=null;}
    if(next===start)return null;
    await appScope.workspace.write('auto-progress',{startFloor:next,updatedAt:Date.now()},{check});check();
    appScope.state.autoStartFloor=next;appScope.notify();
    appScope.runtimeLog.record({run:diagnosticRun,task:'summary',phase:'auto_start_floor',details:{startFloor:next,from:start}});
    return next;
  }

async function inspectAutomaticProgress(){
    await appScope.prepareSummaryChat();const op=appScope.begin();
    try{appScope.state.autoLastIndex=await appScope.core.historyTail();op.check();appScope.notify();return automaticPlan();}finally{op.finish();}
  }

async function setAutoStartFloor(floor,expectedScope=(appScope.core.readViewState?.()??appScope.core.state).scope){    appScope.assertCurrent();if(appScope.active)throw new Error('请先停止当前总结');
    if(stableStringify(expectedScope)!==stableStringify((appScope.core.readViewState?.()??appScope.core.state).scope))throw new Error('聊天已切换，起算楼层未修改');
    if(!Number.isSafeInteger(floor)||floor<0)throw new Error('起算楼层必须是 0 或正整数');
    await appScope.workspace.write('auto-progress',{startFloor:floor});appScope.state.autoStartFloor=floor;appScope.notify();
  }

async function setAutomatic(enabledNow){
    if(enabledNow&&appScope.currentMemoryMutation())await appScope.refresh();
    if(enabledNow&&appScope.active)throw new Error('请等当前任务结束后启用自动总结');
    if(enabledNow&&appScope.state.summaryHold){await appScope.core.updateMemoryControls({automation:{summaryHold:null}});appScope.state.summaryHold=null;}
    if(enabledNow){appScope.automaticPaused=false;appScope.autoHistoryAttempts=0;appScope.autoRetryAt=0;appScope.autoFailureCount=0;}
    else {appScope.autoPending=false;clearTimeout(appScope.autoTimer);appScope.autoTimer=null;}
    await appScope.saveSettings({autoSummaryEnabled:enabledNow});
    if(!enabledNow&&appScope.autoRunning){appScope.active?.abort();await appScope.core.cancelSummary();}
    if(enabledNow&&(!appScope.workspace?.isCurrent()||!appScope.bindings.length))await appScope.open({enable:appScope.enabled});
    appScope.setMessage(enabledNow?'自动总结已启用；按连续进度等待下一批楼层。':'自动总结已暂停；手动总结与记忆注入不受影响');
    if(enabledNow){
      try{await inspectAutomaticProgress();}catch(error){if(error?.code!=='HISTORY_UNAVAILABLE')throw error;void appScope.reportError(error,{task:'background',stage:'prepare'});appScope.setMessage('自动总结已启用；聊天原文暂未就绪，后台将有限重读。');}
      queueAutomaticSummary();
    }
  }

function queueAutomaticSummary(messageId){
    if(appScope.disposed)return;
    // Eligibility is cheap and local: retain only the current tail's existing
    // string/reference values, never hash or scan the full chat on a wake.
    let context;try{context=mvuContext(appScope.host);}catch{/* Optional local context cannot reject the host generation event. */}
    const chat=context?.chat,tail=Array.isArray(chat)?chat.at(-1):null;
    const sameScope=appScope.autoHistorySource?.[0]===appScope.boundRefKey;
    if(!sameScope)appScope.autoHistoryMessageId=null;
    const newMessage=Number.isSafeInteger(messageId)&&messageId>=0&&(appScope.autoHistoryMessageId===null||messageId>appScope.autoHistoryMessageId);
    if(newMessage)appScope.autoHistoryMessageId=messageId;
    // A late lower index or a temporarily unavailable context is not a new
    // source. Preserve the last known tail until genuinely newer evidence.
    let source=sameScope?appScope.autoHistorySource:[appScope.boundRefKey,null,null,null,null];
    if(Array.isArray(chat)&&(appScope.autoHistoryMessageId===null||chat.length-1>=appScope.autoHistoryMessageId)){
      appScope.autoHistoryMessageId=chat.length-1;
      source=[appScope.boundRefKey,chat.length,tail?.id??tail?.messageId??tail?.uuid??null,tail?.version??tail?.swipeId??tail?.swipe_id??null,tail?String(tail.text??tail.mes??tail.content??''):null];
    }else if(newMessage)source=[appScope.boundRefKey,messageId+1,null,null,null];
    if(!appScope.autoHistorySource||source.some((value,index)=>value!==appScope.autoHistorySource[index])){
      appScope.autoHistorySource=source;appScope.autoHistoryAttempts=0;appScope.autoRetryAt=0;clearTimeout(appScope.autoTimer);appScope.autoTimer=null;
    }
    if(appScope.autoHistoryAttempts>3){appScope.autoPending=false;return;}
    appScope.autoPending=true;wakeAutomaticSummary();
  }

function summaryHeld(){return appScope.state.summaryHold&&appScope.state.summaryHold.reason!=='batch_deleted';}
function unfinishedManualSummary(){return appScope.state.batches.some(batch=>batch.replacement&&['queued','running','failed','interrupted'].includes(batch.status)&&batch.trigger!=='auto'&&!hasNewerSavedCoverage(batch,appScope.state.batches));}

function wakeAutomaticSummary(){
    if(!appScope.autoPending||appScope.autoTimer!==null||appScope.autoTask||appScope.active||appScope.opening||appScope.disposed||appScope.followPending||appScope.following||appScope.state.stale||appScope.automaticPaused||summaryHeld()||appScope.currentMemoryMutation()||unfinishedManualSummary()||!appScope.enabled||!appScope.core.settings.autoSummaryEnabled||!appScope.apiConnectionReady('summary')||appScope.host.document?.visibilityState==='hidden'||!appScope.workspace?.isCurrent())return;
    const token=appScope.epoch,version=appScope.cancelVersion;
    appScope.autoTimer=setTimeout(()=>{
      appScope.autoTimer=null;
      if(token!==appScope.epoch||version!==appScope.cancelVersion||appScope.disposed){appScope.autoPending=false;return;}
      if(appScope.active||appScope.opening||appScope.followPending||appScope.following||appScope.state.stale||appScope.currentMemoryMutation()||summaryHeld()||unfinishedManualSummary())return;
      appScope.autoPending=false;
      const owner={token,version};appScope.autoTaskOwner=owner;
      const task=(async()=>{await appScope.syncModulesQuietly();if(appScope.autoTaskOwner===owner&&token===appScope.epoch&&version===appScope.cancelVersion&&!appScope.disposed)await autoSummary({owner});})()
        .catch(error=>{if(appScope.autoTaskOwner===owner&&token===appScope.epoch&&version===appScope.cancelVersion&&!appScope.disposed)void appScope.reportError(error,{task:'background',stage:'background'});})
        .finally(()=>{if(appScope.autoTaskOwner!==owner)return;appScope.autoTask=null;appScope.autoTaskOwner=null;appScope.notify();wakeAutomaticSummary();});
      appScope.autoTask=task;appScope.notify();
    },Math.max(0,appScope.autoRetryAt-Date.now()));
  }

async function autoSummary({force=false,owner={token:appScope.epoch,version:appScope.cancelVersion}}={}) {
    // A canceled native pointer may still commit later. Its destructive guard
    // survives settlement until a full reread reconciles the actual controls.
    // Background wakes cannot use the stale in-memory scheduling snapshot.
    if(appScope.currentMemoryMutation()){if(!force)return;await appScope.refresh();}
    if (appScope.active || appScope.followPending || appScope.following || appScope.state.stale || (!force&&(appScope.automaticPaused||summaryHeld()||!appScope.core.settings.autoSummaryEnabled||!appScope.apiConnectionReady('summary'))) || !appScope.workspace?.isCurrent()) return;
    if(force&&appScope.state.summaryHold){await appScope.core.updateMemoryControls({automation:{summaryHold:null}});appScope.state.summaryHold=null;}
    if(unfinishedManualSummary()){if(force)appScope.summaryFeedback('warning','手动计划尚未完成；请在本页“总结批次”重试或删除所选候选后再继续自动总结。','auto');return;}
    const feedbackAtStart = appScope.feedbackSequence,op=appScope.begin();owner.controller=appScope.active;appScope.autoRunOwner=owner;appScope.autoRunning=true;
    const owns=()=>appScope.autoRunOwner===owner&&owner.token===appScope.epoch&&owner.version===appScope.cancelVersion&&!appScope.disposed;
    const check=()=>{op.check();if(!owns())throw Object.assign(new Error('已停止'),{code:'CANCELED'});};
    appScope.notify();
    try {
      const lastIndex=await appScope.settledHistoryTail();check();appScope.state.autoLastIndex=lastIndex;
      const plan=automaticPlan();appScope.notify();
      const rangeKey=`${plan.nextStart}-${plan.nextEnd}`;
      if(appScope.autoFailureRange!==rangeKey){appScope.autoFailureRange=rangeKey;appScope.autoFailureCount=0;}
      if(!force&&appScope.autoFailureCount>3)return;
      if(!plan.ready){appScope.autoHistoryAttempts=0;appScope.autoRetryAt=0;if(force)appScope.setMessage('还没有满足条件的完整一批；保留楼层不参与自动总结');return;}
      if(appScope.core.settings.focusMode==='ask_every'&&!force){appScope.setMessage('自动总结等待侧重点，可在手动总结中处理下一批');return;}
      op.finish();
      const pending=appScope.state.batches.find(batch=>batch.trigger==='auto'&&['failed','interrupted','queued'].includes(batch.status)&&!batch.replacement&&batch.startIndex===plan.nextStart&&batch.endIndex===plan.nextEnd);
      if(pending)await appScope.retryBatch(pending.id,{check,explicit:false});
      else await appScope.summarize({startIndex:plan.nextStart,endIndex:plan.nextEnd,batchSize:plan.batchSize,trigger:'auto'});
      check();
      appScope.autoHistoryAttempts=0;appScope.autoRetryAt=0;appScope.autoFailureCount=0;
      if(!force)queueAutomaticSummary();
    }catch(error){
      if(!force&&owns()&&!op.signal.aborted&&error?.code==='HISTORY_UNAVAILABLE'){
        appScope.autoHistoryAttempts++;const delay=[1500,5000,15000][appScope.autoHistoryAttempts-1]??30000;appScope.autoRetryAt=Date.now()+delay;
        if(appScope.autoHistoryAttempts<=3)appScope.autoPending=true;
        appScope.summaryFeedback('warning',appScope.autoHistoryAttempts<=3?'聊天原文暂未就绪，自动总结稍后重读；已有记忆保留':'聊天原文仍不可读，等待下一次回复完成或回到前台再试；已有记忆保留','auto');
        appScope.runtimeLog.record({task:'background',phase:'waiting',details:{...errorDiagnostics(error),reason:'history_retry_wait',retryDelayMs:delay,historyReadAttempts:appScope.autoHistoryAttempts}});
      }else if(!force&&owns()&&!op.signal.aborted){
        const recoverableRange=['MODEL_OUTPUT_BLOCKED','MODEL_OUTPUT_TRUNCATED','SUMMARY_RESPONSE_ERROR','SUMMARY_TOOL_RESPONSE_INVALID','VALIDATION_ERROR','PROVIDER_STREAM_ERROR','PROVIDER_REQUEST_FAILED','TIMEOUT','FLOOR_SUMMARY_MISSING','COVERAGE_INCOMPLETE'].includes(error?.code)&&![401,403].includes(error?.details?.status)&&!['invalid_api_key','insufficient_quota'].includes(error?.details?.upstreamCode);
        if(recoverableRange){appScope.autoFailureCount=0;appScope.autoRetryAt=0;appScope.autoPending=false;appScope.summaryFeedback('warning','本次已停止；下次触发从后面的楼层继续，失败记录保留，可手动重试。','auto');}
        else {appScope.autoPending=false;appScope.autoFailureCount=4;appScope.summaryFeedback('error',failureText(error),'auto');}
      }else if(owns()&&!op.signal.aborted&&appScope.feedbackSequence===feedbackAtStart)appScope.summaryFeedback('error',`自动总结未完成：${failureText(error)}`,'auto');
      if(force)throw error;
    }
    finally{if(appScope.autoRunOwner===owner){appScope.autoRunOwner=null;appScope.autoRunning=false;}op.finish();}
  }
  return Object.freeze({ validAutomaticBatches, automaticPlan, syncAutoStartFloor, inspectAutomaticProgress, setAutoStartFloor, setAutomatic, queueAutomaticSummary, wakeAutomaticSummary, autoSummary });
}
