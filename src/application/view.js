import { buildDictionary } from '../product-dictionary.js';
import { autoSummaryPlan, hasNewerSavedCoverage } from '../product-auto-summary.js';
import { clone } from '../utils.js';
import { lazyViewState } from '../product-view-scheduling.js';
import { MEMORY_CATEGORIES } from '../product-batches.js';

/** view orchestration. Dependencies are limited by service-contracts.js. */
export function createViewService(appScope) {
function activeDictionary(){
    const profiles=appScope.state.dynamicPersona?.profiles??[],identityKey=JSON.stringify(profiles.map(p=>[p.name,p.aliases,p.deleted]));
    if(appScope.dictionaryRevision!==appScope.recallRevision||appScope.dictionaryProfiles!==identityKey||!appScope.dictionaryCache){appScope.dictionaryCache=buildDictionary([...(appScope.state.stale?[]:appScope.state.cards.filter(c=>c.category!=='conflicts')),...(appScope.core.settings.knowledgeEnabled?appScope.knowledgeCache.filter(c=>!appScope.state.hidden.includes(c.id)):[])],{aliases:appScope.core.settings.aliases,automatic:appScope.core.settings.dictionaryEnabled,profiles:appScope.state.stale?[]:profiles});appScope.dictionaryRevision=appScope.recallRevision;appScope.dictionaryProfiles=identityKey;}
    return appScope.dictionaryCache;
  }

function taskMonitor(plan=appScope.automaticPlan()){
    const manualPending=appScope.state.batches.filter(batch=>['queued','running','failed','interrupted'].includes(batch.status)&&batch.trigger!=='auto'&&!hasNewerSavedCoverage(batch,appScope.state.batches)).length;
    const automatic={status:'waiting',reason:'pending',retryAt:appScope.autoRetryAt||null,manualPending,nextStart:plan.nextStart,nextEnd:plan.nextEnd,ready:plan.ready};
    const waiting=(status,reason)=>Object.assign(automatic,{status,reason});
    if(!appScope.enabled||appScope.automaticPaused||appScope.disposed)waiting('paused','plugin_paused');
    else if(!appScope.core.settings.autoSummaryEnabled)waiting('disabled','disabled');
    else if(appScope.state.summaryHold)waiting('paused','summary_hold');
    else if(manualPending)waiting('blocked','manual_plan');
    else if(appScope.opening||appScope.followPending||appScope.following||appScope.state.stale)waiting('waiting','chat_loading');
    else if(!appScope.workspace?.isCurrent())waiting('blocked','no_chat');
    else if(appScope.autoRunning||appScope.autoTaskOwner)waiting('running','running');
    else if(appScope.active||appScope.currentMemoryMutation())waiting('waiting','task_busy');
    else if(appScope.host.document?.visibilityState==='hidden')waiting('waiting','hidden');
    else if(!appScope.apiConnectionReady('summary'))waiting('blocked','api_unconfigured');
    else if(appScope.autoHistoryAttempts>3&&!appScope.autoPending)waiting('blocked','history_unavailable');
    else if(appScope.autoFailureCount>3)waiting('blocked','retry_exhausted');
    else if(appScope.autoPending&&appScope.autoRetryAt>Date.now())waiting('waiting','retry_wait');
    else if(plan.ready&&appScope.core.settings.focusMode==='ask_every')waiting('blocked','focus_required');
    else if(plan.lastIndex===null)waiting('waiting','progress_unknown');
    else if(!plan.ready)waiting('waiting','not_enough_floors');
    else if(appScope.autoPending)waiting('ready','ready');
    const batch=appScope.activeSummaryBatchId?appScope.state.batches.find(row=>row.id===appScope.activeSummaryBatchId):null;
    let current=null;
    if(appScope.activeSummaryOperation){const monitor=appScope.activeSummaryOperation.monitor??{};current={kind:'summary',trigger:monitor.trigger??batch?.trigger??'manual',phase:monitor.phase??(batch?'running':'preparing'),...(batch?{batchId:batch.id,startIndex:batch.startIndex,endIndex:batch.endIndex}:Object.fromEntries(['startIndex','endIndex'].filter(k=>Number.isSafeInteger(monitor[k])).map(k=>[k,monitor[k]]))),...Object.fromEntries(['completedBatches','totalBatches','requestNumber'].filter(k=>Number.isSafeInteger(monitor[k])&&monitor[k]>=0).map(k=>[k,monitor[k]]))};}
    else if(appScope.autoRunOwner||appScope.autoTaskOwner)current={kind:'summary',trigger:'auto',phase:'preparing',startIndex:plan.nextStart,endIndex:plan.nextEnd};
    else if(appScope.opening||appScope.following)current={kind:'chat',trigger:null,phase:'preparing'};
    else if(appScope.active)current={kind:'operation',trigger:null,phase:'running'};
    else if(appScope.personaLaunch||appScope.state.dynamicPersona?.busy)current={kind:'persona',trigger:null,phase:appScope.state.dynamicPersona?.busy?'running':'preparing'};
    else if(appScope.vectorJob)current={kind:'vectors',trigger:null,phase:'running'};
    else if(appScope.qualityOperation)current={kind:'quality',trigger:'auto',phase:'running'};
    else if(appScope.apiOperations.size)current={kind:'api',trigger:null,phase:'running'};
    const providerRequests=[...appScope.queuedRequests.entries()].map(([requestId,details])=>({requestId,...Object.fromEntries(['modelRole','purpose','reason','queuePosition','queueWaitMs','retryDelayMs'].filter(key=>details[key]!==undefined).map(key=>[key,details[key]]))}));
    return {current,providerRequests,automatic};
  }

function summaryMonitor(op,patch){
    if(appScope.activeSummaryOperation!==op)return;
    const next={...op.monitor};
    if(['preparing','queued','waiting','composing','validating','saving','running'].includes(patch.phase))next.phase=patch.phase;
    for(const key of ['completedBatches','totalBatches','requestNumber'])if(Number.isSafeInteger(patch[key])&&patch[key]>=0)next[key]=patch[key];
    if(Object.keys(next).every(key=>next[key]===op.monitor?.[key]))return;
    op.monitor=next;appScope.notify();
  }

function publicState() { const automatic=appScope.automaticPlan();return { ...clone(appScope.state),automatic,autoRunning: appScope.autoRunning,taskMonitor:taskMonitor(automatic), merges:appScope.workspace?.isCurrent()&&!appScope.state.stale?clone(appScope.state.merges??[]):[], injectionLog:appScope.workspace?.isCurrent()?appScope.injectionLog?.state:null, dictionary:clone(activeDictionary()), runtimeLog:appScope.runtimeLog.state, enabled: appScope.enabled, chatReady:Boolean(appScope.workspace?.isCurrent())&&!appScope.state.stale, settings: appScope.core.settings, core: appScope.core.state, busy: Boolean(appScope.active)||appScope.apiOperations.size>0, credentialDirty:Object.fromEntries(Object.keys(appScope.keys).map(kind=>[kind,appScope.keyEdited.has(kind)&&Boolean(appScope.keys[kind])])), credentialPresent: Object.fromEntries(Object.entries(appScope.effectiveKeys()).map(([kind,value])=>[kind,Boolean(value)])) }; }

function viewAutomaticPlan(){
    const settings=appScope.core.settings,options={startFloor:appScope.state.autoStartFloor??1,batchSize:settings.autoSummaryEvery,keepRecent:settings.autoKeepRecent,lastIndex:appScope.state.autoLastIndex??null};
    const key=[appScope.state.batches,appScope.autoInvalidSources,...Object.values(options)];
    if(!appScope.viewPlanCache||key.some((value,index)=>value!==appScope.viewPlanCache.key[index]))appScope.viewPlanCache={key,plan:autoSummaryPlan(appScope.validAutomaticBatches(),options)};
    return appScope.viewPlanCache.plan;
  }

function readViewState(){
    const readers=Object.fromEntries(Object.entries(appScope.state).map(([key,value])=>[key,()=>clone(value)]));
    const cardRevision=appScope.viewIdentity(appScope.state.cards);
    return lazyViewState({...readers,cardRevision:()=>cardRevision,batchRevision:()=>appScope.viewIdentity(appScope.state.batches),automatic:()=>clone(viewAutomaticPlan()),autoRunning:()=>appScope.autoRunning,taskMonitor:()=>taskMonitor(viewAutomaticPlan()),
      // Compare source identities before the people view consumes/clones large fields.
      peopleRevision:()=>{const settings=appScope.core.settings;return JSON.stringify([cardRevision,appScope.viewIdentity(appScope.state.dynamicPersona),appScope.viewIdentity(activeDictionary()),settings.aliases,settings.dynamicPersonaMvuMode]);},
      merges:()=>appScope.workspace?.isCurrent()&&!appScope.state.stale?clone(appScope.state.merges??[]):[],injectionLog:()=>appScope.workspace?.isCurrent()?appScope.injectionLog?.state:null,
      dictionary:()=>clone(activeDictionary()),runtimeLog:()=>appScope.runtimeLog.state,enabled:()=>appScope.enabled,chatReady:()=>Boolean(appScope.workspace?.isCurrent())&&!appScope.state.stale,
      settings:()=>appScope.core.settings,core:()=>appScope.core.readViewState?.()??appScope.core.state,busy:()=>Boolean(appScope.active)||appScope.apiOperations.size>0,
      summaryBatches:()=>appScope.state.batches.map(({records,replacement,...batch})=>clone({...batch,...(replacement?{replacement:{...replacement,affected:(replacement.affected??[]).map(({id,startIndex,endIndex})=>({id,startIndex,endIndex}))}}:{})})),
      cardCounts:()=>Object.fromEntries(MEMORY_CATEGORIES.map(category=>[category,appScope.state.cards.filter(c=>!c.customModuleId&&c.category===category).length])),
      personCount:()=>new Set(appScope.state.cards.filter(c=>!c.customModuleId&&c.category==='entityFactChanges').map(c=>c.entity??c.entityId).filter(Boolean)).size,
      credentialDirty:()=>Object.fromEntries(Object.keys(appScope.keys).map(kind=>[kind,appScope.keyEdited.has(kind)&&Boolean(appScope.keys[kind])])),
      credentialPresent:()=>Object.fromEntries(Object.entries(appScope.effectiveKeys()).map(([kind,value])=>[kind,Boolean(value)]))});
  }

function setMessage(message) { appScope.state.message = message; appScope.notify(); }

function summaryFeedback(level,text,trigger) { appScope.state.feedback={id:++appScope.feedbackSequence,kind:'summary',level,text,trigger};setMessage(text); }
  return Object.freeze({ activeDictionary, summaryMonitor, publicState, readViewState, setMessage, summaryFeedback });
}
