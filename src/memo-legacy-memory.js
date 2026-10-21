import {clone,sha256,stableStringify} from './utils.js';
import {scopeKey} from './contracts.js';
import {losslessStore,verifiedWrite} from './reliable-storage.js';
import {decodeVectorDocumentAsync} from './product-vector-storage.js';
import {isMissingProductEntry} from './product-host-adapters.js';
import {credentialOrigin} from './product-credentials.js';
import {memoStorageLock} from './memo-storage-lock.js';

export const LEGACY_MEMORY_NAMESPACES=Object.freeze(['shiyi-product-memory','shiyi-product-workspace','shiyi-product-settings']);
const MEMORY=LEGACY_MEMORY_NAMESPACES[0],WORKSPACE=LEGACY_MEMORY_NAMESPACES[1];
const roots=['ui','hidden','auto-progress','summary-batches','summary-batches-before-range-dedup-v1','dynamic-persona','vector-excluded','event-merge-decisions-v1','memory-quality-v1','memory-retrospective-v1','custom-mvu-snapshots','injection-log-v1'];
const versionFields=new Set(['versionId','baseVersionId','archiveId','appliedVersionId']);
const fail=(message,code='MEMO_LEGACY_IMPORT_FAILED')=>Object.assign(new Error(message),{code,details:{stage:'storage',reason:'legacy_memory_import',modelRequested:false}});
const keyOf=(prefix,text)=>`${prefix}-${sha256(text).slice(0,32)}`;
export async function optionalLegacyRead(store,address){
  if(typeof store.tryGetJson==='function')return store.tryGetJson(address);
  // TT's throwing getJson displays a native error before rejecting a missing
  // key. Match the existing product-store contract: list this namespace first,
  // and never classify a listed but unreadable entry as an empty original.
  if(typeof store.listKeys==='function'){
    const keys=await store.listKeys({namespace:address.namespace,...(address.table===undefined?{}:{table:address.table})});
    if(!Array.isArray(keys)||keys.some(k=>typeof k!=='string'))throw fail('旧拾忆存储目录无效，未当作空存档');
    if(!keys.includes(address.key))return {found:false};
    return {found:true,value:await store.getJson(address)};
  }
  try{const value=await store.getJson(address);return value===undefined?{found:false}:{found:true,value};}
  catch(error){if(isMissingProductEntry(error))return {found:false};throw error;}
}
/** Adopt settings only for an uninitialized Memo installation. An existing
 * Memo document owns its omitted defaults too; filling those holes from the
 * original would change its effective settings on upgrade. Credentials and
 * module definitions still use absent-address adoption, never replacement. */
export function prepareLegacyGlobal(options){return memoStorageLock(options.target,'memo-settings-v1',()=>prepareLegacyGlobalLocked(options));}
async function prepareLegacyGlobalLocked({source,target,identity,check=()=>{}}){
  const old=losslessStore(source),next=losslessStore(target),address={namespace:'shiyi-product-global',key:'settings-v1'},oldDoc=await optionalLegacyRead(old,address);await check();
  if(!oldDoc.found)return;if(oldDoc.value?.version!==1||!oldDoc.value.settings||typeof oldDoc.value.settings!=='object')return;
  const mapped={...address,namespace:identity.namespace(address.namespace)},current=await optionalLegacyRead(next,mapped);await check();
  if(current.found&&(current.value?.version!==1||!current.value.settings||typeof current.value.settings!=='object'))throw fail('Memo 设置格式无效，未用旧设置覆盖');
  const saved=current.value?.settings??{},settings={...clone(saved)};
  const connection=/^(?:provider|dynamicPersona|embedding|rerank)(?:Endpoint|Model|EndpointMode|AuthMode)$/;
  if(!current.found){
    for(const[key,value]of Object.entries(oldDoc.value.settings))if(!connection.test(key)&&!key.toLowerCase().includes('key')&&!/^(?:assistant|knowledge|supplement|personaReview|autoMerge|autoQuality|dynamicPersonaFactReview|dynamicPersonaRefinement)/.test(key))settings[key]=clone(value);
    for(const prefix of ['provider','dynamicPersona','embedding','rerank'])if(credentialOrigin(oldDoc.value.settings[prefix+'Endpoint']))for(const suffix of ['Endpoint','Model','EndpointMode','AuthMode']){const key=prefix+suffix;if(Object.hasOwn(oldDoc.value.settings,key))settings[key]=clone(oldDoc.value.settings[key]);}
    for(const key of ['autoSummaryEnabled','dynamicPersonaEnabled','vectorEnabled','vectorAutoUpdate'])if(!Object.hasOwn(oldDoc.value.settings,key))settings[key]=false;
    for(const key of ['autoMergeEnabled','autoQualityEnabled'])settings[key]=false;
  }
  if(stableStringify(settings)!==stableStringify(saved)){await check();await verifiedWrite(next,mapped,{...(current.value??oldDoc.value),version:1,defaultsMigration:'0.21.87-ready-defaults',settings});await check();}
  for(const kind of ['summary','dynamicPersona','embedding','rerank']){const key=kind+'-v1',namespace='shiyi-device-credentials',dest={namespace:identity.namespace(namespace),key};if((await optionalLegacyRead(next,dest)).found)continue;const row=await optionalLegacyRead(old,{namespace,key});await check();if(!row.found)continue;const v=row.value,prefix=kind==='summary'?'provider':kind,origin=credentialOrigin(settings[prefix+'Endpoint']);if(v?.version===1&&typeof v.value==='string'&&v.value.length<=16384&&!/[\r\n]/.test(v.value)&&typeof v.origin==='string'&&v.origin&&v.origin===origin&&credentialOrigin(v.origin)===origin){await verifiedWrite(next,dest,v);await check();}}
  const a={namespace:WORKSPACE,key:sha256({configuration:'installation-v1'}).slice(0,24)+'-custom-modules'},dest={...a,namespace:identity.namespace(WORKSPACE)};
  if(!(await optionalLegacyRead(next,dest)).found){const row=await optionalLegacyRead(old,a);await check();if(row.found){await verifiedWrite(next,dest,row.value);await check();}}
}
const meaningful=value=>Array.isArray(value)?value.length>0:Boolean(value&&((value.profiles?.length??0)>0||(value.batches?.length??0)>0||value.manualPlan||value.batchRemoval));

/** Copies one exact logical chat to an inactive Memo-owned namespace. All old
 * reads remain read-only. Only the final receipt activates the staged graph;
 * interrupted copies never become an empty or half-imported working chat. */
export function prepareLegacyMemory(options){return memoStorageLock(options.target,options.identity.prefix+'legacy-'+sha256(scopeKey(options.scope)).slice(0,32),()=>prepareLegacyMemoryLocked(options));}
async function prepareLegacyMemoryLocked({source,target,scope,identity,check=()=>{},sourceSettings={}}){
  const sourceStore=source?losslessStore(source):null,targetStore=losslessStore(target),S=scopeKey(scope),scopeHash=sha256(S).slice(0,32),wp=sha256(scope).slice(0,24);
  const receiptAddress={namespace:identity.namespace('legacy-memory-import'),key:scopeHash},pointerKey=`scope-${scopeHash}-pointer`;
  const read=async(store,address)=>{await check();const row=await optionalLegacyRead(store,address);await check();return row;};
  const existing=await read(targetStore,receiptAddress);
  if(existing.found){const r=existing.value;if(r?.version!==1||r.kind!=='memo-legacy-memory-import'||r.scopeKey!==S||r.completed!==true||typeof r.namespacePrefix!=='string'||!new RegExp('^'+identity.prefix+'import-[a-f0-9]{32}-$').test(r.namespacePrefix))throw fail('旧拾忆接续回执无效，未读取为空存档');return {status:'imported',namespacePrefix:r.namespacePrefix,receipt:r};}
  if(!sourceStore)return {status:'absent'};
  const sourceHeads=new Map();
  const head=async(ns,key)=>{const a={namespace:ns,key},r=await read(sourceStore,a);sourceHeads.set(JSON.stringify(a),{address:a,found:r.found,hash:r.found?sha256(r.value):null});return r;};
  const pointer=await head(MEMORY,pointerKey),batches=await head(WORKSPACE,wp+'-summary-batches'),persona=await head(WORKSPACE,wp+'-dynamic-persona');
  if(!pointer.found&&!meaningful(batches.value)&&!meaningful(persona.value))return {status:'absent'};
  const assertEmpty=async()=>{const p=await read(targetStore,{namespace:identity.namespace(MEMORY),key:pointerKey});if(p.found)throw fail('Memo 已有记忆成果，未覆盖；旧拾忆成果仍完整保留','MEMO_LEGACY_DATA_CONFLICT');for(const name of ['summary-batches','dynamic-persona'])if(meaningful((await read(targetStore,{namespace:identity.namespace(WORKSPACE),key:wp+'-'+name})).value))throw fail('Memo 已有总结或人设进度，未覆盖旧数据或新成果','MEMO_LEGACY_DATA_CONFLICT');};
  await assertEmpty();
  if(pointer.found&&(stableStringify(pointer.value?.scope)!==stableStringify(scope)||pointer.value.scopeKey!==S))throw fail('旧拾忆聊天身份不匹配，未接入其它聊天');
  for(const name of roots)if(!['summary-batches','dynamic-persona'].includes(name))await head(WORKSPACE,wp+'-'+name);
  await head('shiyi-product-settings','current-'+wp);await head(MEMORY,keyOf('task-catalog',S));
  const generation=sha256([...sourceHeads.values()].map(h=>[h.address,h.hash])).slice(0,32),namespacePrefix=identity.prefix+'import-'+generation+'-';
  const entries=new Map(),operations=new Set(),versions=new Set(),workQueue=[],operationQueue=[],seenWork=new Set(),seenOps=new Set();let copiedBytes=0,turn=Date.now();
  const yieldTurn=async()=>{if(Date.now()-turn>=8){await new Promise(r=>setTimeout(r,0));turn=Date.now();await check();}};
  const enqueueWork=(name,required=false)=>{if(typeof name!=='string'||!name||name.length>256||/[\u0000-\u001f]/.test(name))throw fail('旧拾忆版本引用无效');workQueue.push({name,required});};
  const addOp=id=>{if(typeof id==='string'&&id&&id.length<=512&&!operations.has(id)){operations.add(id);operationQueue.push(id);}};
  function scan(value){if(!value||typeof value!=='object')return;if(Array.isArray(value)){for(const v of value)scan(v);return;}for(const[k,v]of Object.entries(value)){if(['operationId','savedOperationId'].includes(k))addOp(v);if(versionFields.has(k)&&typeof v==='string'&&v&&!versions.has(v)){versions.add(v);enqueueWork(v,true);}scan(v);}if(Number.isSafeInteger(value.startIndex)&&Number.isSafeInteger(value.endIndex)){enqueueWork(`persona-result-${value.startIndex}-${value.endIndex}`);if(value.id&&Array.isArray(value.items)){for(const item of value.items)enqueueWork(`persona-result-${value.id}-${item.startIndex}-${item.endIndex}`);enqueueWork('persona-manual-archive-'+value.id);enqueueWork('persona-rebuild-archive-'+value.id);}}}
  async function copy(ns,key,{required=false,hash,inspect=true}={}){
    const address={namespace:ns,key},id=JSON.stringify(address);if(entries.has(id)){const row=await read(sourceStore,address);if(!row.found||sha256(row.value)!==entries.get(id).hash)throw fail('旧拾忆在接续期间更新，已停止激活');return row.value;}
    const row=await read(sourceStore,address);if(!row.found){if(required)throw fail('旧拾忆成果引用缺失，已停止接续；没有重新总结');return null;}
    const digest=sha256(row.value);if(hash&&digest!==hash)throw fail('旧拾忆成果完整性校验失败，未接入残缺内容');copiedBytes+=JSON.stringify(row.value).length;
    if(entries.size>=20000||copiedBytes>512*1024*1024)throw fail('旧拾忆接续规模超出单次安全范围；旧成果保留');
    const destination={namespace:namespacePrefix+ns,key},prior=await read(targetStore,destination);if(prior.found&&sha256(prior.value)!==digest)throw fail('旧成果暂存与当前快照不一致，未覆盖暂存或正式成果');if(!prior.found)await verifiedWrite(targetStore,destination,row.value,{check:()=>{}});await check();
    entries.set(id,{address,hash:digest});if(inspect)scan(row.value);await yieldTurn();return row.value;
  }
  if(pointer.found){const p=await copy(MEMORY,pointerKey);const m=await copy(MEMORY,p.manifestRef,{required:true,hash:p.manifestSha256});if(m?.kind!=='memory-manifest'||m.scopeKey!==S||!Array.isArray(m.chunks))throw fail('旧拾忆成果清单格式无效');for(const ref of m.chunks){const c=await copy(MEMORY,ref.key,{required:true,hash:ref.sha256});if(c?.scopeKey!==S)throw fail('旧拾忆片段属于其它聊天');}}
  for(const name of roots)enqueueWork(name);
  const settingsAddress={namespace:'shiyi-product-settings',key:'current-'+wp};const oldSettings=await copy(settingsAddress.namespace,settingsAddress.key,{inspect:false});
  // Chat settings are a flat document. Retain both known connection spaces;
  // explicit global values have the same precedence as the old controller.
  const mergedSettings={...oldSettings,...sourceSettings};for(const s of [oldSettings,mergedSettings])if(s?.embeddingEndpoint&&s?.embeddingModel){const k='vectors-'+sha256({endpoint:s.embeddingEndpoint,model:s.embeddingModel}).slice(0,20);for(const name of [k,k+'-jobs-v1',k+'-rebuild-v1',k+'-response-jobs-v1'])enqueueWork(name);}
  const catalogKey=keyOf('task-catalog',S),catalog=await copy(MEMORY,catalogKey);for(const row of Array.isArray(catalog)?catalog:[])addOp(row.operationId);
  while(workQueue.length||operationQueue.length){
    while(workQueue.length){const{name,required}=workQueue.shift();if(seenWork.has(name))continue;seenWork.add(name);const value=await copy(WORKSPACE,wp+'-'+name,{required});if(name.startsWith('vectors-')&&value){const decoded=await decodeVectorDocumentAsync(name,value);if(decoded?.kind==='shiyi-vector-index'&&decoded.version===2){for(const e of Object.values(decoded.entries??{}))for(const part of e.parts??[])enqueueWork(part.key,true);for(const name of decoded.retired??[])enqueueWork(name);}}}
    while(operationQueue.length){const id=operationQueue.shift();if(seenOps.has(id))continue;seenOps.add(id);await copy(MEMORY,keyOf('operation',id));await copy(MEMORY,keyOf('checkpoint',S+'|'+id));const old=await read(sourceStore,{namespace:MEMORY,key:keyOf('checkpoint',id)});if(old.found&&old.value?.scopeKey===S)await copy(MEMORY,keyOf('checkpoint',id));await copy(MEMORY,keyOf('task',S+'|'+id));}
  }
  // Confirm the entire copied generation, not only its visible card projection.
  for(const row of entries.values()){const current=await read(sourceStore,row.address);if(!current.found||sha256(current.value)!==row.hash)throw fail('旧拾忆仍在更新，已停止本次接续；请暂停旧版后重试');await yieldTurn();}
  for(const h of sourceHeads.values()){const current=await read(sourceStore,h.address);if(current.found!==h.found||(current.found?sha256(current.value):null)!==h.hash)throw fail('旧拾忆进度在接续时发生变化，请暂停旧版后重试');}
  await assertEmpty();
  const activated=await read(targetStore,receiptAddress);if(activated.found){const r=activated.value;if(r?.version!==1||r.kind!=='memo-legacy-memory-import'||r.scopeKey!==S||r.completed!==true||typeof r.namespacePrefix!=='string'||!new RegExp('^'+identity.prefix+'import-[a-f0-9]{32}-$').test(r.namespacePrefix))throw fail('接续回执已变化，未覆盖已有成果');return {status:'imported',namespacePrefix:r.namespacePrefix,receipt:r};}
  const receipt={version:1,kind:'memo-legacy-memory-import',completed:true,scope:clone(scope),scopeKey:S,namespacePrefix,sourceGeneration:generation,documents:entries.size,copiedChars:copiedBytes,entryHashes:[...entries.values()],createdAt:Date.now()};await verifiedWrite(targetStore,receiptAddress,receipt);await check();return {status:'imported',namespacePrefix,receipt};
}
