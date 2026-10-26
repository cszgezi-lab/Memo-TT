import { APPLICATION_SERVICE_CONTRACTS as contracts } from './application/service-contracts.js';
import { composeApplicationServices, createServiceScope } from './application/service-ports.js';
import { createLifecycleService } from './application/lifecycle.js';
import { createOperationsService } from './application/operations.js';
import { createDiagnosticsService } from './application/diagnostics.js';
import { createViewService } from './application/view.js';
import { createSettingsService } from './application/settings.js';
import { createMemoryService } from './application/memory.js';
import { createSummaryService } from './application/summary.js';
import { createAutomaticService } from './application/automatic.js';
import { createRecallService } from './application/recall.js';
import { createVectorsService } from './application/vectors.js';
import { createReviewsService } from './application/reviews.js';
import { createDocumentsService } from './application/documents.js';
import { createAssistantService } from './application/assistant.js';
import { createPersonaService } from './application/persona.js';
import { createApiService } from './application/api.js';
import { MEMO_TT_IDENTITY } from './memo-identity.js';
import { createMemoHostAdapter } from './memo-host-adapter.js';
import { HostAdapter } from './host-adapter.js';

import {createDynamicPersona} from './dynamic-persona.js';
import {createPersonaWorldbook} from './dynamic-persona-worldbook.js';

import { createProductShellController } from './product-shell-controller.js';

import { observeProviderRequests, scheduleProviderRequests } from './provider.js';
import { createProviderScheduler } from './provider-scheduler.js';
import { installDiagnosticBoundary } from './diagnostics.js';

import { RecallIndexCache } from './recall-cache.js';
import { createRecallLaneBackoff } from './product-recall-policy.js';
import { ProductVectorCache } from './product-vector-cache.js';

import { clone, sha256, stableStringify } from './utils.js';
import { createProductFetch } from './product-network.js';

import { createGlobalSettings } from './product-global-settings.js';
import { savedBatchOperation } from './product-batches.js';

import { createModuleController } from './product-module-controller.js';
import { moduleRules, checkModuleBundle } from './product-custom-modules.js';

import { createCredentialStore } from './product-credentials.js';
import { createRuntimeLog } from './product-runtime-log.js';

import { retrospectiveState } from './product-memory-retrospective-controller.js';

/** Owns product flow; core controller still owns extraction and memory commits. */
export function createProductApplication({ host = globalThis, adapter = null, controller = null, identity = null, fetchImpl = globalThis.fetch, onChange = () => {}, onInvalidate = null, requestScheduler = null } = {}) {
  // Getters keep chat ownership, cancellation and resource replacement live.
  const applicationBindings = {
    get active(){return active;}, set active(value){active=value;},
    get activeSummaryBatchId(){return activeSummaryBatchId;}, set activeSummaryBatchId(value){activeSummaryBatchId=value;},
    get activeSummaryOperation(){return activeSummaryOperation;}, set activeSummaryOperation(value){activeSummaryOperation=value;},
    get apiOperations(){return apiOperations;},
    get apiSettings(){return apiSettings;},
    get assistantActive(){return assistantActive;}, set assistantActive(value){assistantActive=value;},
    get autoFailureCount(){return autoFailureCount;}, set autoFailureCount(value){autoFailureCount=value;},
    get autoFailureRange(){return autoFailureRange;}, set autoFailureRange(value){autoFailureRange=value;},
    get autoHistoryAttempts(){return autoHistoryAttempts;}, set autoHistoryAttempts(value){autoHistoryAttempts=value;},
    get autoHistoryMessageId(){return autoHistoryMessageId;}, set autoHistoryMessageId(value){autoHistoryMessageId=value;},
    get autoHistorySource(){return autoHistorySource;}, set autoHistorySource(value){autoHistorySource=value;},
    get autoInvalidSources(){return autoInvalidSources;}, set autoInvalidSources(value){autoInvalidSources=value;},
    get autoPending(){return autoPending;}, set autoPending(value){autoPending=value;},
    get autoRetryAt(){return autoRetryAt;}, set autoRetryAt(value){autoRetryAt=value;},
    get autoRunOwner(){return autoRunOwner;}, set autoRunOwner(value){autoRunOwner=value;},
    get autoRunning(){return autoRunning;}, set autoRunning(value){autoRunning=value;},
    get autoTask(){return autoTask;}, set autoTask(value){autoTask=value;},
    get autoTaskOwner(){return autoTaskOwner;}, set autoTaskOwner(value){autoTaskOwner=value;},
    get autoTimer(){return autoTimer;}, set autoTimer(value){autoTimer=value;},
    get automaticPaused(){return automaticPaused;}, set automaticPaused(value){automaticPaused=value;},
    get automaticQualityQueue(){return automaticQualityQueue;}, set automaticQualityQueue(value){automaticQualityQueue=value;},
    get bindings(){return bindings;},
    get boundRefKey(){return boundRefKey;}, set boundRefKey(value){boundRefKey=value;},
    get boundScope(){return boundScope;}, set boundScope(value){boundScope=value;},
    get cancelVersion(){return cancelVersion;}, set cancelVersion(value){cancelVersion=value;},
    get chatListeners(){return chatListeners;},
    get committedRecall(){return committedRecall;}, set committedRecall(value){committedRecall=value;},
    get core(){return core;},
    get credentials(){return credentials;},
    get credentialsLoaded(){return credentialsLoaded;}, set credentialsLoaded(value){credentialsLoaded=value;},
    get diagnosticJobs(){return diagnosticJobs;},
    get dictionaryCache(){return dictionaryCache;}, set dictionaryCache(value){dictionaryCache=value;},
    get dictionaryProfiles(){return dictionaryProfiles;}, set dictionaryProfiles(value){dictionaryProfiles=value;},
    get dictionaryRevision(){return dictionaryRevision;}, set dictionaryRevision(value){dictionaryRevision=value;},
    get disposed(){return disposed;}, set disposed(value){disposed=value;},
    get dynamicPersona(){return dynamicPersona;},
    get enabled(){return enabled;}, set enabled(value){enabled=value;},
    get epoch(){return epoch;}, set epoch(value){epoch=value;},
    get feedbackSequence(){return feedbackSequence;}, set feedbackSequence(value){feedbackSequence=value;},
    get fetchImpl(){return fetchImpl;},
    get followNotBefore(){return followNotBefore;}, set followNotBefore(value){followNotBefore=value;},
    get followPending(){return followPending;}, set followPending(value){followPending=value;},
    get followReadAttempts(){return followReadAttempts;}, set followReadAttempts(value){followReadAttempts=value;},
    get followTimer(){return followTimer;}, set followTimer(value){followTimer=value;},
    get followVersion(){return followVersion;}, set followVersion(value){followVersion=value;},
    get followWaiters(){return followWaiters;},
    get following(){return following;}, set following(value){following=value;},
    get foreground(){return foreground;}, set foreground(value){foreground=value;},
    get foregroundBusy(){return foregroundBusy;},
    get generationListeners(){return generationListeners;},
    get globalLoaded(){return globalLoaded;}, set globalLoaded(value){globalLoaded=value;},
    get globalLoading(){return globalLoading;}, set globalLoading(value){globalLoading=value;},
    get globalStore(){return globalStore;},
    get globalWorkspace(){return globalWorkspace;}, set globalWorkspace(value){globalWorkspace=value;},
    get host(){return host;},
    get hostAdapter(){return hostAdapter;}, set hostAdapter(value){hostAdapter=value;},
    get injectedPayloads(){return injectedPayloads;},
    get injecting(){return injecting;}, set injecting(value){injecting=value;},
    get injectionLog(){return injectionLog;}, set injectionLog(value){injectionLog=value;},
    get keepsakeSourceCard(){return keepsakeSourceCard;},
    get keyEdited(){return keyEdited;},
    get keyOrigins(){return keyOrigins;},
    get keyVersions(){return keyVersions;},
    get keys(){return keys;},
    get knowledgeCache(){return knowledgeCache;}, set knowledgeCache(value){knowledgeCache=value;},
    get knowledgeJob(){return knowledgeJob;}, set knowledgeJob(value){knowledgeJob=value;},
    get knowledgeVectorCache(){return knowledgeVectorCache;},
    get memoryMutationGuards(){return memoryMutationGuards;},
    get memoryMutationKey(){return memoryMutationKey;},
    get mergeDecisions(){return mergeDecisions;}, set mergeDecisions(value){mergeDecisions=value;},
    get moduleSourceBaseline(){return moduleSourceBaseline;}, set moduleSourceBaseline(value){moduleSourceBaseline=value;},
    get moduleSourceChatId(){return moduleSourceChatId;}, set moduleSourceChatId(value){moduleSourceChatId=value;},
    get moduleStamp(){return moduleStamp;},
    get modules(){return modules;},
    get notify(){return notify;},
    get opening(){return opening;}, set opening(value){opening=value;},
    get operations(){return operations;},
    get overwriteHash(){return overwriteHash;},
    get pendingMemoryMutation(){return pendingMemoryMutation;},
    get personDeleteFailure(){return personDeleteFailure;},
    get personaCommandVersion(){return personaCommandVersion;}, set personaCommandVersion(value){personaCommandVersion=value;},
    get personaLaunch(){return personaLaunch;}, set personaLaunch(value){personaLaunch=value;},
    get personaPromptModule(){return personaPromptModule;}, set personaPromptModule(value){personaPromptModule=value;},
    get personaWorldbook(){return personaWorldbook;},
    get prefixFor(){return prefixFor;},
    get preparedQuality(){return preparedQuality;}, set preparedQuality(value){preparedQuality=value;},
    get providerScheduler(){return providerScheduler;},
    get qualityJob(){return qualityJob;}, set qualityJob(value){qualityJob=value;},
    get qualityOperation(){return qualityOperation;}, set qualityOperation(value){qualityOperation=value;},
    get qualitySaved(){return qualitySaved;}, set qualitySaved(value){qualitySaved=value;},
    get queuedRequests(){return queuedRequests;},
    get recallBusy(){return recallBusy;}, set recallBusy(value){recallBusy=value;},
    get recallCache(){return recallCache;},
    get recallReaders(){return recallReaders;}, set recallReaders(value){recallReaders=value;},
    get recallRevision(){return recallRevision;}, set recallRevision(value){recallRevision=value;},
    get recallSafetyRevision(){return recallSafetyRevision;}, set recallSafetyRevision(value){recallSafetyRevision=value;},
    get recordedErrors(){return recordedErrors;},
    get replacementEditsHash(){return replacementEditsHash;},
    get rerankBudgetMs(){return rerankBudgetMs;},
    get rerankLane(){return rerankLane;},
    get resumeAutomaticTasks(){return resumeAutomaticTasks;},
    get resumeVectorMaintenance(){return resumeVectorMaintenance;},
    get retrospectiveOperation(){return retrospectiveOperation;}, set retrospectiveOperation(value){retrospectiveOperation=value;},
    get retrospectiveSaved(){return retrospectiveSaved;}, set retrospectiveSaved(value){retrospectiveSaved=value;},
    get runtimeLog(){return runtimeLog;},
    get sourceContextComplete(){return sourceContextComplete;}, set sourceContextComplete(value){sourceContextComplete=value;},
    get sourcePrefixVerified(){return sourcePrefixVerified;}, set sourcePrefixVerified(value){sourcePrefixVerified=value;},
    get state(){return state;},
    get stopErrorBoundary(){return stopErrorBoundary;},
    get stopForceTimer(){return stopForceTimer;}, set stopForceTimer(value){stopForceTimer=value;},
    get stopRequestScheduler(){return stopRequestScheduler;},
    get stopTransportDiagnostics(){return stopTransportDiagnostics;},
    get summaryRecipeHash(){return summaryRecipeHash;},
    get tracking(){return tracking;}, set tracking(value){tracking=value;},
    get trackingStart(){return trackingStart;}, set trackingStart(value){trackingStart=value;},
    get vectorBudgetMs(){return vectorBudgetMs;},
    get vectorCache(){return vectorCache;},
    get vectorCheckVersion(){return vectorCheckVersion;}, set vectorCheckVersion(value){vectorCheckVersion=value;},
    get vectorExcluded(){return vectorExcluded;}, set vectorExcluded(value){vectorExcluded=value;},
    get vectorJob(){return vectorJob;}, set vectorJob(value){vectorJob=value;},
    get vectorLane(){return vectorLane;},
    get vectorStopped(){return vectorStopped;}, set vectorStopped(value){vectorStopped=value;},
    get vectorStorageFailure(){return vectorStorageFailure;}, set vectorStorageFailure(value){vectorStorageFailure=value;},
    get vectorTimer(){return vectorTimer;}, set vectorTimer(value){vectorTimer=value;},
    get viewIdentity(){return viewIdentity;},
    get viewPlanCache(){return viewPlanCache;}, set viewPlanCache(value){viewPlanCache=value;},
    get workspace(){return workspace;}, set workspace(value){workspace=value;}
  };
  const services = composeApplicationServices([
    { name: 'lifecycle', contract: contracts.lifecycle, create: createLifecycleService },
    { name: 'operations', contract: contracts.operations, create: createOperationsService },
    { name: 'diagnostics', contract: contracts.diagnostics, create: createDiagnosticsService },
    { name: 'view', contract: contracts.view, create: createViewService },
    { name: 'settings', contract: contracts.settings, create: createSettingsService },
    { name: 'memory', contract: contracts.memory, create: createMemoryService },
    { name: 'summary', contract: contracts.summary, create: createSummaryService },
    { name: 'automatic', contract: contracts.automatic, create: createAutomaticService },
    { name: 'recall', contract: contracts.recall, create: createRecallService },
    { name: 'vectors', contract: contracts.vectors, create: createVectorsService },
    { name: 'reviews', contract: contracts.reviews, create: createReviewsService },
    { name: 'documents', contract: contracts.documents, create: createDocumentsService },
    { name: 'assistant', contract: contracts.assistant, create: createAssistantService },
    { name: 'persona', contract: contracts.persona, create: createPersonaService }
  ], applicationBindings);
  const { clearPrompt, wakeChatFollower, startChatTracking, followCurrentChat, rememberModuleSources, sourceEventRelevant, settledHistoryTail, localPersonaHistoryState, open, stop, disable } = services.lifecycle;
  const { assertCurrent, continuationCheck, begin, abortAll, beginApi, currentMemoryMutation, beginMemoryMutation, trackedMemoryMutation } = services.operations;
  const { trackDiagnostic, reportError, flushDiagnostics, logged } = services.diagnostics;
  const { activeDictionary, summaryMonitor, publicState, readViewState, setMessage, summaryFeedback } = services.view;
  const { effectiveKeys, loadApiSettings, client, apiConnectionReady, resolvedPersonaSettings, saveUi, saveSettings, saveApi, forgetKey, listModels, testConnection } = services.settings;
  const { migrateWorkspace, refresh, syncModulesQuietly, normalizeBatchRanges, readBatches, deleteRecord, deletePerson, deleteRecords, restoreRecord, editRecord, editPersonProfile, saveCharacterKeepsake, hideRecord, restoreHidden } = services.memory;
  const { prepareSummaryChat, previewSummary, summarize, regenerateBatch, retryBatch, retryIncompleteBatches, splitSummaryBatch, previewApplySummaryPrefix, applySummaryPrefix, manageBatches, deleteBatch, restoreBatch } = services.summary;
  const { validAutomaticBatches, automaticPlan, syncAutoStartFloor, inspectAutomaticProgress, setAutoStartFloor, setAutomatic, queueAutomaticSummary, wakeAutomaticSummary, autoSummary } = services.automatic;
  const { captureRecallSnapshot, recallChanged, readNarrativeSource, warmRecall, externalState, preview, inject } = services.recall;
  const { combinedVectorEntries, excludeVector, listVectorEntries, wakeVectors, refreshVectorStatus, buildVectors, retryBatchVectors } = services.vectors;
  const { queueAutomaticQuality, reviewMemoryConsistency, undoMemoryConsistency, processMergeQueue, previewQuality, inspectQualityRecord, saveQualityRecord, reviewMemory, undoQuality, retryMerges, keepMergeSeparate, chooseMergeTarget } = services.reviews;
  const { loadKnowledge, knowledgeCards, addDocument, removeDocument, analyzeDocuments, updateDocument, documentPreview, editDocumentChunk, buildKnowledgeVectors } = services.documents;
  const { replyLimit, assistant, applyProposal, undoSettings, newConversation, selectConversation, deleteConversation } = services.assistant;
  const { assertNoRetrospective, reservePersonaCommand, queueDynamicPersona, retryDynamicPersonaManualBatch, manageDynamicPersonaCandidate } = services.persona;

  adapter = createMemoHostAdapter(adapter ?? new HostAdapter(host), { identity: identity ?? adapter?.memoIdentity ?? MEMO_TT_IDENTITY, disposeUnderlying: adapter === null, independentLifetime: true });
  fetchImpl = createProductFetch(host, fetchImpl);
  let hostAdapter = adapter;
  let personaPromptModule = null;
  
  // Session pause is separate from the persisted feature opt-ins. A fresh
  // session must honor injectionEnabled after passive chat loading, without
  // requiring an extra panel "open" action. Unconfigured APIs do not dispatch
  // automatic work; disable() keeps this session paused.
  let workspace = null, boundScope = null, boundRefKey = null, epoch = 0, active = null, bindings = [], enabled = true;
  // The one batch the current summarize task is executing. A persisted
  // 'running' row belongs to a dead session unless it names this batch, so
  // stale rows recover instead of blocking retry and automatic summary.
  let activeSummaryBatchId = null;
  let activeSummaryOperation = null;
  let cancelVersion = 0, knowledgeCache = [], opening = false, feedbackSequence = 0, stopForceTimer = null;
  let recallRevision = 0;
  let recallSafetyRevision = 0, committedRecall = null;
  let autoTimer=null,autoPending=false,autoTask=null,autoTaskOwner=null,autoRunOwner=null,autoHistoryAttempts=0,autoRetryAt=0,autoHistorySource=null,autoHistoryMessageId=null;
  let foreground=false,injecting=0,autoFailureCount=0,autoFailureRange='';
  let dictionaryRevision=-1, dictionaryCache=null,dictionaryProfiles=null;
  let recallBusy = 0, moduleSourceBaseline=null,moduleSourceChatId=null,sourcePrefixVerified=false,sourceContextComplete=false;
  let vectorTimer=null,vectorJob=null,vectorCheckVersion=0,vectorStorageFailure=null;
  let vectorStopped=false,recallReaders=0;
  let injectionLog=null,vectorExcluded=[],mergeDecisions={},qualitySaved={},preparedQuality=null;
  let tracking=false,trackingStart=null,disposed=false,followPending=false,followTimer=null,following=null,followVersion=0,followNotBefore=0,followReadAttempts=0;
  let qualityJob=null,automaticQualityQueue=[],qualityOperation=null;
  let retrospectiveSaved=null,retrospectiveOperation=null;
  const chatListeners=[],generationListeners=[],followWaiters=[];
  const recallCache = new RecallIndexCache(), vectorCache = new ProductVectorCache(),knowledgeVectorCache=new ProductVectorCache();
  let knowledgeJob=false,automaticPaused=false,autoInvalidSources=new Set();
  const operations = new Set(), apiOperations = new Set(), injectedPayloads = new WeakSet();
  const memoryMutationGuards=new Map();
  const keys = { summary: '', supplement:'', assistant: '', embedding: '', rerank: '',dynamicPersona:'',personaReview:'',knowledge:'' };
  const keyOrigins={},keyVersions={},keyEdited=new Set();let credentialsLoaded=false;
  const prefixFor=k=>k==='summary'?'provider':k;
  
  const core = controller ?? createProductShellController({ host, adapterFactory: h => (hostAdapter ??= new HostAdapter(h)), adapter, fetchImpl, supplementModelFactory:()=>{if(core.settings.supplementFollowSummary&&!core.settings.supplementModel)return null;const c=client('supplement');return {profile:{model:c.profile.model,maxTokens:core.settings.outputBudgetUnits,summaryRequestMode:core.settings.summaryRequestMode,summaryStreaming:core.settings.summaryStreaming},chatCompletions:(p,o)=>c.chatCompletions(p,o)};}, onChange: () => notify(), runtimeRules: ({currentOnly=false}={}) => currentOnly?moduleRules(state.modules):`故事时间以对应楼层原文为准；回忆、约定日期与当前场景日期分别记录，不套用全局日期。外部权威状态（只读）：${externalState()}\n${moduleRules(state.modules)}`, shouldInvalidate:sourceEventRelevant, summaryBundleValidator:()=>{const definitions=clone(state.modules);return bundle=>checkModuleBundle(bundle,definitions);} });
  let globalWorkspace,globalLoaded=false,globalLoading=null,assistantActive=false;
  const globalStore=async()=>{
    hostAdapter??=new HostAdapter(host);await hostAdapter.ready?.();
    if(!hostAdapter.getStore)throw new Error('宿主没有提供全局扩展存储');
    return hostAdapter.getStore({scope:'extension'});
  };
  const apiSettings=createGlobalSettings({getStore:globalStore,onApply:settings=>{const recallSettingsChanged=stableStringify({...core.settings,narrativeExtraction:''})!==stableStringify({...settings,narrativeExtraction:''}),readingChanged=core.settings.narrativeExtraction!==settings.narrativeExtraction;core.useGlobalSettings(settings);core.setSessionCredential(effectiveKeys().summary);if(recallSettingsChanged)recallChanged({vectors:true});else if(readingChanged)recallChanged();notify();}});
  const credentials=createCredentialStore({getStore:globalStore});
  let autoRunning=false,personaLaunch=null,personaCommandVersion=0;
  const state = { credentialSaved:{},credentialErrors:{}, modules:[],moduleSnapshots:[],moduleCurrent:[],mvuPaths:[],mvuStatus:'no_chat', status: 'unbound', message: '开始总结时自动读取 TT 当前聊天', cards: [], documents: [], history: [], batches: [], records: {}, conversations: [], conversationId: 'main', proposal: null, lastApplied: null, draft: '', preview: null, actual: null, progress: '', savedThrough: -1, hidden: [], stale: false };
  state.memoryRetrospective=retrospectiveState(null);
  const notify = () => { try { if(onInvalidate)onInvalidate();else onChange(publicState()); } catch { /* paint failure must not affect persistence */ } };
  const runtimeLog=createRuntimeLog({getStore:globalStore,onChange:notify});
  const providerScheduler=requestScheduler??createProviderScheduler({requestsPerMinute:()=>core.settings.chatRequestsPerMinute});
  const stopRequestScheduler=scheduleProviderRequests(fetchImpl,providerScheduler);
  const foregroundBusy=()=>foreground||injecting>0;

  const recordedErrors=new WeakSet(),diagnosticJobs=new Set(),transportRuns=new Map(),queuedRequests=new Map();
  // A normal generated reply can outlast a 30 s circuit. Keep repeated query
  // embedding timeouts from charging the next turn again before recovery.
  const rerankLane=createRecallLaneBackoff(),vectorLane=createRecallLaneBackoff({cooldownMs:120000});

  const stopTransportDiagnostics=observeProviderRequests(fetchImpl,event=>{
    const id=event.details.requestId;
    if(event.phase==='queued')queuedRequests.set(id,event.details);
    else if(['request','complete','failed','canceled'].includes(event.phase))queuedRequests.delete(id);
    if(activeSummaryOperation&&['summary','summary_verification','summary_narrative','summary_details','enum_repair','reference_repair','floor_repair','category_repair'].includes(event.details.purpose)){
      if(event.phase==='queued')summaryMonitor(activeSummaryOperation,{phase:'waiting'});
      else if(event.phase==='request')summaryMonitor(activeSummaryOperation,{phase:'composing'});
    }
    const waiting=queuedRequests.values().next().value;
    const notice=waiting?`${({summary:'总结',supplement:'辅助整理',assistant:'助手',dynamicPersona:'动态人设'})[waiting.modelRole]??'聊天请求'}：${waiting.reason==='queue_foreground'?'等待当前聊天回复结束':waiting.reason==='queue_busy'?'等待同一接口上一条请求完成':`接口${waiting.reason==='queue_rpm'?'每分钟限额已满':'异常后冷却'}，本次等待约 ${Math.max(1,Math.ceil(waiting.retryDelayMs/1000))} 秒`}；可停止等待`:'';
    if(state.requestQueueNotice!==notice){state.requestQueueNotice=notice;notify();}
    let run=transportRuns.get(id);
    if(!run){run=runtimeLog.start('transport',{requestId:id,purpose:event.details.purpose});transportRuns.set(id,run);}
    trackDiagnostic(run.then(runId=>runtimeLog.record({run:runId,task:'transport',...event})).finally(()=>{if(['complete','failed','canceled'].includes(event.phase))transportRuns.delete(id);}));
  });
  
  const stopErrorBoundary=installDiagnosticBoundary(host,(error,options)=>void reportError(error,options));
  
  const modules=createModuleController({host,core,state,load:loadApiSettings,getGlobal:()=>globalWorkspace,getChat:()=>workspace,check:assertCurrent,notify,refresh,changed:()=>recallChanged({vectors:true})});
  const personaWorldbook=createPersonaWorldbook({host,check:assertCurrent,context:()=>({scope:boundScope,epoch}),stageMode:()=>core.settings.dynamicPersonaMvuMode});
  const dynamicPersona=createDynamicPersona({settings:resolvedPersonaSettings,getWorkspace:()=>workspace,readRange:options=>core.readIndependentRange(options),historyTail:settledHistoryTail,historyState:localPersonaHistoryState,worldbook:personaWorldbook,client:()=>client('dynamicPersona'),reviewClient:()=>client('personaReview'),dictionary:()=>activeDictionary(),records:()=>state.records,log:logged,diagnostic:event=>runtimeLog.record(event),canRun:()=>!retrospectiveOperation&&!personaLaunch&&enabled&&!opening&&!followPending&&!following&&!state.stale&&!foregroundBusy()&&apiConnectionReady('dynamicPersona')&&host.document?.visibilityState!=='hidden',notify:value=>{state.dynamicPersona=value;notify();}});
  const resumeAutomaticTasks=()=>{if(host.document?.visibilityState==='hidden')return;queueAutomaticSummary();dynamicPersona.wake();};
  host.document?.addEventListener?.('visibilitychange',resumeAutomaticTasks);host.addEventListener?.('online',resumeAutomaticTasks);

  const memoryMutationKey=()=>boundScope?stableStringify(boundScope):null;
  
  const pendingMemoryMutation=()=>Object.assign(new Error('记忆删除或恢复的存储结果尚未确认，请稍后刷新重试'),{code:'PERSISTENCE_ERROR',details:{reason:'storage_write',storageStage:'unknown',storageArtifact:'memory',operationPending:true,modelRequested:false}});

  const viewIdentities=new WeakMap();let nextViewIdentity=0;
  const viewIdentity=value=>{if(!value||typeof value!=='object')return value;if(!viewIdentities.has(value))viewIdentities.set(value,++nextViewIdentity);return viewIdentities.get(value);};
  // UI-only projection cache. Worker scheduling still rereads its normal
  // planning path; visible log/progress ticks must not rescan record bodies.
  let viewPlanCache=null;

  const resumeVectorMaintenance=()=>{if(host.document?.visibilityState==='hidden'||host.navigator?.onLine===false){clearTimeout(vectorTimer);vectorTimer=null;vectorJob?.cancel();}else wakeVectors();};
  host.document?.addEventListener?.('visibilitychange',resumeVectorMaintenance);
  host.addEventListener?.('online',resumeVectorMaintenance);host.addEventListener?.('offline',resumeVectorMaintenance);

  const moduleStamp=m=>({id:m.id??m.messageId??m.uuid,text:m.text??m.mes??m.content??'',swipe:m.swipe_id??m.swipeId,version:m.version,role:m.role??m.name,isUser:m.is_user,isSystem:m.is_system});

  const summaryRecipeHash=()=>sha256([core.settings.recordingRules,core.settings.summaryPresets,core.settings.narrativeExtraction,...(core.settings.summaryCurrentOnly?[true]:[])]);
  const replacementEditsHash=(ids,controls={})=>sha256(ids.map(id=>[id,controls.edits?.[id],controls.deletedRecords?.[id]]));
  const overwriteHash=plan=>sha256([plan.ranges,plan.affected.map(b=>[b.id,savedBatchOperation(b)]),plan.excludeOperations]);

  const personDeleteFailure=(reason,cause)=>Object.assign(cause instanceof Error?cause:new Error('人物删除未完成'),{
    code:cause?.code??'OPERATION_FAILED',details:{...cause?.details,action:'deletePerson',reason,stage:['person_delete_storage','person_delete_partial'].includes(reason)?'storage':'validate',modelRequested:false}});
  const keepsakeSourceCard=id=>state.cards.flatMap(c=>c.mergedParts?.length?c.mergedParts:[c]).find(c=>c.id===id);

  /** Keep the saved 起算楼层 in step with what is actually recorded: after a save
   * (including 补缺口) every floor from the current start onwards that is already
   * covered moves the start floor up, so the next cycle never re-plans them and
   * the settings panel shows the real point. Deleting a batch below the start
   * point rolls it back to the first deleted floor, so the old automatic
   * behaviour (deleted coverage becomes pending again) still holds. It only ever
   * moves past floors a saved batch covers, or back onto a deleted one. */

  const vectorBudgetMs=()=>Math.max(100,Number(core.settings.vectorTimeoutMs)||4000);
  const rerankBudgetMs=()=>Math.max(100,Number(core.settings.rerankTimeoutMs)||4000);
  
  // Explicit rebuilds and bounded background batch maintenance share one path.

  // Main-card commands use the same persisted manual worker, never hidden UI
  // drafts. Coalesce clicks and reserve scheduling while a plan is prepared.

  // 补一批 / 检查进度 / 立刻处理：包到 logged('summary', ...) 里，
  // 这样按钮点击会立即产生一条「开始 / 完成 / 失败」的运行日志记录，
  // UI 反馈也由 run() 的 feedback 链路驱动，不会再「按了没反应」。
  return createApiService(createServiceScope(contracts.api, services, applicationBindings));
}
