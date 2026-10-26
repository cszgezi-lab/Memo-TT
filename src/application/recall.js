import { clone, sha256, estimateUnits, stableStringify, withTimeout } from '../utils.js';
import { recallMemory, recordDescription, selectRecallCardsAsync, prepareRecallIndex } from '../product-memory.js';
import { sceneClockFromMessages } from '../temporal.js';
import { mvuContext } from '../product-custom-modules.js';
import { sceneRecallQuery, sceneClockForRequest, injectionTiming } from '../product-recall-packing.js';
import { injectionRequestMetadata } from '../product-injection-log.js';
import { embeddingVectors } from '../product-vector-indexer.js';
import { rerankDocument } from '../product-recall-policy.js';

/** recall orchestration. Dependencies are limited by service-contracts.js. */
export function createRecallService(appScope) {
function captureRecallSnapshot(){
    if(appScope.currentMemoryMutation())return null;
    return {memoryCards:appScope.state.cards,cards:[...appScope.state.cards,...(appScope.core.settings.knowledgeEnabled?appScope.knowledgeCache.filter(card=>!appScope.state.hidden.includes(card.id)):[])],settings:appScope.core.settings,dictionary:appScope.activeDictionary(),revision:appScope.recallRevision,safetyRevision:appScope.recallSafetyRevision};
  }

function recallChanged({ clear = false, vectors = false, scheduleVectors = true, publicationOnly=false } = {}) {
    if(!publicationOnly){appScope.recallSafetyRevision++;appScope.committedRecall=null;}
    appScope.recallRevision++; appScope.state.preview = null; if(clear)appScope.state.actual = null;
    if (clear) appScope.recallCache.clear();
    if (clear || vectors) {appScope.vectorCache.clear();appScope.knowledgeVectorCache.clear();}
    clearTimeout(appScope.vectorTimer);appScope.vectorTimer=null;appScope.vectorCheckVersion++;
    appScope.vectorJob?.cancel();
    appScope.state.vectorIndex={status:appScope.workspace?.isCurrent()?(appScope.core.settings.vectorEnabled?'not_checked':'disabled'):'no_chat'};
    appScope.state.batchVectors={};
    if(!appScope.disposed&&appScope.core.settings.vectorEnabled&&appScope.workspace?.isCurrent())appScope.vectorTimer=setTimeout(()=>{appScope.vectorTimer=null;void appScope.refreshVectorStatus({schedule:scheduleVectors});},250);
  }

async function readNarrativeSource({floor}={}){
    appScope.assertCurrent();if(!Number.isInteger(floor)||floor<0)throw Error('请填写要预览的聊天楼号');
    const range=await appScope.core.readIndependentRange({startIndex:floor,endIndex:floor});appScope.assertCurrent();
    const source=range.messages.find(m=>m.index===floor);if(!source)throw Error('没有读到这一楼的原文');
    return clone(source);
  }

async function warmRecall() {
    const token = appScope.epoch, revision = appScope.recallRevision;
    const cards = [...appScope.state.cards, ...appScope.knowledgeCache.filter(card => !appScope.state.hidden.includes(card.id))];
    try {
      await prepareRecallIndex(appScope.recallCache, cards, appScope.core.settings, { scopeKey: stableStringify(appScope.boundScope), revision });
      if(appScope.workspace?.isCurrent())appScope.assertCurrent(token);
    } catch (error) {
      if (token === appScope.epoch && revision === appScope.recallRevision) throw error;
    }
  }

function externalState({full=false}={}) {
    const paths=String(appScope.core.settings.externalStatePaths??'').split('\n').map(p=>p.trim()).filter(Boolean);
    if(!paths.length)return '未配置';
    const context=appScope.host.SillyTavern?.getContext?.()??appScope.host.getContext?.();
    const root={chatMetadata:context?.chatMetadata, lastMessageExtra:context?.chat?.at(-1)?.extra};
    const values={};for(const path of paths){const keys=path.split('.');if(!['chatMetadata','lastMessageExtra'].includes(keys[0])||keys.some(k=>['__proto__','constructor','prototype'].includes(k)))continue;let value=root;for(const key of keys)value=value?.[key];if(value!==undefined)values[path]=value;}
    const result=JSON.stringify(values);return full||result.length<=4000?result:'所选外部状态过长，请缩小字段路径';
  }

async function preview(query, { online = false, context='',characterContext=context,clock=null,snapshot=null,dossierPeople=[],dossierProfiles=[],signal,publish=true } = {}) {
    appScope.assertCurrent(); if(appScope.state.stale) throw new Error('正文已修改，先重新整理');
    if(appScope.currentMemoryMutation())throw appScope.pendingMemoryMutation();
    if (appScope.recallBusy&&!snapshot) throw new Error('记忆正在更新，请稍后检索');
    const op=appScope.begin(false),abort=()=>op.abort();appScope.recallReaders++;
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try {
    // Foreground recall owns the cache snapshot. Drain one canceled background
    // checkpoint before loading it; maintenance must not clear a live query.
    let backgroundWaitMs=0,backgroundFallback=false;
    if(online&&appScope.vectorJob){const pending=appScope.vectorJob,waitAt=Date.now();pending.cancel();try{await withTimeout(pending.done,1000,'后台索引退出');}catch(error){if(error?.code!=='TIMEOUT')throw error;online=false;backgroundFallback=true;}backgroundWaitMs=Date.now()-waitAt;op.check();}
    const revision = snapshot?.revision??appScope.recallRevision;
    const safetyRevision=snapshot?.safetyRevision??appScope.recallSafetyRevision;
    const settings=snapshot?.settings??appScope.core.settings;
    const cards = snapshot?.cards??[...appScope.state.cards, ...await appScope.knowledgeCards(query)];
    const lookup=context?`${query}\n最近剧情参照：${context}\n当前询问：${query}`:query;
    if(!clock)try{clock=sceneClockFromMessages(await appScope.core.sceneMessages?.()??[],{fallbackDate:settings.storyDate});}catch(error){op.check();void appScope.reportError(error,{task:'recall',stage:'prepare'});clock={date:null,status:'unavailable',source:'scene'};}
    op.check();
    let playerName='';
    if(settings.skillEvidenceEnabled===true)try{
      const name=mvuContext(appScope.host)?.name1;
      if(typeof name==='string'&&name.length<=160)playerName=name.trim();
    }catch{/* Optional identity unavailable: preserve ordinary recall and uncertainty. */}
    const result = await recallMemory(cards, lookup, {...settings,storyDate:clock.date??'',sceneClock:clock}, { ...(online ? await retrievalAdapters(await selectRecallCardsAsync(cards, settings,{signal:op.signal})) : {}),signal:op.signal, indexCache: appScope.recallCache, scopeKey: stableStringify(appScope.boundScope), revision, dictionary:snapshot?.dictionary??appScope.activeDictionary(),focusQuery:query,ordinaryQuery:context?[query,context].join('\n'):query,characterQuery:[query,characterContext].filter(Boolean).join('\n'),dossierPeople,dossierProfiles,...(settings.skillEvidenceEnabled===true?{playerName}:{} ) });
    result.sceneClock=clock;
    result.trace.timings.backgroundWaitMs=backgroundWaitMs;
    if(backgroundFallback){result.degraded=true;result.trace.vector={status:'skipped',reason:'background_pending'};}
    op.check(); if (snapshot?safetyRevision!==appScope.recallSafetyRevision:revision!==appScope.recallRevision) throw new Error('记忆或设置已更新，请重新检索');
    if(publish){appScope.state.preview = result; appScope.notify();}return result;
    } finally { signal?.removeEventListener('abort',abort);appScope.recallReaders--;op.finish(); }
  }

async function inject(payload,{dossierPeople=[],dossierProfiles=[],personaInjection,preparation=injectionTiming(appScope.host.document),recallQuery:sourceQuery,sceneMessages:sourceSceneMessages}={}) {
    if (!payload || !Array.isArray(payload.messages) || appScope.injectedPayloads.has(payload)) return;
    const log=appScope.injectionLog,started=Date.now(),initialToken=appScope.epoch;
    let querySource='unknown',request=injectionRequestMetadata(payload,sourceSceneMessages,sourceQuery);
    const audit=(status,options={})=>{const stages=preparation.finish();if(log&&appScope.core.settings.injectionLogEnabled)log.append({status,request,persona:personaInjection,preparation:stages,querySource,budgetUnits:appScope.core.settings.retrievalBudgetUnits,elapsedMs:Date.now()-started,...options});};
    if(!appScope.enabled||!appScope.core.settings.injectionEnabled){appScope.injectedPayloads.add(payload);audit('disabled');return;}
    if(appScope.state.stale||!appScope.workspace?.isCurrent()){appScope.injectedPayloads.add(payload);audit(appScope.state.stale?'stale':'unavailable');return;}
    if(appScope.currentMemoryMutation()){appScope.injectedPayloads.add(payload);audit('changed');return;}
    appScope.injectedPayloads.add(payload);
    await appScope.syncModulesQuietly();
    preparation.mark('syncMs');
    if(appScope.state.stale||!appScope.workspace?.isCurrent()||appScope.epoch!==initialToken){audit('changed');return;}
    const token = appScope.epoch;
    const revision = appScope.recallSafetyRevision;
    if(!appScope.committedRecall&&!appScope.recallBusy)appScope.committedRecall=captureRecallSnapshot();
    const snapshot=appScope.committedRecall?{...appScope.committedRecall,dictionary:appScope.activeDictionary()}:null;
    const messages = payload.messages;
    let sceneMessages=sourceSceneMessages??[];
    if(!sourceQuery&&!sourceSceneMessages)try{sceneMessages=await appScope.core.sceneMessages?.()??[];}catch{/* Only the current user turn and manual fallback remain safe. */}
    const recallQuery=sourceQuery??sceneRecallQuery(messages,sceneMessages);
    const {intent:query,context,characterContext}=recallQuery;querySource=recallQuery.source;
    request=injectionRequestMetadata(payload,sceneMessages,recallQuery);
    if(!sourceQuery)preparation.mark('sourceMs');
    const diagnosticRun=await appScope.runtimeLog.start('recall');
    try {
      // Retrieval already bounds both optional network stages and retains its
      // local candidates on failure. An outer timeout used to throw that work
      // away, repeat projection/indexing and overwrite the online trace.
      const result = await preview(query, { online: appScope.core.settings.vectorEnabled || appScope.core.settings.rerankEnabled,context,characterContext,snapshot,clock:sceneClockForRequest(messages,sceneMessages,recallQuery,{fallbackDate:(snapshot?.settings??appScope.core.settings).storyDate}),dossierPeople,dossierProfiles,publish:false });
      preparation.mark('recallMs');
      appScope.assertCurrent(token); if (revision !== appScope.recallSafetyRevision || !appScope.enabled || !appScope.core.settings.injectionEnabled){audit('changed');return;}
      const role = ['system','user'].includes(appScope.core.settings.injectionRole) ? appScope.core.settings.injectionRole : 'system';
      const external=externalState({full:true});
      let content=result.text;
      // Explicitly configured authoritative values are part of character
      // context, not something to silently omit when an event budget is small.
      const externalText=external!=='未配置'&&external!=='{}'?`[外部权威状态·只读]\n${external}`:'';
      if(externalText){
        const footer=result.timeFocusText;
        if(footer&&content.endsWith(footer))content=[content.slice(0,-footer.length).trimEnd(),externalText,footer].filter(Boolean).join('\n\n');
        else content+=`${content?'\n':''}${externalText}`;
      }
      result.trace.budget={...result.trace.budget,externalUnits:estimateUnits(externalText)};
      if(!content){audit('empty',{query,result});return;}
      const item = { role, content };
      // The host awaits this event before serializing this same messages array.
      if(appScope.core.settings.injectionPosition === 'start') messages.unshift(item); else messages.splice(Math.max(0,messages.length - 1), 0, item);
      appScope.injectedPayloads.add(payload);
      appScope.state.actual = { ...result, text:content, usedUnits:estimateUnits(content), previewOnly:false, sent:false, stage:'request_prepared', preparedAt:Date.now() };
      audit('prepared',{query,text:content,result:appScope.state.actual,role,position:appScope.core.settings.injectionPosition});
      // 本轮注入花了多久、花在哪一步：写进运行日志，用户才能判断慢在向量、重排还是本地检索。
      try{
        const t=result.trace?.timings??{},deadline=result.trace?.deadline??{};
        appScope.runtimeLog.record({run:diagnosticRun,task:'recall',phase:'prepared',details:{
          elapsedMs:Date.now()-started,
          vectorMs:Number.isFinite(t.vectorMs)?t.vectorMs:0,
          rerankMs:Number.isFinite(t.rerankMs)?t.rerankMs:0,
          localMs:Number.isFinite(t.localMs)?t.localMs:0,
          totalMs:Number.isFinite(t.recallMs)?t.recallMs:Date.now()-started,
          deadlineMs:Number.isFinite(deadline.nominalAllowanceMs)?deadline.nominalAllowanceMs:0,
          deadlineScope:deadline.scope==='online_stages_shared'?'shared':'per_api',
          vector:result.trace?.vector?.status??'disabled',
          rerank:result.trace?.rerank?.status??'disabled',
          candidates:Number.isFinite(result.candidateCount)?result.candidateCount:undefined,
          usedUnits:appScope.state.actual.usedUnits,
        }});
      }catch{/* 记时不得影响注入本身 */}
      if (result.degraded) appScope.state.message = '本轮记忆已加入；在线检索未完全可用，召回可能不完整，请查看本轮注入。';
      appScope.notify();
    } catch(error) { void appScope.reportError(error,{task:'recall',stage:'background'});audit(token===appScope.epoch?'failed':'changed',{query});if(token===appScope.epoch)appScope.setMessage('本轮记忆未加入请求：来源变化或检索失败'); }
  }

async function retrievalAdapters(cards) {
    const options = {};
    if (appScope.core.settings.vectorEnabled) {
      const allowedCards=cards.filter(card=>card.vectorEligible!==false&&!appScope.vectorExcluded.includes(card.id));
      // Setup failures belong to this optional lane, not the local baseline.
      let c, failure;
      try { c = appScope.client('embedding'); } catch (error) { failure = error; }
      const fingerprint = c ? sha256({endpoint:c.profile.url, model:c.profile.model}) : 'unconfigured';
      const bound = appScope.workspace;
      options.vectorAdapter = { embeddingSpace:fingerprint, search(args) {
        // Keep the circuit around the whole optional lane: its deadline also
        // covers index loading. Repeated failures must not tax every send.
        return appScope.vectorLane(`${stableStringify(appScope.boundScope)}:${fingerprint}`,()=>searchVector(args),{signal:args.signal});
      }};
      async function searchVector({query,limit,signal,tagLanes,categoryLanes,filter}) {
        if (failure) throw failure;
        const key=`vectors-${fingerprint.slice(0,20)}`;
        const index=await appScope.combinedVectorEntries(bound,key,{signal});
        const searchCards=typeof filter==='function'?allowedCards.filter(filter):allowedCards;
        const indexed = searchCards.filter(card => index.get(card.id)?.hash === appScope.vectorCache.hash(card)).length;
        if (!searchCards.length) return [];
        if (!indexed) throw new Error('向量索引尚未建立或已过期');
        const q = await appScope.vectorCache.query(query, async () => {
          // 查询向量必须有自己的上限：超时按降级处理，绝不拖住这次发送。
          const response = await withTimeout(c.embeddings({model:c.profile.model,input:[query],encoding_format:'float'}, {signal}), appScope.vectorBudgetMs(), '查询向量');
          return embeddingVectors(response,1)[0];
        }, signal);
        const result = await appScope.vectorCache.search(index, searchCards, q, {limit, fingerprint, signal,tagLanes,categoryLanes});
        result.coverage = { indexed: searchCards.filter(card => { const entry = index.get(card.id); return entry?.hash === appScope.vectorCache.hash(card) && (entry.dimension??entry.vector.length) === q.vector.length; }).length, total: searchCards.length };
        return result;
      }
    }
    if (appScope.core.settings.rerankEnabled&&appScope.apiConnectionReady('rerank')) {
      let c, failure;
      try { c = appScope.client('rerank'); } catch (error) { failure = error; }
      options.reranker = async ({query,candidates,signal}) => {
        if (failure) throw failure;
        const documents=candidates.map(x=>{const record=x.record??x;return rerankDocument(record,recordDescription(record),query);});
        const laneKey=sha256({scope:appScope.boundScope,url:c.profile.url,model:c.profile.model});
        const result = await appScope.rerankLane(laneKey,()=>withTimeout(c.rerank({model:c.profile.model,query,documents,top_n:candidates.length},{signal}), appScope.rerankBudgetMs(), '重排请求'),{signal});
        if (!Array.isArray(result.results) || result.results.length !== candidates.length) throw new Error('重排结果数量不匹配');
        const seen=new Set();
        return result.results.map(item=>{if(!Number.isInteger(item.index)||item.index<0||item.index>=candidates.length||seen.has(item.index))throw new Error('重排索引无效');seen.add(item.index);return {id:candidates[item.index].id,score:item.relevance_score??item.score};});
      };
    }
    // Optional recall lanes may degrade gracefully, but their cause must remain
    // inspectable even when the main chat successfully continues.
    if(options.vectorAdapter){const search=options.vectorAdapter.search;options.vectorAdapter.search=async args=>{try{return await search(args);}catch(error){void appScope.reportError(error,{task:'recall',stage:'validate',modelRole:'embedding',level:'warning'});throw error;}};}
    if(options.reranker){const rerank=options.reranker;options.reranker=async args=>{try{return await rerank(args);}catch(error){void appScope.reportError(error,{task:'recall',stage:'validate',modelRole:'rerank',level:'warning'});throw error;}};}
    return options;
  }
  return Object.freeze({ captureRecallSnapshot, recallChanged, readNarrativeSource, warmRecall, externalState, preview, inject });
}
