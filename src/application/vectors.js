import { selectRecallCards } from '../product-memory.js';
import { clone, sha256 } from '../utils.js';
import { buildVectorIndex, normalizeVectorJobs, vectorJobKey, vectorStagingKey, vectorFailure, vectorFailureCounts, vectorRetryDelay } from '../product-vector-indexer.js';
import { failureText } from '../product-feedback.js';
import { vectorIndexCoverage } from '../product-vector-cache.js';
import { batchVectorCards, batchVectorGroups } from '../product-batches.js';

/** vectors orchestration. Dependencies are limited by service-contracts.js. */
export function createVectorsService(appScope) {
function vectorCards({all=false}={}){return selectRecallCards([...appScope.state.cards,...appScope.knowledgeCache.filter(c=>!appScope.state.hidden.includes(c.id))],appScope.core.settings,{projectSource:false}).filter(c=>c.vectorEligible!==false&&(all||!appScope.vectorExcluded.includes(c.id)));}

async function combinedVectorEntries(bound,key,{globalKey=key,signal}={}){
    const local=await appScope.vectorCache.load(bound,key,signal);
    if(!appScope.core.settings.knowledgeEnabled||!appScope.knowledgeCache.some(c=>c.vectorEligible!==false))return local;
    const shared=await appScope.knowledgeVectorCache.load(appScope.globalWorkspace,globalKey,signal);
    return new Map([...local,...shared]);
  }

async function excludeVector(id,excluded=true){
    appScope.assertCurrent();const token=appScope.epoch,bound=appScope.workspace;
    if(!vectorCards({all:true}).some(c=>c.id===id))throw new Error('记忆不存在，请刷新');
    appScope.vectorJob?.cancel();
    const next=excluded?[...new Set([...appScope.vectorExcluded,id])]:appScope.vectorExcluded.filter(x=>x!==id);
    await bound.write('vector-excluded',next);appScope.assertCurrent(token);appScope.vectorExcluded=next;
    appScope.recallChanged({vectors:true});appScope.setMessage(excluded?'已排除该条向量；记忆正文保留，关键词仍可检索。':'已恢复向量索引资格；启用后台更新后会自动补建。');
  }

async function listVectorEntries({query='',page=1,status='all'}={}){
    appScope.assertCurrent();const token=appScope.epoch,revision=appScope.recallRevision,c=appScope.client('embedding'),bound=appScope.workspace;
    const fingerprint=sha256({endpoint:c.profile.url,model:c.profile.model}),key=`vectors-${fingerprint.slice(0,20)}`;
    const jobs=normalizeVectorJobs(await bound.read(vectorJobKey(key),null)),entries=await combinedVectorEntries(bound,jobs.rebuilding?vectorStagingKey(key):key,{globalKey:key});
    appScope.assertCurrent(token);if(revision!==appScope.recallRevision)throw new Error('记忆已变化，请刷新索引列表');
    const q=String(query).trim().toLocaleLowerCase();
    const rows=vectorCards({all:true}).map(card=>{
      const issue=vectorFailure(card,jobs);
      const status=appScope.vectorExcluded.includes(card.id)?'excluded':entries.get(card.id)?.hash===appScope.vectorCache.hash(card)?'indexed':issue?'failed':entries.has(card.id)?'stale':'missing';
      return {id:card.id,title:card.title??card.recallSummary??card.description?.slice(0,80)??'记忆',category:card.category,status,
        ...(status==='failed'?{error:failureText({code:issue.code,details:{status:issue.status,upstreamHint:issue.upstreamHint,purpose:'embeddings'}}),attempts:issue.attempts}:{}),
        segments:entries.get(card.id)?.parts?.length??entries.get(card.id)?.segments?.length??(entries.has(card.id)?1:0)};
    }).filter(row=>(status==='all'||row.status===status||status==='unfinished'&&['failed','missing','stale'].includes(row.status))&&row.title.toLocaleLowerCase().includes(q));
    const pages=Math.max(1,Math.ceil(rows.length/20)),current=Math.min(pages,Math.max(1,Math.floor(Number(page)||1)));
    return {rows:rows.slice((current-1)*20,current*20),total:rows.length,page:current,pages};
  }

function canMaintainVectors(){return !appScope.disposed&&appScope.enabled&&!appScope.vectorStopped&&!appScope.recallReaders&&!appScope.foregroundBusy()&&appScope.workspace?.isCurrent()&&!appScope.state.stale&&appScope.core.settings.vectorEnabled&&(appScope.core.settings.vectorAutoUpdate||appScope.state.batches.some(b=>b.status==='saved'&&b.autoIndex))&&appScope.host.document?.visibilityState!=='hidden'&&appScope.host.navigator?.onLine!==false;}

function wakeVectors(){
    if(!canMaintainVectors()||appScope.vectorTimer||appScope.vectorJob||appScope.active||appScope.recallBusy)return;
    appScope.vectorTimer=setTimeout(()=>{appScope.vectorTimer=null;void refreshVectorStatus({schedule:true});},500);appScope.vectorTimer.unref?.();
  }

async function refreshVectorStatus({schedule=false,cached=false}={}){
    // A disabled optional lane must stop before resolving its client, reading
    // persisted vector pages or traversing cards, including navigation checks.
    if(!appScope.core.settings.vectorEnabled){
      appScope.vectorCheckVersion++;clearTimeout(appScope.vectorTimer);appScope.vectorTimer=null;appScope.vectorJob?.cancel();
      appScope.state.vectorIndex={status:appScope.workspace?.isCurrent()&&!appScope.state.stale?'disabled':'no_chat'};
      appScope.state.batchVectors={};appScope.notify();return clone(appScope.state.vectorIndex);
    }
    // Page navigation can reuse a recent completed check. Explicit refresh and
    // invalidation/build paths still read the store and verify every entry.
    if(cached&&appScope.workspace?.isCurrent()&&!appScope.state.stale&&appScope.state.vectorIndex?.checkedAt&&Date.now()-appScope.state.vectorIndex.checkedAt<5000)return appScope.state.vectorIndex;
    const version=++appScope.vectorCheckVersion,token=appScope.epoch,revision=appScope.recallRevision,bound=appScope.workspace;
    if(!bound?.isCurrent()||appScope.state.stale){appScope.state.vectorIndex={status:'no_chat'};appScope.notify();return appScope.state.vectorIndex;}
    const current=()=>appScope.core.settings.vectorEnabled&&version===appScope.vectorCheckVersion&&token===appScope.epoch&&revision===appScope.recallRevision&&bound.isCurrent();
    try{
      const c=appScope.client('embedding'),fingerprint=sha256({endpoint:c.profile.url,model:c.profile.model}),key=`vectors-${fingerprint.slice(0,20)}`;
      const jobs=normalizeVectorJobs(await bound.read(vectorJobKey(key),null));
      if(!current())return;
      const cards=vectorCards(),entries=await combinedVectorEntries(bound,jobs.rebuilding?vectorStagingKey(key):key,{globalKey:key});
      if(!current())return;
      const coverage=vectorIndexCoverage(cards,entries,card=>appScope.vectorCache.hash(card));
      const hash=card=>appScope.vectorCache.hash(card),failure=vectorFailureCounts(cards,entries,jobs,hash);
      const storageFailure=appScope.vectorStorageFailure?.workspace===bound&&appScope.vectorStorageFailure.key===key?appScope.vectorStorageFailure.error:null;
      if(version!==appScope.vectorCheckVersion||token!==appScope.epoch||revision!==appScope.recallRevision||!bound.isCurrent())return;
      const stopped=appScope.state.vectorIndex?.status==='stopped';
      const status=appScope.vectorJob?'updating':storageFailure?'error':!coverage.total?'empty':coverage.mixed?'mixed':!coverage.pending?'ready':failure.blocked||failure.failed?'error':stopped?'stopped':'pending';
      const issue=storageFailure??failure.blocked??cards.map(c=>vectorFailure(c,jobs,hash)).find(Boolean);
      appScope.state.vectorIndex={...coverage,...failure,rebuilding:jobs.rebuilding,status,model:c.profile.model,checkedAt:Date.now(),...(status==='error'&&issue?{message:failureText({code:issue.code,details:issue.details??{status:issue.status,upstreamHint:issue.upstreamHint,purpose:'embeddings'}})}:{})};
      const batches=appScope.state.batches.filter(b=>b.status!=='deleted'),groups=batchVectorGroups(batches,cards);
      appScope.state.batchVectors=Object.fromEntries(batches.map(b=>{
        const own=groups.get(b.id),covered=vectorIndexCoverage(own,entries,hash),failed=vectorFailureCounts(own,entries,jobs,hash).failed;
        return [b.id,{...covered,failed,status:!covered.total?'empty':!covered.pending?'ready':appScope.vectorJob?'updating':failed||jobs.blocked||storageFailure?'error':'pending'}];
      }));
      appScope.notify();
      // The existing bounded maintenance queue also consumes saved-batch jobs.
      // Their opt-in marker is persisted with the batch, so reloads and service
      // failures do not lose work. Auto-update off never sweeps unrelated cards.
      const maintenanceCards=appScope.core.settings.vectorAutoUpdate?cards:[...new Map(batches.filter(b=>b.status==='saved'&&b.autoIndex).flatMap(b=>groups.get(b.id)??[]).map(c=>[c.id,c])).values()];
      const retryDelay=vectorRetryDelay(failure.blocked),retryable=maintenanceCards.filter(c=>entries.get(c.id)?.hash!==hash(c)).map(c=>vectorFailure(c,jobs,hash)).filter(f=>!f||vectorRetryDelay(f)!==null);
      if(canMaintainVectors()&&!storageFailure&&retryDelay!==null&&retryable.length){
        const wait=Math.max(1500,retryDelay||Math.min(...retryable.map(f=>vectorRetryDelay(f))));
        appScope.state.vectorIndex.automatic=true;appScope.state.vectorIndex.retryAt=Date.now()+wait;
        if(failure.blocked)appScope.state.vectorIndex.message=`向量服务暂不可用；约 ${Math.ceil(wait/1000)} 秒后自动续建。已有记忆保留，无需重新总结。`;
        appScope.notify();
        if(schedule&&!appScope.vectorJob&&!appScope.active&&!appScope.recallBusy){
          clearTimeout(appScope.vectorTimer);
          const ids=appScope.core.settings.vectorAutoUpdate?null:maintenanceCards.map(c=>c.id);
          appScope.vectorTimer=setTimeout(()=>{appScope.vectorTimer=null;if(canMaintainVectors()&&token===appScope.epoch&&revision===appScope.recallRevision&&!appScope.active&&!appScope.recallBusy)void appScope.logged('vectors',run=>buildVectors({background:true,ids,diagnosticRun:run})).catch(()=>{});},wait);appScope.vectorTimer.unref?.();
        }
      }
      return clone(appScope.state.vectorIndex);
    }catch(error){if(version===appScope.vectorCheckVersion&&token===appScope.epoch){void appScope.reportError(error,{task:'vectors',stage:'background'});appScope.state.vectorIndex={status:'unavailable',message:failureText(error)};appScope.notify();}}
  }

async function buildVectors({background=false,rebuild=false,ids=null,diagnosticRun}={}) {
    appScope.assertCurrent();if(appScope.vectorJob)throw new Error('向量索引正在更新');
    if(appScope.recallReaders){if(background)return {level:'info',paused:true};throw new Error('正在准备本轮记忆，请稍后更新索引');}
    if(!background){appScope.vectorStorageFailure=null;appScope.vectorStopped=false;}
    appScope.vectorCache.clear();
    let storageKey;
    const op=appScope.begin(!background),token=appScope.epoch,signal=op.signal,revision=appScope.recallRevision,bound=appScope.workspace;
    let finishJob;const done=new Promise(resolve=>{finishJob=resolve;});
    const cancellation=new AbortController(),job={cancel:()=>cancellation.abort(),done};appScope.vectorJob=job;
    clearTimeout(appScope.vectorTimer);appScope.vectorTimer=null;
    const check=()=>{op.check();if(cancellation.signal.aborted||revision!==appScope.recallRevision)throw Object.assign(new Error('记忆已更新，本次索引任务停止'),{code:'CANCELED'});};
    const combined=new AbortController(),cancelRequest=()=>combined.abort();
    signal.addEventListener('abort',cancelRequest,{once:true});cancellation.signal.addEventListener('abort',cancelRequest,{once:true});
    try {
      const c=appScope.client('embedding'),fingerprint=sha256({endpoint:c.profile.url,model:c.profile.model}),key=`vectors-${fingerprint.slice(0,20)}`;
      storageKey=key;
      const report=await buildVectorIndex({cards:vectorCards(),workspace:bound,key,client:c,check,signal:combined.signal,background,rebuild,ids,maxRequests:background?2:Infinity,
        diagnostic:(phase,details,level='info')=>appScope.runtimeLog.record({run:diagnosticRun,task:'vectors',phase,level,details:{transport:'browser_direct',...details}}),
        progress:stats=>{check();appScope.state.vectorIndex={...stats,status:'updating',model:c.profile.model};appScope.notify();}
      });
      check();report.message=`向量已保存 ${report.indexed??0}/${report.total??0} 条${report.pending?`，剩余 ${report.pending} 条待补建`:''}；未重新总结聊天。`;if(!background)appScope.setMessage(report.message);
      return report;
    }catch(error){
      if(error?.code==='PERSISTENCE_ERROR'&&token===appScope.epoch)appScope.vectorStorageFailure={workspace:bound,key:storageKey,error};
      if(token===appScope.epoch&&revision===appScope.recallRevision){appScope.state.vectorIndex={...appScope.state.vectorIndex,status:combined.signal.aborted?'stopped':'error',message:failureText(error)};appScope.notify();}
      throw error;
    }finally{
      signal.removeEventListener('abort',cancelRequest);cancellation.signal.removeEventListener('abort',cancelRequest);
      if(appScope.vectorJob===job)appScope.vectorJob=null;appScope.vectorCache.clear();op.finish();
      try{if(token===appScope.epoch&&revision===appScope.recallRevision)await refreshVectorStatus({schedule:true});}finally{finishJob();}
    }
  }

async function retryBatchVectors(id){
    await appScope.prepareSummaryChat();await appScope.refresh();appScope.assertCurrent();
    const batch=appScope.state.batches.find(b=>b.id===id&&b.status!=='deleted');
    if(!batch)throw new Error('批次不存在或已删除');
    const ids=batchVectorCards(batch,vectorCards()).map(c=>c.id);
    if(!ids.length)return {requests:0,level:'info',message:'该批当前没有需要向量化的有效记忆；尚未保存、已删除或被排除的内容不会建索引。'};
    return appScope.logged('vectors',run=>buildVectors({ids,diagnosticRun:run}));
  }
  return Object.freeze({ combinedVectorEntries, excludeVector, listVectorEntries, wakeVectors, refreshVectorStatus, buildVectors, retryBatchVectors });
}
