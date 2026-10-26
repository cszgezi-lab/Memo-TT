import { mvuContext } from '../product-custom-modules.js';
import { retrospectiveState } from '../product-memory-retrospective-controller.js';
import { stableStringify } from '../utils.js';
import { failureText } from '../product-feedback.js';
import { HostAdapter } from '../host-adapter.js';
import { createWorkspace } from '../product-workspace.js';
import { createInjectionLog } from '../product-injection-log.js';
import { sceneRecallQuery, auxiliaryInjectionReason, injectionTiming } from '../product-recall-packing.js';
import { PROMPT_KEY } from './shared.js';

/** lifecycle orchestration. Dependencies are limited by service-contracts.js. */
export function createLifecycleService(appScope) {
async function personaPromptManager() {
    const exposed=appScope.host.promptManager??mvuContext(appScope.host)?.promptManager;
    if(exposed)return exposed;
    if(typeof appScope.host.document?.createElement!=='function')return null;
    // Read the already-loaded host singleton. Optional capability: an older
    // host keeps its original card fields when no provenance hook is available.
    appScope.personaPromptModule??=import('/scripts/openai.js').catch(()=>null);
    return (await appScope.personaPromptModule)?.promptManager??null;
  }

function bindGenerationLifecycle(){
    if(appScope.generationListeners.length)return;
    for(const name of ['GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED']){
      try{appScope.generationListeners.push(appScope.hostAdapter.subscribe(name,(_type,_options,dryRun)=>{if(dryRun!==true)markForeground(name==='GENERATION_STARTED');}));}catch{/* Injection has its own guard on older hosts. */}
    }
  }

function markForeground(value){
    appScope.foreground=value;appScope.state.foregroundBusy=value;appScope.providerScheduler.setForeground?.(appScope.foregroundBusy());appScope.notify();
    if(value){clearTimeout(appScope.followTimer);appScope.followTimer=null;appScope.vectorJob?.cancel();appScope.dynamicPersona.interruptReview();appScope.retrospectiveOperation?.abort();
      if(appScope.following&&appScope.opening){appScope.followVersion++;appScope.followPending=true;appScope.active?.abort();}
    }
    else {wakeChatFollower();appScope.queueAutomaticSummary();appScope.dynamicPersona.wake();appScope.wakeVectors();}
  }

async function clearPrompt() { try { await appScope.hostAdapter?.setExtensionPrompt?.(PROMPT_KEY, '', 1, 1, false, 0); } catch { /* capability reported at enable */ } }

async function stopListeners() { for (const off of appScope.bindings.splice(0)) { try { await off(); } catch { /* tracked by host */ } } }

function emptyChatView(status='loading'){
    appScope.sourcePrefixVerified=false;
    appScope.retrospectiveOperation?.abort();appScope.retrospectiveSaved=null;appScope.state.memoryRetrospective=retrospectiveState(null);
    appScope.dynamicPersona.clear();
    appScope.state.summaryHold=null;
    appScope.workspace=null;appScope.boundScope=null;appScope.boundRefKey=null;appScope.moduleSourceBaseline=null;appScope.modules.clear();
    appScope.qualitySaved={};appScope.preparedQuality=null;Object.assign(appScope.state,{rawRecords:{},memoryControls:{},quality:null,qualityPlan:null,qualityProgress:'',cards:[],records:{},batches:[],deletedRecords:[],hidden:[],savedThrough:-1,autoStartFloor:1,autoLastIndex:null,sourceStatus:null,progress:'',preview:null,actual:null,status,stale:status==='loading'});
    appScope.recallChanged({clear:true});
  }

function wakeChatFollower(){
    if(!appScope.tracking||appScope.disposed||!appScope.followPending||appScope.followTimer!==null||appScope.following||appScope.active||appScope.opening||appScope.foregroundBusy())return;
    // TT emits CHAT_CHANGED while completing its own UI work. Do not block
    // that emitter or bind to an intermediate ref inside its callback.
    appScope.followTimer=setTimeout(()=>{appScope.followTimer=null;void runChatFollower();},Math.max(0,appScope.followNotBefore-Date.now()));
  }

function requestChatFollow({content=false,retryDelay=0}={}){
    if(appScope.disposed)return;
    if(!retryDelay)appScope.followReadAttempts=0;
    appScope.followNotBefore=retryDelay?Date.now()+retryDelay:content?Date.now()+100:0;clearTimeout(appScope.followTimer);appScope.followTimer=null;
    appScope.followVersion++;appScope.followPending=true;wakeChatFollower();
  }

async function runChatFollower(){
    if(appScope.disposed||!appScope.tracking||appScope.active||appScope.opening||appScope.following||appScope.foregroundBusy())return;
    const version=appScope.followVersion;appScope.followPending=false;
    appScope.following=(async()=>{
      try{
        const target=await appScope.hostAdapter.currentRef();
        if(appScope.disposed||version!==appScope.followVersion)return;
        if(appScope.foregroundBusy()){appScope.followPending=true;return;}
        if(!target){await stopListeners();emptyChatView('no_chat');await clearPrompt();const text='打开一段聊天后，会自动加载对应记忆和总结批次';appScope.state.feedback={id:++appScope.feedbackSequence,kind:'chat',level:'info',text};appScope.setMessage(text);return;}
        if(appScope.workspace?.isCurrent()&&!appScope.state.stale&&appScope.boundRefKey===stableStringify(target)&&(appScope.core.readViewState?.()??appScope.core.state).status!=='invalidated')return;
        await open({enable:appScope.enabled,expectedRef:target,passive:true});
        appScope.followReadAttempts=0;
      }catch(error){
        if(appScope.disposed||version!==appScope.followVersion)return;
        if(error?.code==='CHAT_CHANGED'){requestChatFollow();return;}
        if(error?.code==='HISTORY_UNAVAILABLE'&&++appScope.followReadAttempts<=3){requestChatFollow({retryDelay:[250,750,1500][appScope.followReadAttempts-1]});return;}
        if(error?.code!=='CANCELED'){
          void appScope.reportError(error,{task:'background',stage:'background'});
          const text=`当前聊天记忆加载未完成：${failureText(error)}`;
          appScope.state.feedback={id:++appScope.feedbackSequence,kind:'chat',level:'warning',text};appScope.setMessage(text);
        }
      }
    })();
    try{await appScope.following;}finally{
      appScope.following=null;
      if(appScope.followPending&&!appScope.disposed)wakeChatFollower();
      else {for(const resolve of appScope.followWaiters.splice(0))resolve(appScope.publicState());appScope.queueAutomaticSummary();appScope.dynamicPersona.wake();}
    }
  }

async function startChatTracking(){
    if(appScope.disposed)return;
    if(appScope.trackingStart)return appScope.trackingStart;
    appScope.trackingStart=(async()=>{
      await appScope.loadApiSettings();appScope.hostAdapter??=new HostAdapter(appScope.host);await appScope.hostAdapter.ready?.();if(appScope.disposed)return;
      bindGenerationLifecycle();appScope.tracking=true;
      for(const name of ['CHAT_CHANGED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_SWIPE_DELETED','MESSAGE_RECEIVED']){
        try{appScope.chatListeners.push(appScope.hostAdapter.subscribe(name,()=>{
          if(appScope.disposed)return;
          if(name==='MESSAGE_RECEIVED'){
            if(!appScope.workspace?.isCurrent()||appScope.state.stale)requestChatFollow({content:true});
            else if(!sourceEventRelevant(name))rememberModuleSources();
            return;
          }
          if(name==='MESSAGE_UPDATED'&&moduleMetadataOnly()){void appScope.syncModulesQuietly();return;}
          if(!sourceEventRelevant(name)){rememberModuleSources();appScope.queueAutomaticSummary();appScope.dynamicPersona.wake();return;}
          invalidate(name);requestChatFollow({content:name!=='CHAT_CHANGED'});
        }));}catch{/* Opening the panel still verifies the current ref. */}
      }
      requestChatFollow();
    })();
    try{await appScope.trackingStart;}catch(error){appScope.trackingStart=null;throw error;}
  }

async function followCurrentChat(){
    await startChatTracking();if(appScope.disposed)return appScope.publicState();
    requestChatFollow();return new Promise(resolve=>{appScope.followWaiters.push(resolve);wakeChatFollower();});
  }

function rememberModuleSources(){
    const context=mvuContext(appScope.host),chat=context?.chat;
    appScope.moduleSourceBaseline=Array.isArray(chat)?chat.map(appScope.moduleStamp):null;
    try{const id=context?.getCurrentChatId?.();appScope.moduleSourceChatId=typeof id==='string'&&id?id:null;}catch{appScope.moduleSourceChatId=null;}
  }

function sourceEventRelevant(reason){
    if(reason==='CHAT_CHANGED'){
      // TT also emits CHAT_CHANGED after API/regex display refreshes. Its
      // native ref getter is synchronous (TT 2.2); keep the binding only when
      // the complete native identity and the protected raw prefix still match.
      // Unknown/async references and partial contexts retain the reload path.
      if(!appScope.sourceContextComplete)return true;
      try{const current=appScope.host.__TAURITAVERN__?.api?.chat?.current,ref=current?.ref?.call(current);if(!ref||typeof ref.then==='function'||stableStringify(ref)!==appScope.boundRefKey)return true;}
      catch{return true;}
    }
    if(reason==='MESSAGE_UPDATED'&&moduleMetadataOnly())return false;
    // The native context gives the complete live chat. Compare exact source
    // stamps, never infer a deletion position from MESSAGE_DELETED's new count.
    // Only an untouched prefix beyond every saved/planned source can retain the
    // binding; unknown/partial contexts keep the conservative reload path.
    if(appScope.state.stale||!appScope.workspace?.isCurrent()||!appScope.sourcePrefixVerified||!appScope.moduleSourceBaseline||appScope.moduleSourceChatId===null)return true;
    let context;try{context=mvuContext(appScope.host);if(context?.getCurrentChatId?.()!==appScope.moduleSourceChatId)return true;}catch{return true;}
    const chat=context?.chat;if(!Array.isArray(chat))return true;
    if(reason==='CHAT_CHANGED'&&chat.length!==appScope.moduleSourceBaseline.length)return true;
    const persona=appScope.state.dynamicPersona??{};
    const ends=[appScope.core.sourceEndIndex,...appScope.state.batches.map(b=>b.endIndex),...(persona.batches??[]).map(b=>b.endIndex),...(persona.manualPlan?.items??[]).map(b=>b.endIndex),...(persona.profiles??[]).map(p=>p.through)];
    if(!Number.isInteger(ends[0]))return true;
    const through=Math.max(-1,...ends.filter(Number.isSafeInteger));
    if(appScope.moduleSourceBaseline.length<=through||chat.length<=through)return true;
    for(let i=0;i<=through;i++){
      const old=appScope.moduleSourceBaseline[i],next=appScope.moduleStamp(chat[i]);
      if(Object.keys(old).some(k=>old[k]!==next[k]))return true;
    }
    return false;
  }

async function settledHistoryTail(){
    const context=mvuContext(appScope.host),chat=context?.chat;
    if(!appScope.sourceContextComplete||!Array.isArray(chat)||context?.getCurrentChatId?.()!==appScope.moduleSourceChatId)return appScope.core.historyTail();
    const tail=await appScope.core.historyTail({includeMessage:true}),raw=chat.at(-1);
    if(tail.totalCount!==chat.length||!raw||tail.message.text!==String(raw.text??raw.mes??raw.content??'')||tail.message.version!==(raw.version??raw.swipeId??raw.swipe_id??0))throw Object.assign(new Error('TT 尚未保存本次回复，稍后重读；已有结果保留'),{code:'HISTORY_UNAVAILABLE',details:{stage:'prepare',reason:'history_save_pending'}});
    return tail.index;
  }

function localPersonaHistoryState(){
    // Eligibility only: actual dispatch still verifies the persisted tail.
    const context=mvuContext(appScope.host);
    if(!appScope.sourceContextComplete||appScope.state.stale||!appScope.workspace?.isCurrent()||context?.getCurrentChatId?.()!==appScope.moduleSourceChatId||!Array.isArray(context.chat))return null;
    return {lastIndex:context.chat.length-1};
  }

function moduleMetadataOnly(){
    if(!appScope.state.modules.some(m=>m.mode==='mvu'&&m.enabled&&!m.archived)||!appScope.moduleSourceBaseline?.length||appScope.state.stale)return false;
    const chat=mvuContext(appScope.host)?.chat;
    return Array.isArray(chat)&&chat.length>=appScope.moduleSourceBaseline.length&&appScope.moduleSourceBaseline.every((old,i)=>{const next=appScope.moduleStamp(chat[i]);return Object.keys(old).every(k=>old[k]===next[k]);});
  }

function invalidate(reason) {
    appScope.sourcePrefixVerified=false;
    if(reason==='CHAT_CHANGED')appScope.sourceContextComplete=false;
    if(reason==='CHAT_CHANGED'){appScope.foreground=false;appScope.state.foregroundBusy=false;appScope.providerScheduler.setForeground?.(appScope.injecting>0);appScope.autoFailureRange='';appScope.autoFailureCount=0;}
    appScope.dynamicPersona.clear();
    appScope.epoch++; appScope.abortAll(); appScope.moduleSourceBaseline=null;appScope.modules.clear();appScope.state.cards=appScope.state.cards.filter(c=>!c.readonly);appScope.state.stale = true; appScope.state.preview = null; appScope.state.actual = null;
    appScope.recallChanged({ clear: true });
    if(appScope.tracking){emptyChatView();appScope.state.feedback={id:++appScope.feedbackSequence,level:'info',text:'正在加载当前聊天的记忆和总结批次…'};}
    clearPrompt(); appScope.state.status = appScope.tracking?'loading':'stale'; appScope.setMessage(appScope.tracking?'正在加载当前聊天的记忆和总结批次…':reason === 'CHAT_CHANGED' ? '聊天已切换；开始总结时会自动读取当前聊天' : '正文已修改，旧记忆已暂停注入；重新整理相关范围后恢复');
  }

async function open({enable = true, expectedRef, passive=false} = {}) {
    if (appScope.active || appScope.opening) throw new Error('请先停止当前任务');
    appScope.opening = true;appScope.vectorStopped=false;
    const opener=new AbortController(), version=appScope.cancelVersion;
    appScope.operations.add(opener); appScope.active=opener;
    const checkOpen=()=>{if(opener.signal.aborted||version!==appScope.cancelVersion)throw Object.assign(new Error('聊天加载已取消'),{code:'CANCELED'});};
    try {
    await appScope.loadApiSettings();checkOpen();
    appScope.hostAdapter ??= new HostAdapter(appScope.host);bindGenerationLifecycle();
    const target=expectedRef??await appScope.hostAdapter.currentRef();checkOpen();
    if(!target)throw Object.assign(new Error('TT 当前没有打开聊天'),{code:'CHAT_REF_UNAVAILABLE'});
    const targetKey=stableStringify(target);
    const checkTarget=async()=>{const current=await appScope.hostAdapter.currentRef();checkOpen();if(stableStringify(current)!==targetKey)throw Object.assign(new Error('读取期间聊天已切换'),{code:'CHAT_CHANGED'});};
    await checkTarget();
    await stopListeners(); checkOpen(); await clearPrompt(); checkOpen();
    appScope.hostAdapter ??= new HostAdapter(appScope.host);
    appScope.workspace=null;appScope.boundScope=null;appScope.boundRefKey=null;appScope.state.cards=[];appScope.state.records={};appScope.state.batches=[];appScope.state.deletedRecords=[];appScope.state.progress='';appScope.modules.clear();appScope.state.status='loading';appScope.notify();
    const result = await appScope.core.bindCurrentChat({expectedRef:target,signal:opener.signal,check:checkOpen});
    await checkTarget();
    if (result.status !== 'ready' || result.persistence !== 'available') throw Object.assign(new Error((appScope.core.readViewState?.()??appScope.core.state).errorMessage ?? '当前聊天尚未保存或宿主存储不可用'),{code:result.errorCode??'PERSISTENCE_UNAVAILABLE'});
    if(passive&&appScope.sourceContextComplete)await settledHistoryTail();checkOpen();
    appScope.epoch++; appScope.knowledgeCache = []; appScope.recallChanged({ clear: true });
    appScope.workspace = createWorkspace(appScope.core.workspace());
    {const current=appScope.workspace;appScope.injectionLog=createInjectionLog({workspace:current,onChange:()=>{if(appScope.workspace===current)appScope.notify();}});await appScope.injectionLog.load();checkOpen();}
    await appScope.apiSettings.adoptLegacy(appScope.core.legacySettings);checkOpen();
    appScope.core.setSessionCredential(appScope.effectiveKeys().summary);
    appScope.boundScope = (appScope.core.readViewState?.()??appScope.core.state).scope;appScope.boundRefKey=targetKey;
    const [ui,hidden,excludedVectors]=await Promise.all([appScope.workspace.read('ui',{savedThrough:-1}),appScope.workspace.read('hidden',[]),appScope.workspace.read('vector-excluded',[])]);
    checkOpen();appScope.vectorExcluded=Array.isArray(excludedVectors)?excludedVectors.filter(id=>typeof id==='string'):[];
    checkOpen();appScope.assertCurrent();Object.assign(appScope.state,{savedThrough:ui.savedThrough??-1,hidden,preview:null,actual:null,stale:false});
    const autoProgress=await appScope.workspace.read('auto-progress',{startFloor:1});checkOpen();appScope.state.autoStartFloor=Number.isSafeInteger(autoProgress.startFloor)&&autoProgress.startFloor>=0?autoProgress.startFloor:1;appScope.state.autoLastIndex=null;
    await appScope.migrateWorkspace();
    await appScope.normalizeBatchRanges();
    checkOpen();
    for (const name of ['CHAT_CHANGED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_DELETED','MESSAGE_SWIPE_DELETED']) {
      try { appScope.bindings.push(appScope.hostAdapter.subscribe(name, async () => {if(appScope.tracking)return;if(name==='MESSAGE_UPDATED'&&moduleMetadataOnly()){await appScope.syncModulesQuietly();return;}if(!sourceEventRelevant(name)){rememberModuleSources();appScope.queueAutomaticSummary();appScope.dynamicPersona.wake();return;}invalidate(name);})); } catch { /* no automatic activation without final hook */ }
    }
    appScope.state.status = 'ready';rememberModuleSources(); await appScope.refresh({boundOnly:true}); checkOpen();
    try{await appScope.syncAutoStartFloor();}catch(error){void appScope.reportError(error,{task:'summary',stage:'auto_start_floor'});}checkOpen();
    try{await appScope.dynamicPersona.load();}catch(error){void appScope.reportError(error,{task:'persona',stage:'prepare'});appScope.state.dynamicPersona={...appScope.dynamicPersona.state,message:appScope.dynamicPersona.state.message||failureText(error)};}checkOpen();
    // An empty workspace has no protected sources yet; establish full-window
    // alignment from the native tail count, without scanning unrelated bodies.
    if(!appScope.state.batches.length&&!appScope.state.dynamicPersona?.batches?.length&&!appScope.state.dynamicPersona?.manualPlan&&appScope.core.sourceEndIndex===-1&&appScope.moduleSourceBaseline?.length===appScope.state.autoLastIndex+1)appScope.sourcePrefixVerified=true;
    appScope.sourceContextComplete=appScope.moduleSourceChatId!==null&&appScope.moduleSourceBaseline?.length===appScope.state.autoLastIndex+1;
    await appScope.loadKnowledge(); await checkTarget(); appScope.enabled = enable;if(enable)appScope.automaticPaused=false;
    try {
      // Generation end must stay subscribed while chat listeners are rebound.
      // Otherwise a reply finishing during open() leaves foreground latched forever.
      const cardPromptManager=await personaPromptManager();checkOpen();
      if(cardPromptManager)appScope.bindings.push(appScope.personaWorldbook.attachPromptManager(cardPromptManager));
      try{appScope.bindings.push(appScope.hostAdapter.subscribe('CHAT_COMPLETION_PROMPT_READY',payload=>{
        appScope.personaWorldbook.applyCardPrompt(payload,appScope.enabled&&appScope.core.settings.dynamicPersonaEnabled&&!auxiliaryInjectionReason({messages:payload?.chat})?appScope.dynamicPersona.profiles():[]);
      }));}catch{/* Original card remains when the host has no structured prompt event. */}
      appScope.bindings.push(appScope.hostAdapter.subscribe('CHAT_COMPLETION_SETTINGS_READY', async payload => {
        if(auxiliaryInjectionReason(payload)){
          if(appScope.injectedPayloads.has(payload))return;
          await appScope.personaWorldbook.finalize(payload,[]);
          appScope.injectedPayloads.add(payload);
          if(appScope.core.settings.injectionLogEnabled)appScope.injectionLog?.append({status:'auxiliary',persona:{replaced:0,supplemental:0,profiles:[]}});
          return;
        }
        appScope.injecting++;appScope.providerScheduler.setForeground?.(true);appScope.dynamicPersona.interruptReview();
        const preparation=injectionTiming(appScope.host.document);
        try{
        // The host can still hold a request prepared before a chat switch. Do
        // not put either the new chat's recall or persona in that old payload.
        if(appScope.personaWorldbook.foreignRequest(payload)){await appScope.personaWorldbook.finalize(payload,[]);return;}
        const requestEpoch=appScope.epoch;
        let sourceMessages=[];try{sourceMessages=await appScope.core.sceneMessages?.()??[];}catch{/* Use assembled request when the source is unavailable. */}
        const recallQuery=sceneRecallQuery(payload.messages,sourceMessages);
        // Persona selection still needs present actors from the recent scene,
        // but never preset rules pretending to be dialogue. A retried reply is
        // excluded along with its invented or withdrawn character mentions.
        const sourceScene=recallQuery.source==='chat_source'&&sourceMessages.at(-1)?.role==='assistant'?sourceMessages.slice(0,-1):sourceMessages;
        const sceneQuery=recallQuery.source!=='request_user'?[sourceScene.filter(m=>m.role==='assistant').at(-1)?.text??'',recallQuery.intent].join('\n'):undefined;
        preparation.mark('sourceMs');
        let personaInjection;
        if(!appScope.injectedPayloads.has(payload))try{personaInjection=await appScope.dynamicPersona.inject(payload,{enabled: appScope.enabled,sceneQuery});}catch(error){void appScope.reportError(error,{task:'persona',stage:'prepare'});}
        preparation.mark('personaMs');
        if(requestEpoch!==appScope.epoch){await appScope.personaWorldbook.finalize(payload,[]);return;}
        await appScope.inject(payload,{dossierPeople:personaInjection?.people??[],dossierProfiles:personaInjection?.profiles??[],personaInjection,preparation,recallQuery,sceneMessages:sourceMessages});
        }finally{preparation.finish();appScope.injecting--;appScope.providerScheduler.setForeground?.(appScope.foregroundBusy());if(!appScope.foregroundBusy()){wakeChatFollower();appScope.queueAutomaticSummary();appScope.dynamicPersona.wake();}}
      }));
      try{appScope.bindings.push(appScope.hostAdapter.subscribe('WORLDINFO_ENTRIES_LOADED',payload=>appScope.enabled?appScope.personaWorldbook.applyLoaded(payload,appScope.dynamicPersona.profiles()).catch(error=>{void appScope.reportError(error,{task:'persona',stage:'prepare'});}):undefined));}catch{/* Optional capability must not disable automatic summary. */}
      // TT awaits event listeners. Never attach the model's lifetime to the
      // reply-render/save event; coalesce notifications into one background job.
      appScope.bindings.push(appScope.hostAdapter.subscribe('MESSAGE_RECEIVED',messageId=>{void Promise.resolve().then(appScope.syncModulesQuietly);appScope.queueAutomaticSummary(messageId);appScope.dynamicPersona.wake();}));
      const events=appScope.host.Mvu?.events;
      for(const name of [events?.VARIABLE_INITIALIZED??'mag_variable_initiailized',events?.VARIABLE_UPDATE_ENDED??'mag_variable_update_ended']){
        const eventOn=appScope.host.eventOn??appScope.host.TavernHelper?.eventOn,eventRemove=appScope.host.eventRemoveListener??appScope.host.TavernHelper?.eventRemoveListener;
        const callback=()=>{Promise.resolve().then(appScope.syncModulesQuietly);appScope.dynamicPersona.wake();};
        if(typeof eventOn==='function'){const listener=eventOn(name,callback);appScope.bindings.push(()=>{if(typeof listener?.stop==='function')listener.stop();else eventRemove?.(name,callback);});}
        else {try{appScope.bindings.push(appScope.hostAdapter.subscribe(name,callback));}catch{ /* explicit refresh still available */ }}
      }
    } catch { appScope.setMessage('已打开；宿主不支持自动任务，可手动整理和预览'); }
    appScope.setMessage(`已加载当前聊天：${appScope.state.cards.length} 条记忆、${appScope.state.batches.filter(b=>b.status!=='deleted').length} 个总结批次`);
    if(passive){appScope.state.feedback={id:++appScope.feedbackSequence,kind:'chat',level:'info',text:appScope.state.message};appScope.notify();}
    return appScope.publicState();
    } catch(error){appScope.workspace=null;appScope.boundScope=null;appScope.boundRefKey=null;appScope.state.cards=[];appScope.state.records={};appScope.state.batches=[];appScope.state.deletedRecords=[];appScope.state.progress='';appScope.modules.clear();appScope.state.status='unavailable';appScope.recallChanged({clear:true});await stopListeners();await clearPrompt();appScope.setMessage(`聊天读取未完成：${failureText(error)}`);throw error;
    } finally { appScope.opening = false; appScope.operations.delete(opener);if(appScope.active===opener)appScope.active=null;appScope.notify();wakeChatFollower();appScope.queueAutomaticSummary();appScope.dynamicPersona.wake(); }
  }

async function stop(){appScope.personaCommandVersion++;
    const stoppedActive=appScope.active,stoppedOperations=[...appScope.operations],stoppedSummary=appScope.activeSummaryOperation;
    appScope.vectorStopped=true;clearTimeout(appScope.vectorTimer);appScope.vectorTimer=null;appScope.vectorJob?.cancel();appScope.abortAll();for(const op of appScope.apiOperations)op.abort();
    try{await appScope.core.cancelSummary();}catch(error){if(error?.code!=='CANCELED')void appScope.reportError(error,{task:'summary',stage:'ui'});}
    // A persona transaction can reject or stall while the workspace is
    // switching. Other tasks have already been canceled above; waiting for
    // persona pause is bounded and cannot hold their cancellation hostage.
    // A signal-blind await can keep an operation from ever settling after
    // abort. Force-release the exclusive slots shortly after without holding
    // 停止 open; a late wake-up hits the bumped cancelVersion at its checkpoint.
    clearTimeout(appScope.stopForceTimer);
    if(stoppedActive&&appScope.active===stoppedActive)appScope.stopForceTimer=setTimeout(()=>{
      appScope.stopForceTimer=null;
      if(appScope.active!==stoppedActive)return;
      for(const op of stoppedOperations){op.abort();appScope.operations.delete(op);}appScope.active=null;appScope.opening=false;
      if(appScope.activeSummaryOperation===stoppedSummary){appScope.activeSummaryOperation=null;appScope.activeSummaryBatchId=null;}
      appScope.runtimeLog.record({task:'operation',phase:'canceled',level:'warning',details:{stage:'ui'}});
      appScope.notify();wakeChatFollower();appScope.queueAutomaticSummary();appScope.dynamicPersona.wake();appScope.wakeVectors();
      appScope.setMessage('已强制停止未响应的任务；已有保存结果保留');
    },500);
    appScope.stopForceTimer?.unref?.();
    if(appScope.boundScope&&(appScope.core.readViewState?.()??appScope.core.state).status!=='invalidated'&&stableStringify((appScope.core.readViewState?.()??appScope.core.state).scope)===stableStringify(appScope.boundScope))appScope.workspace=createWorkspace(appScope.core.workspace());
    appScope.setMessage('正在停止；已有保存结果保留');
    await Promise.race([appScope.dynamicPersona.pause().catch(error=>void appScope.reportError(error,{task:'persona',stage:'ui'})),new Promise(resolve=>setTimeout(resolve,2000))]);}

async function disable(){appScope.enabled=false;appScope.automaticPaused=true;appScope.recallChanged({clear:true});await stop();await stopListeners();await clearPrompt();appScope.setMessage('已暂停插件任务和记忆注入，仍会跟随聊天加载记忆');}
  return Object.freeze({ clearPrompt, wakeChatFollower, startChatTracking, followCurrentChat, rememberModuleSources, sourceEventRelevant, settledHistoryTail, localPersonaHistoryState, open, stop, disable });
}
