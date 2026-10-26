import { credentialOrigin } from '../product-credentials.js';
import { createWorkspace } from '../product-workspace.js';
import { ProviderClient } from '../provider.js';
import { productApiProfile, fetchProductModels } from '../product-model-list.js';
import { validateProductPatch, validateProductEdit } from '../product-settings.js';
import { embeddingVectors } from '../product-vector-indexer.js';
import { chatConnectionPayload, inspectChatConnection } from '../product-connection-probe.js';

/** settings orchestration. Dependencies are limited by service-contracts.js. */
export function createSettingsService(appScope) {
function effectiveKeys(patch={}){const s={...appScope.core.settings,...patch};return Object.fromEntries(Object.entries(appScope.keys).map(([k,v])=>[k,appScope.keyOrigins[k]&&appScope.keyOrigins[k]!==credentialOrigin(s[`${appScope.prefixFor(k)}Endpoint`])?'':v]));}

async function loadApiSettings(){
    await appScope.apiSettings.load();
    if(!appScope.credentialsLoaded){await Promise.all(Object.keys(appScope.keys).map(async kind=>{try{const found=await appScope.credentials.read(kind);appScope.state.credentialSaved[kind]=Boolean(found.value);if(!appScope.keyEdited.has(kind)){appScope.keys[kind]=found.value;appScope.keyOrigins[kind]=found.origin;}}catch(e){void appScope.reportError(e,{task:'storage',stage:'storage',modelRole:kind});appScope.state.credentialErrors[kind]=e.message;}}));appScope.credentialsLoaded=true;appScope.core.setSessionCredential(effectiveKeys().summary);}
    if(appScope.globalLoaded)return appScope.core.settings;
    if(appScope.globalLoading)return appScope.globalLoading;
    appScope.globalLoading=(async()=>{
      appScope.globalWorkspace=createWorkspace({store:await appScope.globalStore(),scope:{configuration:'installation-v1'},isCurrent:()=>true});
      const ui=await appScope.globalWorkspace.read('ui',{draft:'',conversationId:'main'});
      appScope.state.draft=ui.draft??'';appScope.state.conversationId=ui.conversationId??'main';
      appScope.state.history=await appScope.globalWorkspace.read(`assistant-${appScope.state.conversationId}`,[]);
      appScope.state.conversations=await appScope.globalWorkspace.read('conversations',[{id:'main',title:'配置对话'}]);
      appScope.state.proposal=await appScope.globalWorkspace.read('proposal');appScope.state.lastApplied=await appScope.globalWorkspace.read('last-applied');
      appScope.state.documents=await appScope.globalWorkspace.read('documents',[]);await appScope.modules.loadDefinitions();appScope.globalLoaded=true;
      await appScope.loadKnowledge();appScope.notify();return appScope.core.settings;
    })().finally(()=>{appScope.globalLoading=null;});return appScope.globalLoading;
  }

function client(kind = 'summary', patch = {}) {
    const profile = apiProfile(kind,patch);
    if (!profile.endpoint || !profile.model) throw Object.assign(new Error('请先在 API 中填写地址和模型'),{code:'MODEL_UNAVAILABLE',details:{modelRole:kind}});
    return new ProviderClient(profile, { fetchImpl: appScope.fetchImpl, recordRequests: false,modelRole:kind });
  }

function apiProfile(kind,patch={}) {
    return productApiProfile(appScope.core.settings,kind,{...effectiveKeys(patch),dynamicPersonaCredentialPresent:Boolean(appScope.keys.dynamicPersona)},patch);
  }

function apiConnectionReady(kind) {
    const profile=apiProfile(kind);
    return Boolean(String(profile.endpoint??'').trim()&&String(profile.model??'').trim());
  }

function resolvedPersonaSettings() {
    const settings=appScope.core.settings,profile=apiProfile('dynamicPersona');
    // The worker's wire model and recovery identity must match the selected
    // connection. Persisted independent settings and credentials stay intact.
    return {...settings,dynamicPersonaEndpoint:profile.endpoint,dynamicPersonaModel:profile.model,
      dynamicPersonaEndpointMode:profile.endpointMode,dynamicPersonaAuthMode:profile.authMode};
  }

async function saveUi() {
    await loadApiSettings();
    await appScope.globalWorkspace.write('ui',{draft:appScope.state.draft,conversationId:appScope.state.conversationId});

  }

async function saveSettings(patch) {
    const valid=validateProductEdit(patch,appScope.core.settings);
    if(valid.personaReviewEnabled===false)appScope.dynamicPersona.interruptReview();
    if(valid.dynamicPersonaFactReviewEnabled===false)appScope.dynamicPersona.interruptFactReview();
    await loadApiSettings();await appScope.apiSettings.save(valid);
    if(valid.personaReviewEnabled===false)appScope.dynamicPersona.interruptReview();
    if(valid.dynamicPersonaFactReviewEnabled===false)appScope.dynamicPersona.interruptFactReview();
    if(!appScope.core.settings.injectionEnabled)await appScope.clearPrompt();
    if(patch.dynamicPersonaEnabled===false)await appScope.dynamicPersona.pause();
    let readingMessage=null;
    if(Object.hasOwn(valid,'narrativeExtraction')){
      readingMessage='标签已保存；下次总结和召回原文使用新规则。聊天原文和已有结果保留。';
      appScope.state.feedback={id:++appScope.feedbackSequence,kind:'chat',level:'success',text:readingMessage};
    }
    appScope.queueAutomaticSummary();appScope.dynamicPersona.wake();
    appScope.setMessage(readingMessage??'全局设置已保存，所有聊天共用');return {status:'saved',settings:appScope.core.settings};
  }

async function saveApi(kind,patch,{keyValue}={}){
    if(!Object.hasOwn(appScope.keys,kind))throw new Error('未知模型用途');
    const keyVersion=appScope.keyVersions[kind]??0;
    await loadApiSettings();
    const valid=validateProductPatch(patch),settings={...appScope.core.settings,...valid};
    if(Object.keys(valid).some(k=>!k.startsWith(appScope.prefixFor(kind))&&!(kind==='assistant'&&k==='assistantFollowSummary')))throw new Error('此按钮只保存当前模型连接');
    let value=keyValue!==undefined&&String(keyValue)!==''?String(keyValue):effectiveKeys(valid)[kind];
    if(!value&&appScope.state.credentialSaved[kind]){const saved=await appScope.credentials.read(kind);if(saved.origin===credentialOrigin(settings[`${appScope.prefixFor(kind)}Endpoint`]))value=saved.value;}
    await saveSettings(valid);
    if(value){const stored=await appScope.credentials.save(kind,value,credentialOrigin(settings[`${appScope.prefixFor(kind)}Endpoint`]));if((appScope.keyVersions[kind]??0)===keyVersion){appScope.keys[kind]=stored.value;appScope.keyOrigins[kind]=stored.origin;appScope.keyEdited.delete(kind);}appScope.state.credentialSaved[kind]=true;delete appScope.state.credentialErrors[kind];}
    appScope.core.setSessionCredential(effectiveKeys().summary);appScope.setMessage(value?'API 与 Key 已保存，重启后自动恢复':'API 已保存；当前地址未保存 Key');return {status:'saved'};
  }

async function forgetKey(kind){
    await loadApiSettings();await appScope.credentials.save(kind,'','');appScope.keys[kind]='';appScope.keyOrigins[kind]='';appScope.keyEdited.add(kind);appScope.state.credentialSaved[kind]=false;delete appScope.state.credentialErrors[kind];appScope.core.setSessionCredential(effectiveKeys().summary);appScope.recallChanged({vectors:true});appScope.setMessage('此模型保存的 Key 已清除，设置与记忆保留');
  }

async function listModels(kind, { patch = {}, modelsUrl = '', signal } = {}) {
    const op = appScope.beginApi();
    const cancel = () => controller.abort();
    const controller = new AbortController();
    op.signal.addEventListener('abort', cancel, { once: true });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      await loadApiSettings();op.check();
      const models = await fetchProductModels(productApiProfile(appScope.core.settings, kind, effectiveKeys(patch), patch), { fetchImpl: appScope.fetchImpl, modelsUrl, signal: controller.signal,modelRole:kind });
      op.check(); if (controller.signal.aborted) throw new Error('已停止拉取模型');
      return models;
    } finally { op.signal.removeEventListener('abort', cancel); signal?.removeEventListener('abort', cancel); op.finish(); }
  }

async function testConnection(kind = 'summary', patch = {}) {
    const op=appScope.beginApi();
    try { await loadApiSettings();op.check();const c = client(kind, patch); let result,report={ok:true,connected:true,completionReady:true,level:'success',message:'连接测试成功。'};
      if (kind === 'embedding') { result = await c.embeddings({ model: c.profile.model, input: ['connection check'], encoding_format:'float' },op); embeddingVectors(result,1); }
      else if (kind === 'rerank') { result = await c.rerank({ model: c.profile.model, query: '连接', documents: ['连接测试'], top_n: 1 },op); if (!Array.isArray(result?.results)) throw new Error('服务没有返回重排结果'); }
      else report=inspectChatConnection(await c.chatCompletions(chatConnectionPayload(c.profile.model),{...op,timeoutMs:patch.deadlineMs??appScope.core.settings.deadlineMs}));
      op.check(); appScope.setMessage(report.message); return { ...report,kind };
    } finally { op.finish(); }
  }
  return Object.freeze({ effectiveKeys, loadApiSettings, client, apiConnectionReady, resolvedPersonaSettings, saveUi, saveSettings, saveApi, forgetKey, listModels, testConnection });
}
