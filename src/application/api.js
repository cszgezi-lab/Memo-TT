import {createProjectDiagnostics,readDiagnosticChat} from '../project-diagnostics.js';
import {PRODUCT_VERSION} from '../product-release.js';
import { narrativePreview } from '../narrative-reading.js';
import { updateDictionaryOverride } from '../product-dictionary.js';
import { clone } from '../utils.js';
import { persistedProductSettings } from '../product-settings.js';
import { documentPartKey } from '../product-workspace.js';
import { credentialOrigin } from '../product-credentials.js';
import { lazyViewState } from '../product-view-scheduling.js';

/** api orchestration. Dependencies are limited by service-contracts.js. */
export function createApiService(appScope) {
const application={previewSummary: appScope.previewSummary,splitSummaryBatch:(...args)=>appScope.logged('summary',()=>appScope.splitSummaryBatch(...args)),previewApplySummaryPrefix: appScope.previewApplySummaryPrefix,applySummaryPrefix:(...args)=>appScope.logged('summary',()=>appScope.applySummaryPrefix(...args)),saveCharacterKeepsake: appScope.saveCharacterKeepsake,editPersonProfile: appScope.editPersonProfile,catchUpAutomatic:()=>appScope.summarize({missingOnly:true,fullBatchesOnly:true}),inspectAutomaticProgress:()=>appScope.logged('summary',async run=>{await appScope.inspectAutomaticProgress();appScope.runtimeLog.record({run,task:'summary',phase:'complete',level:'success',details:{}});return {batches:0};}),setAutoStartFloor: appScope.setAutoStartFloor,setAutomatic: appScope.setAutomatic,processAutomatic:()=>appScope.logged('summary',run=>appScope.autoSummary({force:true})),deleteRecords: appScope.deleteRecords,retryBatch: appScope.retryBatch,retryIncompleteBatches: appScope.retryIncompleteBatches,core: appScope.core,retryMerges: appScope.retryMerges,keepMergeSeparate: appScope.keepMergeSeparate,chooseMergeTarget: appScope.chooseMergeTarget,saveModule:appScope.modules.save,editModuleRecord:appScope.modules.editRecord,archiveModule:appScope.modules.archive,proposeModule:appScope.modules.propose,inspectMvu:appScope.modules.inspect,syncModules:async()=>{appScope.assertCurrent();await appScope.refresh();return {status:appScope.state.mvuStatus};},rememberModule:appScope.modules.remember,exportModules:appScope.modules.exportDefinitions,importModules:appScope.modules.importDefinitions,get state(){return appScope.publicState();},loadApiSettings: appScope.loadApiSettings,open: appScope.open,refresh: appScope.refresh,saveSettings: appScope.saveSettings,saveApi: appScope.saveApi,forgetKey: appScope.forgetKey,summarize: appScope.summarize,regenerateBatch: appScope.regenerateBatch,manageBatches: appScope.manageBatches,deleteBatch: appScope.deleteBatch,editRecord: appScope.editRecord,deleteRecord: appScope.deleteRecord,restoreBatch: appScope.restoreBatch,restoreRecord: appScope.restoreRecord,removeDocument: appScope.removeDocument,applyProposal: appScope.applyProposal,undoSettings: appScope.undoSettings,newConversation: appScope.newConversation,selectConversation: appScope.selectConversation,deleteConversation: appScope.deleteConversation,hideRecord: appScope.hideRecord,restoreHidden: appScope.restoreHidden,stop: appScope.stop,disable: appScope.disable,
    inspectDynamicPersona:()=>appScope.logged('persona',async run=>{await appScope.dynamicPersona.load();const result=await appScope.dynamicPersona.inspect();appScope.runtimeLog.record({run,task:'persona',phase:'complete',level:'success',details:{}});return result;}),
    queueDynamicPersona: appScope.queueDynamicPersona,
    retryDynamicPersonaManualBatch: appScope.retryDynamicPersonaManualBatch,
    splitDynamicPersonaManualBatch:options=>appScope.logged('persona',()=>appScope.manageDynamicPersonaCandidate('splitManualBatch',options)),
    previewDynamicPersonaManualPrefix:options=>appScope.manageDynamicPersonaCandidate('previewApplyManualPrefix',options),
    applyDynamicPersonaManualPrefix:options=>appScope.logged('persona',()=>appScope.manageDynamicPersonaCandidate('applyManualPrefix',options)),
    processDynamicPersona:async()=>appScope.reservePersonaCommand(()=>appScope.logged('persona',async run=>{appScope.assertNoRetrospective();await appScope.dynamicPersona.load();appScope.assertNoRetrospective();return appScope.dynamicPersona.process({force:true,retry:true});})),pauseDynamicPersona:()=>{appScope.personaCommandVersion++;return appScope.logged('persona',()=>appScope.dynamicPersona.pause());},setDynamicPersonaStart:floor=>appScope.dynamicPersona.setStart(floor),editDynamicPersona:(id,patch)=>appScope.dynamicPersona.edit(id,patch),setPersonCasting:(name,patch)=>appScope.dynamicPersona.setCasting(name,patch),setPersonDirectives:(name,lines)=>appScope.dynamicPersona.setDirectives(name,lines),draftPersonDirectives:(name,instruction)=>appScope.logged('persona',()=>appScope.dynamicPersona.draftPersonDirectives(name,instruction)),draftDynamicPersonaDirectives:(id,instruction)=>appScope.logged('persona',()=>appScope.dynamicPersona.draftDirectives(id,instruction)),bindDynamicPersona:(name,targetId)=>appScope.dynamicPersona.bind(name,targetId),mergeDynamicPersona:(sourceId,targetId)=>appScope.dynamicPersona.merge(sourceId,targetId),undoDynamicPersona:id=>appScope.dynamicPersona.undo(id),addDynamicPersona:(name,text)=>appScope.dynamicPersona.add(name,text),
    previewDynamicPersonaManual:async options=>{await appScope.dynamicPersona.load();return appScope.dynamicPersona.previewManual(options);},
    readNarrativeSource: appScope.readNarrativeSource,
    async previewNarrativeExtraction({text,floor,config=appScope.core.settings.narrativeExtraction}={}){
      try{
        if(typeof text==='string')return narrativePreview({id:'local-preview',text},config);
        const source=await appScope.readNarrativeSource({floor});return {...narrativePreview(source,config),floor};
      }catch(error){if(error?.code==='NARRATIVE_REGEX_INVALID')error.details={...error.details,modelRequested:false};throw error;}
    },
    startDynamicPersonaManual:async options=>appScope.reservePersonaCommand(()=>appScope.logged('persona',async run=>{appScope.assertNoRetrospective();if(!appScope.enabled)throw new Error('插件已暂停，请先启用插件，再开始手动人设补建');await appScope.dynamicPersona.load();await appScope.dynamicPersona.createManual(options);await appScope.saveSettings({dynamicPersonaEnabled:true});return appScope.dynamicPersona.resumeManual();})), 
    continueDynamicPersonaManual:async()=>appScope.reservePersonaCommand(()=>appScope.logged('persona',async run=>{appScope.assertNoRetrospective();if(!appScope.enabled)throw new Error('插件已暂停，请先启用插件，再继续手动人设补建');await appScope.dynamicPersona.load();if(['paused','running','failed'].includes(appScope.dynamicPersona.state.manualPlan?.status))await appScope.saveSettings({dynamicPersonaEnabled:true});return appScope.dynamicPersona.resumeManual();})), 
    pauseDynamicPersonaManual:()=>{appScope.personaCommandVersion++;return appScope.logged('persona',()=>appScope.dynamicPersona.pauseManual());},
    discardDynamicPersonaManual:options=>appScope.logged('persona',()=>appScope.dynamicPersona.discardManual(options)),
    inspectDynamicPersonaWorldbook:()=>appScope.logged('persona',()=>appScope.dynamicPersona.inspectWorldbook()),
    retryDynamicPersonaReview:()=>appScope.logged('persona',()=>appScope.dynamicPersona.retryReview()),
    previewDeleteDynamicPersonaBatch:options=>appScope.dynamicPersona.previewDeleteBatch(options),
    deleteDynamicPersonaBatch:options=>appScope.logged('persona',()=>appScope.dynamicPersona.deletePersonaBatch(options)),
    restoreDynamicPersonaBatch:()=>appScope.logged('persona',()=>appScope.dynamicPersona.restorePersonaBatch()),
    previewDynamicPersonaReview:options=>appScope.dynamicPersona.previewReview(options),
    startDynamicPersonaReview:options=>appScope.logged('persona',()=>appScope.dynamicPersona.startReview(options)),
    manageDynamicPersonaReview:(action,id)=>appScope.logged('persona',()=>appScope.dynamicPersona.manageReview(action,id)),
    applyDynamicPersonaReview:()=>appScope.logged('persona',()=>appScope.dynamicPersona.applyReview()),
    dynamicPersonaReviewMarkdown:()=>appScope.dynamicPersona.reviewMarkdown(),
    setDynamicPersonaPartHistorical:(id,key,value)=>appScope.dynamicPersona.setPartHistorical(id,key,value),
    syncDynamicPersonaWorldbook:()=>appScope.logged('persona',async()=>{await appScope.dynamicPersona.inspectWorldbook();return appScope.dynamicPersona.syncMirror();}),
    async setDynamicPersona(enabledNow){await appScope.saveSettings({dynamicPersonaEnabled:enabledNow});if(!enabledNow)appScope.dynamicPersona.stop();else {if(!appScope.workspace?.isCurrent())await appScope.open({enable:appScope.enabled});await appScope.dynamicPersona.load();await appScope.dynamicPersona.resume();}},
    async setFeature(kind,value){
      if(!['memory','persona'].includes(kind)||typeof value!=='boolean')throw new Error('未知功能开关');
      if(value&&kind==='memory'&&appScope.active)throw new Error('请等当前任务结束后启用自动总结');
      if(value&&(!appScope.enabled||!appScope.workspace?.isCurrent()||!appScope.bindings.length))await appScope.open({enable:true});
      if(kind==='memory'){await appScope.setAutomatic(value);await appScope.saveSettings({injectionEnabled:value});}
      else {await appScope.saveSettings({dynamicPersonaEnabled:value});if(value){await appScope.dynamicPersona.load();await appScope.dynamicPersona.resume();}}
      return {message:`${kind==='memory'?'记忆功能':'动态人设'}已${value?'启用':'关闭'}；已有记录保留`,level:'success'};
    },
    startChatTracking: appScope.startChatTracking,followCurrentChat: appScope.followCurrentChat,reviewMemory: appScope.reviewMemory,previewQuality: appScope.previewQuality,inspectQualityRecord: appScope.inspectQualityRecord,saveQualityRecord: appScope.saveQualityRecord,undoQuality: appScope.undoQuality,readViewState: appScope.readViewState,
    reviewMemoryConsistency: appScope.reviewMemoryConsistency,stopMemoryConsistency:()=>appScope.retrospectiveOperation?.abort(),undoMemoryConsistency: appScope.undoMemoryConsistency,
    reportError: appScope.reportError,loadRuntimeLog:()=>appScope.runtimeLog.load(),exportRuntimeLog:async options=>{const snapshot=await appScope.runtimeLog.export(options);return {...snapshot,pendingDiagnostics:appScope.diagnosticJobs.size};},clearRuntimeLog:async()=>{await appScope.flushDiagnostics();return appScope.runtimeLog.clear();},
    async exportProjectDiagnostics(){
      const token=appScope.epoch;appScope.assertCurrent(token);const scope=clone(appScope.boundScope),check=()=>appScope.assertCurrent(token);
      return createProjectDiagnostics({version:PRODUCT_VERSION,check,readBackup:()=>application.exportBackup(),
        readWorkspace:async()=>({batches:await appScope.workspace.read('summary-batches',[]),autoProgress:await appScope.workspace.read('auto-progress',null),automatic:clone(application.state.automatic),summaryHold:clone(appScope.state.summaryHold),status:appScope.state.status}),
        readChat:()=>readDiagnosticChat(appScope.hostAdapter,scope,check),readRuntimeLog:()=>application.exportRuntimeLog(),readInjections:()=>application.exportRecentRecall()});
    },
    async exportInjectionLog(options){appScope.assertCurrent();return appScope.injectionLog.export(options);},
    async exportRecentRecall(){const token=appScope.epoch;appScope.assertCurrent(token);const data=await appScope.injectionLog.exportRecentRecall();appScope.assertCurrent(token);return data;},
    async clearInjectionLog(){appScope.assertCurrent();await appScope.injectionLog.clear();},
    async removeInjectionLog(id){appScope.assertCurrent();await appScope.injectionLog.remove(id);},
    async saveDictionaryEntry(input){await appScope.loadApiSettings();let aliases=appScope.core.settings.aliases;
      if(input.originalName&&input.originalName!==input.name)aliases=updateDictionaryOverride(aliases,{name:input.originalName,deleted:true});
      await appScope.saveSettings({aliases:updateDictionaryOverride(aliases,input)});appScope.setMessage('字典校正已保存，不会修改故事事实');},
    testConnection:(kind='summary',patch={})=>appScope.logged('connection',()=>appScope.testConnection(kind,patch),{modelRole:kind}),
    listModels:(kind,options)=>appScope.logged('models',()=>appScope.listModels(kind,options),{modelRole:kind}),
    assistant:input=>appScope.logged('assistant',()=>appScope.assistant(input)),
    updateDocument: appScope.updateDocument,documentPreview: appScope.documentPreview,editDocumentChunk: appScope.editDocumentChunk,buildKnowledgeVectors:ids=>appScope.logged('knowledge-vectors',run=>appScope.buildKnowledgeVectors(ids,run)),
    analyzeDocuments:ids=>appScope.logged('knowledge',()=>appScope.analyzeDocuments(ids)),
    buildVectors:(options)=>appScope.logged('vectors',run=>appScope.buildVectors({...options,diagnosticRun:run})),
    retryVectors:(ids=null)=>appScope.logged('vectors',run=>appScope.buildVectors({ids,diagnosticRun:run})),retryBatchVectors: appScope.retryBatchVectors,
    refreshVectorStatus: appScope.refreshVectorStatus,
    listVectorEntries: appScope.listVectorEntries,
    excludeVector: appScope.excludeVector,
    addDocument:input=>appScope.logged('import',()=>appScope.addDocument(input)),
    preview:(...args)=>appScope.logged('recall',()=>appScope.preview(...args)),
    async remember(text,people='',options={}){appScope.assertCurrent();await appScope.core.remember(text,{people,...options});await appScope.refresh();appScope.setMessage('记事已保存');},
    get draftContext(){return `global:${appScope.state.conversationId}`;},
    async exportGlobalBackup(){await appScope.loadApiSettings();return {kind:'shiyi-global-backup',version:1,modules:clone(appScope.state.modules),settings:persistedProductSettings(appScope.core.settings),documents:await Promise.all(appScope.state.documents.map(async d=>({...d,parts:await Promise.all(Array.from({length:d.chunks},(_,i)=>appScope.globalWorkspace.read(documentPartKey(d,i)))),analysis:await appScope.globalWorkspace.read(documentPartKey(d,'analysis'),[])}))),conversations:await Promise.all(appScope.state.conversations.map(async c=>({...c,messages:await appScope.globalWorkspace.read(`assistant-${c.id}`,[])})))};},
    async setDraft(value,context=`global:${appScope.state.conversationId}`){await appScope.loadApiSettings();if(context!==`global:${appScope.state.conversationId}`)return;appScope.state.draft=value;await appScope.saveUi();},
    setKey(kind,value,endpoint){if(!Object.hasOwn(appScope.keys,kind))throw new Error('未知连接');appScope.keyEdited.add(kind);appScope.keyVersions[kind]=(appScope.keyVersions[kind]??0)+1;appScope.keys[kind]=String(value??'');appScope.keyOrigins[kind]=credentialOrigin(endpoint??appScope.core.settings[`${appScope.prefixFor(kind)}Endpoint`]);if(kind==='summary')appScope.core.setSessionCredential(appScope.effectiveKeys().summary);if(['embedding','rerank'].includes(kind))appScope.recallChanged({vectors:true,scheduleVectors:false});},
    exportSettings(){return {kind:'shiyi-config',version:1,modules:clone(appScope.state.modules),settings:persistedProductSettings(appScope.core.settings)};},
    async exportBackup(options={}){appScope.assertCurrent();const assistantLimit=Number.isFinite(options.assistantLimit)?Math.max(0,Math.floor(options.assistantLimit)):null;const assistant=assistantLimit==null?appScope.state.history:appScope.state.history.slice(-assistantLimit);return {kind:'shiyi-backup',version:1,scope:appScope.boundScope,modules:clone(appScope.state.modules),moduleSnapshots:clone(appScope.state.moduleSnapshots),eventMergeDecisions:clone(appScope.mergeDecisions),settings:persistedProductSettings(appScope.core.settings),memory:await appScope.core.readMemoryView(),documents:await Promise.all(appScope.state.documents.map(async d=>({...d,parts:await Promise.all(Array.from({length:d.chunks},(_,i)=>appScope.globalWorkspace.read(documentPartKey(d,i))))}))),assistant};},
    async dispose(){appScope.disposed=true;clearTimeout(appScope.stopForceTimer);appScope.stopForceTimer=null;appScope.host.document?.removeEventListener?.('visibilitychange',appScope.resumeAutomaticTasks);appScope.host.removeEventListener?.('online',appScope.resumeAutomaticTasks);await appScope.dynamicPersona.dispose();appScope.host.document?.removeEventListener?.('visibilitychange',appScope.resumeVectorMaintenance);appScope.host.removeEventListener?.('online',appScope.resumeVectorMaintenance);appScope.host.removeEventListener?.('offline',appScope.resumeVectorMaintenance);appScope.tracking=false;clearTimeout(appScope.followTimer);appScope.followTimer=null;appScope.followPending=false;for(const off of [...appScope.chatListeners.splice(0),...appScope.generationListeners.splice(0)]){try{await off();}catch{}}await appScope.disable();await appScope.injectionLog?.flush();appScope.epoch++;await appScope.core.dispose();appScope.stopRequestScheduler();appScope.stopTransportDiagnostics();appScope.stopErrorBoundary();for(const resolve of appScope.followWaiters.splice(0))resolve(appScope.publicState());await appScope.flushDiagnostics();await appScope.hostAdapter?.dispose?.();},
  };
  application.deletePerson=appScope.deletePerson;
  application.readBatchRecords=id=>clone(appScope.state.batches.find(batch=>batch.id===id)?.records??{});
  application.refresh=async(...args)=>{
    const view=await appScope.refresh(...args);
    // Internal owned projections share unchanged rows. External consumers get
    // isolated fields when requested, without an unused full clone on a click.
    return lazyViewState(Object.fromEntries(Object.keys(view??{}).map(key=>[key,()=>clone(view[key])])));
  };
  const exportRawBackup=application.exportBackup;
  application.exportBackup=async(options={})=>{const token=appScope.epoch,backup=await exportRawBackup(options);appScope.assertCurrent(token);return {...backup,dynamicPersona:appScope.dynamicPersona.export(),qualityReview:clone(appScope.qualitySaved),memoryRetrospective:clone(appScope.retrospectiveSaved),effectiveRecords:clone(appScope.state.records)};};
  // One failure boundary for all public actions, including manual edits, DIY,
  // import/export and settings; keep their sync/async return contracts intact.
  for(const [name,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(application))){
    const fn=descriptor.value;if(typeof fn!=='function'||['reportError','exportRuntimeLog','clearRuntimeLog','loadRuntimeLog','dispose'].includes(name))continue;
    application[name]=function(...args){
      const failed=error=>{void appScope.reportError(error,{stage:'ui',action:name});throw error;};
      try{const result=fn.apply(this,args);return result&&typeof result.then==='function'?result.catch(failed):result;}catch(error){return failed(error);}
    };
  }
  return application;


}
