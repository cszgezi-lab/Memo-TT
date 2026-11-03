import {clone,sha256,stableStringify,makeId,yieldLocalWork} from './utils.js';
import {scopeKey,normalizeScope} from './contracts.js';
import {MemoryRepository} from './repository.js';
import {losslessStore,verifiedWrite} from './reliable-storage.js';
import {optionalLegacyRead} from './memo-legacy-memory.js';
import {normalizeHostMessage} from './product-host-adapters.js';
import {memoStorageLock} from './memo-storage-lock.js';
import {summaryFrontier,summaryOrigin} from './product-auto-summary.js';
import {applyPersonaCasting} from './persona-casting.js';
import {savedBatchOperation} from './product-batches.js';
import {decodeVectorDocumentAsync} from './product-vector-storage.js';

const NS='shiyi-memory-archives',MEMORY='shiyi-product-memory',WORK='shiyi-product-workspace';
const roots=['ui','hidden','auto-progress','summary-batches','dynamic-persona','vector-excluded','event-merge-decisions-v1','memory-quality-v1','memory-retrospective-v1','custom-mvu-snapshots'];
const versionFields=new Set(['versionId','baseVersionId','archiveId','appliedVersionId']);
const fail=message=>Object.assign(new Error(message),{code:'MEMORY_ARCHIVE_INVALID'});
const addressKey=a=>stableStringify([a.namespace,a.key]);
const keyOf=(prefix,text)=>`${prefix}-${sha256(text).slice(0,32)}`;
const bindingAddress=scope=>({namespace:NS,key:keyOf('binding',scopeKey(scope))});
const memoryPointer=scope=>keyOf('scope',scopeKey(scope))+'-pointer';
const workKey=(scope,name)=>sha256(scope).slice(0,24)+'-'+name;

// A branch has its own global storage generation. Immutable source receipts
// retain their original logical scope; the host ref remains the live guard.
export function archiveBranchStore(global,branchId){
 global=losslessStore(global);
 if(!/^[a-f0-9]{32}$/.test(branchId))throw fail('档案分支标识无效');
 const a=args=>({namespace:NS+'-'+branchId,key:`data-${sha256([args.namespace,args.key])}`});
 return Object.freeze({
  getJson:args=>global.getJson(a(args)),tryGetJson:args=>optionalLegacyRead(global,a(args)),
  setJson:args=>global.setJson({...a(args),value:args.value}),deleteJson:args=>global.deleteJson(a(args)),
 });
}

async function historySnapshot(session,check){
 let page=await session.handle.history.tail({limit:500});await check();const pages=[],total=page?.totalCount??page?.startIndex+page?.messages?.length;
 while(true){
  if(!Array.isArray(page?.messages)||!Number.isSafeInteger(page.startIndex)||page.startIndex<0||page.startIndex+page.messages.length!==(pages.length?pages.at(-1).startIndex:total))throw fail('聊天分页不完整，请保存聊天后重试');
  pages.push(page);if(page.startIndex===0)break;
  if(pages.length>20000||!session.handle.history.before)throw fail('无法完整读取聊天前缀');
  page=await session.handle.history.before(page,{limit:500});await check();
 }
 const rows=[];for(const p of pages.reverse()){for(let i=0;i<p.messages.length;i++){const raw=p.messages[i],m=normalizeHostMessage(raw,p.startIndex+i);rows.push({...m,speaker:String(raw.name??'')});}await yieldLocalWork({prioritized:false});await check();}
 return rows;
}
const descriptor=m=>({index:m.index,id:m.id,version:m.version,hash:m.hash,role:m.role,speaker:m.speaker??''});
const sameBody=(a,b)=>a?.hash===b?.hash&&a?.role===b?.role&&a?.speaker===b?.speaker;
function savedRows(rows,view){return rows.map(b=>{
 const operation=savedBatchOperation(b);if(b.status==='deleted'||b.replacedBy||b.splitInto?.length||!operation)return b;
 const active=(view.records.history??[]).some(h=>!h.excluded&&(h.operationId===operation||h.operationId.startsWith(operation+'/child-')));
 return active?{...b,status:'saved',operationId:operation,savedOperationId:operation,...(b.operationId!==operation?{archivePreviousAttempt:b.operationId}:{}),error:null}:b;
});}

export async function collectArchiveDocuments(store,scope,check=()=>{},vectorKeys=[]){
 store=losslessStore(store);const entries=new Map(),queue=[],ops=new Set(),seen=new Set();
 const add=(namespace,key,required=false)=>{if(typeof key!=='string'||key.length>600)throw fail('档案引用无效');queue.push({namespace,key,required});};
 const op=id=>{if(typeof id!=='string'||!id||ops.has(id))return;ops.add(id);for(const p of ['operation','checkpoint','task'])add(MEMORY,keyOf(p,p==='operation'?id:scopeKey(scope)+'|'+id));};
 const scan=v=>{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(scan);return;}for(const[k,x]of Object.entries(v)){if(['operationId','savedOperationId','previousOperation'].includes(k))op(x);if(k==='attempts'&&Array.isArray(x))x.forEach(op);if(versionFields.has(k)&&typeof x==='string'&&x)add(WORK,workKey(scope,x),true);scan(x);}
  if(Number.isSafeInteger(v.startIndex)&&Number.isSafeInteger(v.endIndex))add(WORK,workKey(scope,`persona-result-${v.startIndex}-${v.endIndex}`));
  if(v.id&&Array.isArray(v.items)){for(const item of v.items)add(WORK,workKey(scope,`persona-result-${v.id}-${item.startIndex}-${item.endIndex}`));for(const p of ['persona-manual-archive-','persona-rebuild-archive-'])add(WORK,workKey(scope,p+v.id));}
 };
 add(MEMORY,memoryPointer(scope));add(MEMORY,keyOf('task-catalog',scopeKey(scope)));for(const root of roots)add(WORK,workKey(scope,root));
 for(const key of vectorKeys){if(!/^vectors-[a-f0-9]{20}$/.test(key))throw fail('向量缓存标识无效');for(const name of [key,key+'-jobs-v1',key+'-rebuild-v1',key+'-response-jobs-v1'])add(WORK,workKey(scope,name));}
 let chars=0;
 while(queue.length){const {required,...a}=queue.shift(),id=addressKey(a);if(seen.has(id))continue;seen.add(id);await check();const row=await optionalLegacyRead(store,a);await check();if(!row.found){if(required)throw fail('档案依赖缺失，原成果保留');continue;}
  chars+=stableStringify(row.value).length;if(chars>256*1024*1024||entries.size>20000)throw fail('档案超过本次导出容量');entries.set(id,{...a,value:row.value});
  if(a.namespace===MEMORY&&a.key===memoryPointer(scope)&&row.value.manifestRef)add(MEMORY,row.value.manifestRef,true);
  if(a.namespace===MEMORY&&row.value?.kind==='memory-manifest')for(const ref of row.value.chunks??[])add(MEMORY,ref.key,true);
  if(a.namespace===WORK){const name=a.key.slice(workKey(scope,'').length);if(name.startsWith('vectors-')){const decoded=await decodeVectorDocumentAsync(name,row.value);if(decoded?.kind==='shiyi-vector-index'&&decoded.version===2)for(const entry of Object.values(decoded.entries??{}))for(const part of entry.parts??[])add(WORK,workKey(scope,part.key),true);}}
  scan(row.value);await yieldLocalWork({prioritized:false});
 }
 // Only heads can change under ordinary append-only writes. Verify all copied
 // mutable documents too, so an export never combines two user edit revisions.
 for(const e of entries.values()){const now=await optionalLegacyRead(store,e);await check();if(!now.found||stableStringify(now.value)!==stableStringify(e.value))throw fail('导出期间成果发生变化，请重新导出');}
 return [...entries.values()];
}
function documentStore(documents){
 const rows=new Map(documents.map(e=>[addressKey(e),clone(e.value)]));
 return {getJson:async a=>clone(rows.get(addressKey(a))),tryGetJson:async a=>rows.has(addressKey(a))?{found:true,value:clone(rows.get(addressKey(a)))}:{found:false},setJson:async a=>{rows.set(addressKey(a),clone(a.value));},deleteJson:async a=>{rows.delete(addressKey(a));}};
}
function validateArchive(input){
 if(input?.kind!=='memo-memory-archive'||input.version!==1||!Array.isArray(input.documents)||!Array.isArray(input.sources)||input.documents.length>20000||input.sources.length>1000000)throw fail('请选择Memo记忆档案文件');
 normalizeScope(input.scope);if(input.hash!==sha256({...input,hash:undefined}))throw fail('档案内容不完整，请重新导出');
 const seen=new Set();for(const e of input.documents){if(![MEMORY,WORK].includes(e.namespace)||typeof e.key!=='string'||e.key.length>600||seen.has(addressKey(e)))throw fail('档案存储目录无效');seen.add(addressKey(e));}
 for(let i=0;i<input.sources.length;i++){const s=input.sources[i];if(s?.index!==i||typeof s.id!=='string'||!s.id||typeof s.hash!=='string'||!/^[a-f0-9]{64}$/.test(s.hash)||!['assistant','user','system'].includes(s.role)||typeof s.speaker!=='string')throw fail('档案来源索引无效');}
 return input;
}

export async function exportMemoryArchive({session,store,cleanMessages=x=>x,check=()=>{},vectorKeys=[]}){
 const docs=await collectArchiveDocuments(store,session.scope,check,vectorKeys),sourceRows=await historySnapshot(session,check);
 const sourceStore=documentStore(docs),repo=new MemoryRepository({store:sourceStore,namespace:MEMORY});await repo.readScope(session.scope);await check();
 const persona=(await optionalLegacyRead(sourceStore,{namespace:WORK,key:workKey(session.scope,'dynamic-persona')})).value;
 const personaChecks=(persona?.batches??[]).filter(b=>b.status==='saved').map(b=>({startIndex:b.startIndex,endIndex:b.endIndex,valid:b.sourceHash===sha256(cleanMessages(sourceRows.slice(b.startIndex,b.endIndex+1).map(({speaker,...m})=>m)))}));
 for(const a of [{namespace:MEMORY,key:memoryPointer(session.scope)},...[...roots,...vectorKeys.flatMap(key=>[key,key+'-jobs-v1',key+'-rebuild-v1',key+'-response-jobs-v1'])].map(name=>({namespace:WORK,key:workKey(session.scope,name)}))]){const before=await optionalLegacyRead(sourceStore,a),after=await optionalLegacyRead(store,a);await check();if(stableStringify(before)!==stableStringify(after))throw fail('导出期间档案发生变化，请重新导出');}
 const data={kind:'memo-memory-archive',version:1,archiveId:session.archive?.archiveId??sha256(makeId('archive')).slice(0,32),scope:clone(session.scope),createdAt:Date.now(),sources:sourceRows.map(descriptor),personaChecks,documents:docs};
 data.hash=sha256({...data,hash:undefined});return data;
}

export async function previewMemoryArchive({archive,session,check=()=>{}}){
 validateArchive(archive);const store=documentStore(archive.documents);const view=await new MemoryRepository({store,namespace:MEMORY}).readScope(archive.scope);await check();
 const current=await historySnapshot(session,check);let prefix=0;while(prefix<archive.sources.length&&sameBody(archive.sources[prefix],current[prefix]))prefix++;
 const rows=savedRows((await optionalLegacyRead(store,{namespace:WORK,key:workKey(archive.scope,'summary-batches')})).value??[],view);
 const persona=(await optionalLegacyRead(store,{namespace:WORK,key:workKey(archive.scope,'dynamic-persona')})).value;
 const through=prefix-1;let summaryThrough=through,personaThrough=through;
 for(const p of archive.personaChecks??[])if(!p.valid)personaThrough=Math.min(personaThrough,p.startIndex-1);
 const byId=new Map(archive.sources.map(s=>[s.id,s]));
 for(const h of view.records.history??[]){if(h.excluded)continue;for(const ref of h.coverage?.sourceRefs??[]){if(ref.sourceId.startsWith('user-note'))continue;const s=byId.get(ref.sourceId);if(!s||s.hash!==ref.hash||s.version!==ref.version)summaryThrough=Math.min(summaryThrough,s?s.index-1:-1);}}
 // Each stream keeps its independently completed batches. A partial persona
 // batch must not discard a complete main summary over the same prefix.
 const kept=rows.filter(r=>r.status==='saved'&&r.endIndex<=summaryThrough);
 const progress=(await optionalLegacyRead(store,{namespace:WORK,key:workKey(archive.scope,'auto-progress')})).value??{};
 const origin=summaryOrigin(kept,{startFloor:progress.originFloor??1,originFloor:progress.originFloor});
 const nextSummaryFloor=summaryFrontier(kept,Math.min(origin,through+1));
 const plan={matchedThrough:through,summaryThrough,personaThrough,identicalThrough:prefix-1,totalCount:current.length,summaryBatches:kept.length,personaBatches:(persona?.batches??[]).filter(r=>r.status==='saved'&&r.endIndex<=personaThrough).length,nextSummaryFloor,requests:0};
 return {...plan,previewHash:sha256([archive.hash,session.refKey,current.map(descriptor),plan]),_sources:current.map(descriptor)};
}

export async function importMemoryArchive({archive,session,global,previewHash,check=()=>{},beforeActivate=()=>{}}){
 global=losslessStore(global);
 return memoStorageLock(global,'archive-import-'+sha256(session.scope),async()=>{
  const target=bindingAddress(session.hostScope??session.scope);if((await optionalLegacyRead(global,target)).found)throw fail('此聊天已绑定档案；请在新的分支聊天导入，当前成果保留');
  const plan=await previewMemoryArchive({archive,session,check});if(!previewHash||plan.previewHash!==previewHash)throw fail('聊天或档案已变化，请重新比较');
  if(plan.matchedThrough<0)throw fail('没有可继承的相同前缀，未创建绑定');
  const branchId=sha256(makeId('branch')).slice(0,32),store=losslessStore(archiveBranchStore(global,branchId));
  for(const e of archive.documents){await check();await verifiedWrite(store,{namespace:e.namespace,key:e.key},e.value);await yieldLocalWork({prioritized:false});}
  const wp=name=>({namespace:WORK,key:workKey(archive.scope,name)}),read=async name=>(await optionalLegacyRead(store,wp(name))).value;
  const repo=new MemoryRepository({store,namespace:MEMORY}),view=await repo.readScope(archive.scope);await check();
  const indices=new Map(archive.sources.map(s=>[s.id,s.index]));const discard={};
  for(const h of view.records.history??[]){const refs=h.coverage?.sourceRefs??[];if(refs.some(r=>(indices.get(r.sourceId)??Infinity)>plan.summaryThrough&&!r.sourceId.startsWith('user-note_')))discard[h.operationId]='deleted';}
  const batches=savedRows(await read('summary-batches')??[],view);
  for(const b of batches)if(b.endIndex>plan.summaryThrough||b.status!=='saved'){for(const id of [b.operationId,b.savedOperationId,...(b.attempts??[])])if(typeof id==='string')discard[id]='deleted';}
  await repo.updateControls(archive.scope,{operations:discard,automation:{summaryHold:{reason:'archive_import',endIndex:plan.nextSummaryFloor-1}}},{check});
  await verifiedWrite(store,wp('summary-batches'),batches.map(b=>b.endIndex<=plan.summaryThrough&&b.status==='saved'?b:{...b,status:'deleted',archiveExcluded:true}));
  const persona=await read('dynamic-persona');if(persona){
   const removed=(persona.batches??[]).filter(b=>b.status==='saved'&&b.endIndex>plan.personaThrough).sort((a,b)=>a.startIndex-b.startIndex);
   let profiles=persona.profiles??[];if(removed.length){const prior=removed[0].versionId?await read(removed[0].versionId):null;if(!Array.isArray(prior?.profiles))throw fail('分叉点的人设恢复版本缺失，未启用分支');profiles=prior.profiles;}
   const manual=(persona.profiles??[]).filter(p=>p.manual);
   profiles=[...profiles.filter(p=>!manual.some(m=>m.id===p.id)&&(p.through==null||p.through<=plan.personaThrough)),...manual].map(p=>applyPersonaCasting(p,persona.castingOverrides));
   await verifiedWrite(store,wp('dynamic-persona'),{...persona,profiles,batches:(persona.batches??[]).filter(b=>b.status==='saved'&&b.endIndex<=plan.personaThrough),manualPlan:null,batchRemoval:null,paused:true,historyCheck:null,refinement:{version:1,queue:[],last:{},status:'idle'},factualReview:{version:1,queue:[],last:{},status:'idle'}});
  }
  await verifiedWrite(store,wp('auto-progress'),{startFloor:plan.nextSummaryFloor,originFloor:Math.min((await read('auto-progress'))?.originFloor??1,plan.nextSummaryFloor)});
  await verifiedWrite(store,wp('ui'),{...(await read('ui')??{}),savedThrough:plan.nextSummaryFloor-1});
  await repo.readScope(archive.scope);await check();
  const current=await historySnapshot(session,check);if(sha256(current.map(descriptor))!==sha256(plan._sources))throw fail('导入期间聊天已变化，未启用分支；请重新比较');
  const binding={kind:'memo-archive-binding',version:1,archiveId:archive.archiveId,branchId,scope:clone(archive.scope),hostScope:clone(session.hostScope??session.scope),sources:archive.sources.slice(0,plan.matchedThrough+1),matchedThrough:plan.matchedThrough,createdAt:Date.now()};
  // Final pointer is the sole activation write. Interrupted staging stays inert.
  await verifiedWrite(global,{namespace:NS,key:'branch-'+branchId},binding);await check();
  await beforeActivate();await check();
  if((await optionalLegacyRead(global,target)).found)throw fail('此聊天已绑定其他档案，原成果保留');
  await verifiedWrite(global,target,binding);return {...plan,branchId,archiveId:binding.archiveId};
 });
}

export async function resolveArchiveSession(session,global){
 global=losslessStore(global);
 const found=await optionalLegacyRead(global,bindingAddress(session.scope));if(!found.found)return session;
 const b=found.value;if(b?.kind!=='memo-archive-binding'||b.version!==1||stableStringify(b.hostScope)!==stableStringify(session.scope)||!Array.isArray(b.sources))throw fail('档案绑定无法读取，已有档案保留');normalizeScope(b.scope);
 const canonicalMessage=(raw,index)=>{const old=b.sources[index];if(!old)return raw;const current={...normalizeHostMessage(raw,index),speaker:String(raw.name??'')};return sameBody(old,current)?{...raw,id:old.id,version:old.version}:raw;};
 const mapPage=page=>({...page,messages:page.messages.map((raw,i)=>canonicalMessage(raw,page.startIndex+i))});
 const history={tail:async o=>mapPage(await session.handle.history.tail(o)),before:async(p,o)=>mapPage(await session.handle.history.before(p,o))};
 return Object.freeze({...session,hostScope:session.scope,scope:Object.freeze(clone(b.scope)),archive:clone(b),canonicalMessage,handle:{...session.handle,history,store:archiveBranchStore(global,b.branchId)}});
}
