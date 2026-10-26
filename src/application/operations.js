

/** operations orchestration. Dependencies are limited by service-contracts.js. */
export function createOperationsService(appScope) {
function assertCurrent(token = appScope.epoch) { if (!appScope.workspace || token !== appScope.epoch || !appScope.workspace.isCurrent()) throw Object.assign(new Error('聊天或来源已变化，旧聊天操作已停止'),{code:'CHAT_CHANGED'}); }

function continuationCheck(parentCheck){
    const token=appScope.epoch,version=appScope.cancelVersion;
    return ()=>{if(appScope.disposed||version!==appScope.cancelVersion)throw Object.assign(new Error('已停止'),{code:'CANCELED'});assertCurrent(token);parentCheck?.();};
  }

function begin(exclusive = true) {
    if(exclusive&&appScope.qualityOperation){appScope.qualityOperation.preempted=true;appScope.qualityOperation.abort();}
    if (exclusive && appScope.active) throw new Error('已有任务正在运行');
    const controller = new AbortController(), token = appScope.epoch, version = appScope.cancelVersion, bound = appScope.workspace;
    appScope.operations.add(controller); if (exclusive) appScope.active = controller;
    return { signal: controller.signal, workspace: bound, token, abort:()=>controller.abort(),
      check() { if (controller.signal.aborted || version !== appScope.cancelVersion) throw Object.assign(new Error('已停止'),{code:'CANCELED'}); assertCurrent(token); },
      finish() { appScope.operations.delete(controller); if (appScope.active === controller) appScope.active = null; appScope.notify(); appScope.wakeChatFollower(); appScope.wakeAutomaticSummary(); appScope.wakeVectors(); } };
  }

function abortAll() {
    appScope.cancelVersion++;appScope.autoPending=false;appScope.autoHistoryAttempts=0;appScope.autoRetryAt=0;appScope.autoHistorySource=null;appScope.autoHistoryMessageId=null;clearTimeout(appScope.autoTimer);appScope.autoTimer=null;
    for (const op of appScope.operations) op.abort();
    // A native history/storage await may never settle after abort. Retire its
    // automatic wrapper now; late callbacks are fenced by the captured owner.
    const owner=appScope.autoRunOwner??appScope.autoTaskOwner;
    if(owner?.controller&&appScope.active===owner.controller){appScope.operations.delete(appScope.active);appScope.active=null;if(appScope.activeSummaryOperation?.monitor?.trigger==='auto'){appScope.activeSummaryOperation=null;appScope.activeSummaryBatchId=null;}}
    appScope.autoTask=null;appScope.autoTaskOwner=null;appScope.autoRunOwner=null;appScope.autoRunning=false;
  }

function beginApi() {
    const controller=new AbortController();appScope.apiOperations.add(controller);appScope.notify();
    return {signal:controller.signal,check(){if(controller.signal.aborted)throw Object.assign(new Error('已停止'),{code:'CANCELED'});},finish(){appScope.apiOperations.delete(controller);appScope.notify();}};
  }

function currentMemoryMutation(){return appScope.memoryMutationGuards.get(appScope.memoryMutationKey());}

function beginMemoryMutation(){
    const key=appScope.memoryMutationKey(),guard=appScope.memoryMutationGuards.get(key)??{pending:new Set(),revision:0};
    appScope.memoryMutationGuards.set(key,guard);guard.revision++;appScope.recallChanged({clear:true});return guard;
  }

function trackedMemoryMutation(guard,task){
    const work=Promise.resolve().then(task);guard.pending.add(work);
    return work.finally(()=>{guard.pending.delete(work);guard.revision++;});
  }
  return Object.freeze({ assertCurrent, continuationCheck, begin, abortAll, beginApi, currentMemoryMutation, beginMemoryMutation, trackedMemoryMutation });
}
