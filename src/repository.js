import {
  PersistenceError,
  RevisionConflictError,
  ScopeConflictError,
  ValidationError,
} from './errors.js';
import {
  assertValidDraftBundle,
  dedupeEvents,
  eventIdentity,
  normalizeScope,
  scopeKey,
  validateDraftBundle,
} from './contracts.js';
import { clone, isPlainObject, makeId, sha256, sha256Async, stableStringify } from './utils.js';
import { mergeEventDetails, exactEventDuplicate } from './event-consolidation.js';
import {losslessStore,verifiedWrite,runStorageOperation} from './reliable-storage.js';

// Admit host/stop callbacks without prioritized scheduler continuations or
// repeated nested-timer clamping. Close both ports after every local turn.
async function yieldScopeRead(check){
  if(typeof MessageChannel==='function')await new Promise(resolve=>{const channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();channel.port2.close();resolve();};channel.port2.postMessage(null);});
  else await new Promise(resolve=>setTimeout(resolve,0));
  check();
}

// Small scopes keep their existing in-turn fast path. A native digest adds
// I/O turns even for tiny payloads; long histories amortize that offload.
async function hashScopeValue(value,check,offloadSmall=false){
  const serialized=stableStringify(value)??'undefined';
  if(!offloadSmall&&serialized.length<=32768)return sha256(serialized);
  return sha256Async(serialized,{yieldTask:()=>yieldScopeRead(check)});
}

const DEFAULT_NAMESPACE = 'shiyi-memory-core';
// One-operation capabilities only. Ordinary reads still verify every chunk.
// A serialized JSON snapshot cannot qualify for the in-memory reuse path.
const VERIFIED_SCOPE_READS=new WeakMap();
const CATEGORIES = [
  'events',
  'awarenessChanges',
  'entityFactChanges',
  'relationshipChanges',
  'personaChanges',
  'commitmentChanges',
  'performanceHints',
  'summaryView',
  'conflicts',
];

// The manual-note form creates an exact knowledge mirror for each user-selected
// person. A correction to that note must also correct these derived mirrors.
// Project from immutable originals so old installations benefit without a
// migration. Independent knowledge edits, model summaries and historical
// knowledge with a different proposition/source are never rewritten.
function projectManualNoteKnowledge(records, controls) {
  const events = new Map(records.events.map(r => [r.id, r]));
  records.awarenessChanges = records.awarenessChanges.map(row => {
    const event = events.get(row.eventRef), patch = controls.edits?.[event?.id];
    if (!event || !patch || Object.hasOwn(controls.edits ?? {}, row.id)
      || !String(event.id).startsWith('note_') || !String(row.id).startsWith('aware_')
      || event.subject !== '用户补充设定' || event.epistemicStatus !== 'user_asserted'
      || row.via !== 'user_confirmed' || row.status !== 'known'
      || row.knowledge !== event.description || typeof patch.description !== 'string'
      || !patch.description.trim() || event.sourceRefs?.length !== 1
      || !String(event.sourceRefs[0].sourceId).startsWith('user-note_')
      || stableStringify(row.sourceRefs) !== stableStringify(event.sourceRefs)) return row;
    return { ...row, knowledge: patch.description, description: patch.description,
      content: patch.description, fact: patch.description, entities: [], tags: [], recallSummary: null };
  });
}

// HostStore has no CAS in the public contract.  Repositories sharing one
// store therefore coordinate in-process by scope.  This closes the race
// between two MemoryRepository instances in one extension process; a second
// process/device still requires a host CAS and must be treated as unverified.
const STORE_SCOPE_LOCKS = new WeakMap();

function lockState(store, scope) {
  let byScope = STORE_SCOPE_LOCKS.get(store);
  if (!byScope) { byScope = new Map(); STORE_SCOPE_LOCKS.set(store, byScope); }
  const key = scopeKey(scope);
  let state = byScope.get(key);
  if (!state) { state = { tail: Promise.resolve() }; byScope.set(key, state); }
  return state;
}

async function withScopeLock(store, scope, task) {
  const state = lockState(store, scope);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const previous = state.tail;
  state.tail = previous.then(() => gate);
  await previous;
  try { return await task(); } finally { release(); }
}

function safeKey(prefix, input) {
  return `${prefix}-${sha256(input).slice(0, 32)}`;
}

async function optionalGet(store, args) {
  if (typeof store.tryGetJson === 'function') return store.tryGetJson(args);
  try {
    const value = await store.getJson(args);
    return value === undefined ? { found: false } : { found: true, value };
  } catch (error) {
    if (error?.code === 'NOT_FOUND') return { found: false };
    throw error;
  }
}

// A manifest already names these targets. Missing required data is corruption,
// not an optional empty scope; avoid a native directory scan before every read.
async function requiredGet(store,args,missingMessage) {
  try {
    if(typeof store.getJson==='function') {
      const value=await store.getJson(args);
      if(value===undefined)throw new PersistenceError(missingMessage);
      return value;
    }
    const found=await optionalGet(store,args);
    if(!found.found)throw new PersistenceError(missingMessage);
    return found.value;
  } catch(error) {
    if(['PERSISTENCE_ERROR','CANCELED','CHAT_CHANGED','SOURCE_INVALIDATED','SCOPE_CONFLICT','REVISION_CONFLICT'].includes(error?.code))throw error;
    throw new PersistenceError(missingMessage,{reason:'storage_read',storageStage:'read',storageArtifact:'memory',causeError:error});
  }
}

function captureScope(repository,snapshot,chunks,{includeOperations=[],excludeOperations=[],includeHistory=true}={},materialized=null) {
  VERIFIED_SCOPE_READS.set(snapshot,{store:repository.store,namespace:repository.namespace,scopeKey:scopeKey(snapshot.scope),pointer:clone(snapshot.pointer),refs:clone(snapshot.manifest?.chunks??[]),chunks,
    projectionKey:stableStringify({includeOperations,excludeOperations,includeHistory}),materialized:materialized?clone(materialized):null});
}

async function confirmScopeReuse(repository,frozenScope,reuseSnapshot,expectedPointer,check) {
  const reuse=VERIFIED_SCOPE_READS.get(reuseSnapshot);
  const mismatch=()=>new PersistenceError('本次存储快照已变化，请重新读取',{storageArtifact:'memory',storageStage:'compare',reason:'storage_mismatch'});
  if(!reuse||reuse.store!==repository.store||reuse.namespace!==repository.namespace||reuse.scopeKey!==scopeKey(frozenScope))throw mismatch();
  VERIFIED_SCOPE_READS.delete(reuseSnapshot);
  const header=await repository._readScopeHeader(frozenScope,check);
  if(!header.pointer.manifestRef||stableStringify(reuse.refs)!==stableStringify(header.manifest.chunks??[])||stableStringify(expectedPointer??reuse.pointer)!==stableStringify(header.pointer))throw mismatch();
  return {header,reuse};
}

async function projectScope(repository,header,verifiedChunks,{includeOperations=[],excludeOperations=[],includeHistory=true,check=()=>{}}={},captureChunks=false) {
  const {scope:frozenScope,pointer,manifest}=header;
  if(!manifest)return {scope:frozenScope,committedRevision:0,records:emptyRecords(),pointer,manifest:null};
  const chunks=(manifest.chunks??[]).map(ref=>verifiedChunks.get(ref.key));
  const controls=manifest.controls??{operations:{},deletedRecords:{},edits:{}};
  const parent=id=>id?.split('/child-')[0];
  const visible=chunk=>!excludeOperations.includes(parent(chunk.operationId))&&(!['pending','deleted'].includes(controls.operations?.[parent(chunk.operationId)])||includeOperations.includes(parent(chunk.operationId)));
  const records=await mergeRecords(chunks.filter(visible),check);
  records.history=[];let nextYield=Date.now()+8;
  // Internal summary reads need effective records, not a second full copy of
  // every immutable generation. Public views and exports retain the audit.
  for(const chunk of includeHistory?chunks:[]){
    records.history.push({revision:chunk.committedRevision,operationId:chunk.operationId,sourceRevision:chunk.sourceRevision,createdAt:chunk.createdAt,scopeKey:chunk.scopeKey,idMap:clone(chunk.idMap??{}),coverage:clone(chunk.coverage),categories:Object.fromEntries(CATEGORIES.map(k=>[k,clone(chunk[k]??[])])),excluded:!visible(chunk)});
    if(Date.now()>=nextYield){await yieldScopeRead(check);nextYield=Date.now()+8;}
  }
  check();
  projectManualNoteKnowledge(records,controls);
  for(const category of CATEGORIES)records[category]=records[category].filter(r=>!controls.deletedRecords?.[r.id]).map(r=>controls.edits?.[r.id]?{...r,...clone(controls.edits[r.id]),epistemicStatus:'user_asserted'}:r);
  const eventIds=new Set(records.events.map(r=>r.id));
  records.awarenessChanges=records.awarenessChanges.filter(r=>[r.eventRef,...(r.eventRefs??[])].filter(Boolean).every(id=>eventIds.has(id)));
  const snapshot={scope:frozenScope,committedRevision:pointer.committedRevision,records,pointer,manifest};
  if(captureChunks)captureScope(repository,snapshot,verifiedChunks,{includeOperations,excludeOperations,includeHistory},snapshot);
  return snapshot;
}

function emptyRecords() {
  return {
    events: [],
    awarenessChanges: [],
    entityFactChanges: [],
    relationshipChanges: [],
    personaChanges: [],
    commitmentChanges: [],
    performanceHints: [],
    summaryView: [],
    conflicts: [],
    coverage: { sourceRefs: [], bridgeRefs: [], processed: [], excluded: [], unprocessed: [] },
    // Non-category views are derived from immutable chunks and are safe for
    // callers to inspect without changing the current record projection.
    history: [],
    idAliases: {},
    // A temporary ID may be reused by a later operation.  Such an ID is not
    // a safe global alias anymore; keep the ambiguity explicit so a caller
    // cannot accidentally resolve an old reference to the new occurrence.
    idAliasAmbiguities: {},
  };
}

function identityForRecord(category, record) {
  if (category === 'events') return eventIdentity(record) ?? `id:${record.id}`;
  if (record?.identityKey) return `${category}:identity:${record.identityKey}`;
  if (record?.id) return `${category}:id:${record.id}`;
  return `${category}:digest:${sha256(record)}`;
}

function recordIdentityKeys(category, record) {
  const keys = [identityForRecord(category, record)];
  if (record?.id) keys.push(`${category}:id:${record.id}`);
  if (category === 'events') {
    if (record?.identityKey) keys.push(`events:identity:${record.identityKey}`);
    if (record?.eventIdentity) keys.push(`events:eventIdentity:${record.eventIdentity}`);
  }
  return [...new Set(keys.filter(Boolean))];
}

function mergeRecordRevision(previous, next, revision, operationId, { canonicalId = previous?.id, eventRecord=false } = {}) {
  const merged = eventRecord ? mergeEventDetails(previous,next) : { ...clone(previous), ...clone(next) };
  // The first durable event ID is the canonical address of the occurrence.
  // A later extraction can choose a different id while carrying the same
  // identityKey; keeping the old ID means already committed awareness and
  // dependency records remain valid without relying on a lossy cache rewrite.
  if (canonicalId) merged.id = canonicalId;
  if (Array.isArray(previous?.sourceRefs) || Array.isArray(next?.sourceRefs)) {
    const refs = [...(previous?.sourceRefs ?? []), ...(next?.sourceRefs ?? [])];
    merged.sourceRefs = refs.filter((ref, index) => refs.findIndex((candidate) => stableStringify(candidate) === stableStringify(ref)) === index).map(clone);
  }
  // Keep an explicit audit pointer on the current view.  The full prior
  // values remain in `history`, so a revision can be inspected or reversed.
  merged.revisedAtRevision = revision;
  merged.revisedByOperation = operationId;
  if (next?.lifecycleState === 'retracted' || next?.lifecycle === 'retracted' || next?.retracted === true) {
    merged.lifecycleState = 'retracted';
    merged.retractedAtRevision = revision;
  }
  return merged;
}

async function mergeRecords(chunks,check=()=>{}) {
  const result = emptyRecords();let nextYield=Date.now()+8;
  const categoryIndexes=new Map(),dirtyIndexes=new Set(CATEGORIES),coverageKeys=new Map();
  for (const chunk of chunks) {
    const revision = Number.isInteger(chunk?.committedRevision) ? chunk.committedRevision : result.history.length + 1;
    const operationId = chunk?.operationId ?? null;
    for (const category of CATEGORIES) {
      let indexes=categoryIndexes.get(category);
      if(dirtyIndexes.has(category)){
        indexes=new Map();
        for(let index=0;index<result[category].length;index++)for(const key of recordIdentityKeys(category,result[category][index]))indexes.set(key,index);
        categoryIndexes.set(category,indexes);dirtyIndexes.delete(category);
      }
      for (const record of chunk?.[category] ?? []) {
        const keys = recordIdentityKeys(category, record);
        const existingIndex = keys.map((key) => indexes.get(key)).find((index) => index !== undefined);
        if (existingIndex === undefined) {
          const index = result[category].push(clone(record)) - 1;
          for (const key of keys) indexes.set(key, index);
        } else {
          // A revision can replace identity keys. Rebuild before the NEXT
          // chunk, preserving the existing within-chunk alias semantics.
          dirtyIndexes.add(category);
          const previousRecord = result[category][existingIndex];
          if (category === 'events' && previousRecord?.id && record?.id && previousRecord.id !== record.id) {
            // Preserve both directions for readers holding either revision's
            // ID.  The old ID remains canonical in the materialized view.
            result.idAliases[record.id] = previousRecord.id;
          }
          result[category][existingIndex] = mergeRecordRevision(previousRecord, record, revision, operationId, {
            canonicalId: category === 'events' ? previousRecord?.id : undefined,
            eventRecord: category === 'events',
          });
          for (const key of recordIdentityKeys(category, result[category][existingIndex])) indexes.set(key, existingIndex);
        }
      }
    }
    // projectScope builds the complete audit history once, including excluded
    // chunks. Only its length is needed here for legacy revision fallback.
    result.history.push({revision});
    for (const [from, to] of Object.entries(chunk?.idMap ?? {})) {
      const prior = result.idAliases[from];
      if (isTemporaryId(from) && prior && prior !== to) {
        const values = new Set(result.idAliasAmbiguities[from] ?? [prior]);
        values.add(to);
        result.idAliasAmbiguities[from] = [...values];
        delete result.idAliases[from];
      } else if (!result.idAliasAmbiguities[from]) {
        result.idAliases[from] = to;
      }
    }
    for (const key of ['sourceRefs', 'bridgeRefs', 'processed', 'excluded', 'unprocessed']) {
      const values = Array.isArray(chunk.coverage?.[key]) ? chunk.coverage[key] : [];
      if(!coverageKeys.has(key))coverageKeys.set(key,new Set());
      const known=coverageKeys.get(key);
      for (const value of values) {
        const identity = stableStringify(value);
        if (!known.has(identity)) { result.coverage[key].push(clone(value)); known.add(identity); }
      }
    }
    if(Date.now()>=nextYield){await yieldScopeRead(check);nextYield=Date.now()+8;}
  }
  check();
  // Apply identity aliases to all dependent records after revisions have
  // established their canonical event IDs.  This also handles an awareness
  // record emitted in the same chunk as e2.
  for (const category of CATEGORIES) {
    result[category] = result[category].map((record) => remapReferences(record, result.idAliases));
  }
  // An event can be mentioned repeatedly by model context or a later summary;
  // one event identity remains one occurrence.  Any temporary IDs removed by
  // this pass are remapped through every dependent category as well.
  const deduped = dedupeEvents(result.events);
  if (deduped.idMap?.size) {
    result.events = deduped.events;
    for (const category of CATEGORIES) result[category] = result[category].map((record) => remapReferences(record, deduped.idMap));
  for (const [from, to] of deduped.idMap) {
    const prior = result.idAliases[from];
    if (isTemporaryId(from) && prior && prior !== to) {
      const values = new Set(result.idAliasAmbiguities[from] ?? [prior]);
      values.add(to);
      result.idAliasAmbiguities[from] = [...values];
      delete result.idAliases[from];
    } else if (!result.idAliasAmbiguities[from]) {
      result.idAliases[from] = to;
    }
  }
  } else result.events = deduped.events;
  // Retraction/supersession may be represented as an auditable change record
  // that points at an earlier event rather than duplicating its payload.
  for (const category of CATEGORIES) {
    if (category === 'events') continue;
    for (const record of result[category]) {
      const changeKind = String(record?.changeKind ?? record?.operation ?? record?.lifecycleAction ?? '').toLocaleLowerCase();
      const targetId = record?.eventRef ?? record?.eventId ?? record?.sourceEventId;
      if (!targetId || !['retract', 'retracted', 'withdraw', 'withdrawn', 'supersede', 'superseded'].includes(changeKind)) continue;
      const target = result.events.find((event) => event.id === targetId || result.idAliases?.[targetId] === event.id);
      if (!target) continue;
      target.lifecycleState = changeKind.startsWith('super') ? 'superseded' : 'retracted';
      target.lifecycleOperationId = record.id ?? null;
    }
  }
  return result;
}

function isTemporaryId(id) {
  return typeof id === 'string' && /^(?:tmp|temp|temporary)(?:[-_]|$)/iu.test(id);
}

function remapReferences(record, idMap) {
  const result = clone(record);
  const has = (key) => typeof idMap?.has === 'function'
    ? idMap.has(key)
    : Boolean(idMap && Object.prototype.hasOwnProperty.call(idMap, key));
  const get = (key) => typeof idMap?.get === 'function' ? idMap.get(key) : idMap?.[key];
  const resolve = (value) => {
    let current = value;
    const seen = new Set();
    while (typeof current === 'string' && has(current) && !seen.has(current)) {
      seen.add(current);
      current = get(current);
    }
    return current;
  };
  for (const key of ['eventRef', 'eventId', 'sourceEventId', 'recordRef', 'recordId', 'completionOf', 'correctionOf', 'supersedes']) {
    if (typeof result[key] === 'string' && has(result[key])) result[key] = resolve(result[key]);
  }
  for (const key of ['eventRefs', 'eventIds', 'recordRefs', 'recordIds']) {
    if (Array.isArray(result[key])) result[key] = result[key].map((value) => has(value) ? resolve(value) : value);
  }
  if(result.mergeReview?.targetId&&has(result.mergeReview.targetId))result.mergeReview.targetId=resolve(result.mergeReview.targetId);
  return result;
}

function materializeBundle(bundle, scope, existingAliases = {}, previousRecords = null) {
  const idMap = new Map(Object.entries(existingAliases?.idAliases ?? existingAliases ?? {}));
  for (const ambiguousId of Object.keys(existingAliases?.idAliasAmbiguities ?? {})) idMap.delete(ambiguousId);
  const all = [...(bundle.events ?? []), ...(bundle.awarenessChanges ?? []), ...(bundle.entityFactChanges ?? []), ...(bundle.relationshipChanges ?? []), ...(bundle.personaChanges ?? []), ...(bundle.commitmentChanges ?? []), ...(bundle.performanceHints ?? []), ...(bundle.summaryView ?? []), ...(bundle.conflicts ?? [])];
  const priorByIdentity = new Map();
  for (const record of previousRecords?.events ?? []) {
    const identity = eventIdentity(record);
    if (identity && record?.id && !priorByIdentity.has(identity)) priorByIdentity.set(identity, record.id);
  }
  // Temporary IDs are scoped to this operation.  A matching explicit event
  // identity can deliberately reconnect to the old canonical event; otherwise
  // include operationId and source revision so reusing tmp-1 cannot address a
  // prior occurrence by accident.
  for (const record of bundle.events ?? []) {
    if (!isTemporaryId(record?.id)) continue;
    const identity = eventIdentity(record);
    // A staged contribution owns its new batch evidence. Reusing an older
    // identical ID here would revive an old merge vote on regeneration.
    const priorId = record.mergeReview?.status==='pending' ? null : (identity ? priorByIdentity.get(identity) : null) ?? (previousRecords?.events??[]).find(e=>exactEventDuplicate(e,record))?.id;
    const durableId = priorId ?? `memory_${sha256(`${scopeKey(scope)}|${bundle.operationId}|${record.id}|${identity ?? ''}|${bundle.sourceRevision ?? ''}|${stableStringify(record)}`).slice(0, 28)}`;
    idMap.set(record.id, durableId);
  }
  for (const record of all) {
    if (!isTemporaryId(record?.id) || (bundle.events ?? []).some((event) => event?.id === record.id)) continue;
    idMap.set(record.id, `memory_${sha256(`${scopeKey(scope)}|${bundle.operationId}|${record.id}|${stableStringify(record)}`).slice(0, 28)}`);
  }
  const result = clone(bundle);
  for (const category of CATEGORIES) result[category] = (bundle[category] ?? []).map((record) => {
    const next = remapReferences(record, idMap);
    if (idMap.has(next.id)) next.id = idMap.get(next.id);
    return next;
  });
  result.coverage = clone(bundle.coverage);
  result.idMap = Object.fromEntries(idMap);
  return result;
}

/**
 * Manifest-backed repository.  Every content write is an immutable chunk;
 * only the pointer is mutable.  A broken readback never advances that pointer.
 */
export class MemoryRepository {
  constructor({ store, namespace = DEFAULT_NAMESPACE, now = () => Date.now(), verifySourceRevision = null } = {}) {
    if (!store || typeof store.setJson !== 'function') throw new ValidationError('MemoryRepository requires a JSON store');
    this.store = losslessStore(store);
    this.namespace = namespace;
    this.now = now;
    this.verifySourceRevision = verifySourceRevision;
    this._checkpointCache = new Map();
    this._responseCache = new Map();
    // Kept for diagnostics/backward compatibility.  Actual coordination is
    // shared by all repositories using this store in `STORE_SCOPE_LOCKS`.
    this._writeTail = Promise.resolve();
  }

  _keys(scope) {
    const hash = sha256(scopeKey(scope)).slice(0, 32);
    return {
      pointer: `scope-${hash}-pointer`,
      manifestPrefix: `scope-${hash}-manifest`,
      chunkPrefix: `scope-${hash}-chunk`,
    };
  }

  _operationKey(operationId) { return safeKey('operation', operationId); }
  _checkpointKey(operationId, scope = null) {
    return safeKey('checkpoint', scope ? `${scopeKey(scope)}|${operationId}` : operationId);
  }

  async _getPointer(scope) {
    const keys = this._keys(scope);
    const found = await optionalGet(this.store, { namespace: this.namespace, key: keys.pointer });
    if (!found.found) return { committedRevision: 0, scope: clone(scope), manifestRef: null, operationId: null };
    if (!isPlainObject(found.value)) throw new PersistenceError('committed pointer is malformed');
    if (stableStringify(found.value.scope) !== stableStringify(scope)) throw new ScopeConflictError('stored pointer scope differs from requested scope');
    return found.value;
  }

  async getCommittedRevision(scope) { return (await this._getPointer(normalizeScope(scope))).committedRevision; }

  async readScope(scope, options = {}) {
    if(options.reuseSnapshot) {
      const {includeOperations=[],excludeOperations=[],includeHistory=true,check=()=>{}}=options;
      const {header,reuse}=await confirmScopeReuse(this,normalizeScope(scope),options.reuseSnapshot,null,check);
      check();
      if(reuse.materialized&&reuse.projectionKey===stableStringify({includeOperations,excludeOperations,includeHistory}))return reuse.materialized;
      return projectScope(this,header,reuse.chunks,{includeOperations,excludeOperations,includeHistory,check});
    }
    return this._readScope(scope,options);
  }

  async _readScopeHeader(frozenScope,check=()=>{}) {
    check();const pointer=await this._getPointer(frozenScope);check();
    if(!pointer.manifestRef)return {scope:frozenScope,committedRevision:0,pointer,manifest:null};
    const manifest=await requiredGet(this.store,{namespace:this.namespace,key:pointer.manifestRef},'manifest pointer target is missing');check();
    if(!isPlainObject(manifest)||manifest.scopeKey!==scopeKey(frozenScope)||manifest.committedRevision!==pointer.committedRevision)throw new PersistenceError('manifest does not match committed pointer');
    const manifestHash=await hashScopeValue(manifest,check);check();
    if(!pointer.manifestSha256||manifestHash!==pointer.manifestSha256)throw new PersistenceError('manifest hash does not match committed pointer');
    if(!Array.isArray(manifest.chunks??[]))throw new PersistenceError('manifest chunks are malformed');
    return {scope:frozenScope,committedRevision:pointer.committedRevision,pointer,manifest};
  }

  // Integrity is checked before a controls write, without materializing an old
  // projection that updateControls never uses. The capability stays in RAM.
  async _loadScope(scope,{check=()=>{}}={}) {
    const frozenScope=normalizeScope(scope),loaded=await this._readScopeHeader(frozenScope,check),chunks=new Map();
    let nextYield=Date.now()+8;const offloadSmall=(loaded.manifest?.chunks?.length??0)>=32;
    for(const ref of loaded.manifest?.chunks??[]) {
      check();
      if(!isPlainObject(ref)||typeof ref.key!=='string'||typeof ref.sha256!=='string')throw new PersistenceError('manifest chunk reference is malformed');
      const value=await requiredGet(this.store,{namespace:this.namespace,key:ref.key},`immutable chunk is missing: ${ref.key}`);check();
      const chunkHash=await hashScopeValue(value,check,offloadSmall);check();
      if(chunkHash!==ref.sha256)throw new PersistenceError(`immutable chunk hash mismatch: ${ref.key}`);
      chunks.set(ref.key,value);
      if(Date.now()>=nextYield){await yieldScopeRead(check);nextYield=Date.now()+8;}
    }
    captureScope(this,loaded,chunks);return loaded;
  }

  async _readScope(scope,options={},reuseSnapshot=null,expectedPointer=null,captureChunks=false) {
    const {includeOperations=[],excludeOperations=[],includeHistory=true,check=()=>{}}=options,frozenScope=normalizeScope(scope);
    let header,reuse;
    if(reuseSnapshot)({header,reuse}=await confirmScopeReuse(this,frozenScope,reuseSnapshot,expectedPointer,check));
    else {header=await this._loadScope(frozenScope,{check});reuse=VERIFIED_SCOPE_READS.get(header);VERIFIED_SCOPE_READS.delete(header);}
    check();return projectScope(this,header,reuse.chunks,{includeOperations,excludeOperations,includeHistory,check},captureChunks);
  }

  /** Recoverable view changes: immutable evidence is retained, projection is atomic. */
  async updateControls(scope, patch, { check:callerCheck=()=>{},signal,waitMs=0,returnView=false }={}) {
    const frozen=normalizeScope(scope);
    return runStorageOperation(check=>withScopeLock(this.store,frozen,async()=>{
      check();const previous=await this._loadScope(frozen,{check}),keys=this._keys(frozen);
      check();
      const controls=clone(previous.manifest?.controls??{});
      for(const key of ['operations','deletedRecords','edits','automation'])controls[key]={...controls[key],...clone(patch[key]??{})};
      const revision=previous.committedRevision+1,operationId=makeId('memory-view');
      const manifest={schemaVersion:1,kind:'memory-manifest',scope:frozen,scopeKey:scopeKey(frozen),committedRevision:revision,chunks:previous.manifest?.chunks??[],controls,operationId,createdAt:this.now()};
      const manifestSha256=sha256(manifest),manifestRef=`${keys.manifestPrefix}-${revision}-${manifestSha256.slice(0,20)}`;
      await verifiedWrite(this.store,{namespace:this.namespace,key:manifestRef},manifest,{check});
      check();const current=await this._getPointer(frozen);
      check();
      if(stableStringify(current)!==stableStringify(previous.pointer))throw new RevisionConflictError('memory controls revision changed');
      const pointer={schemaVersion:1,kind:'memory-pointer',scope:frozen,scopeKey:scopeKey(frozen),committedRevision:revision,manifestRef,manifestSha256,operationId,updatedAt:this.now()};
      await verifiedWrite(this.store,{namespace:this.namespace,key:keys.pointer},pointer,{check});
      check();
      let viewSnapshot=null;
      if(returnView==='deferred'){
        // Internal activation hands a single-use verified chunk capability to
        // the following read. No caller-visible full projection exists yet,
        // so there is no need to retain a protective second materialization.
        const verified=VERIFIED_SCOPE_READS.get(previous);VERIFIED_SCOPE_READS.delete(previous);
        viewSnapshot={scope:frozen,committedRevision:revision,pointer,manifest};
        captureScope(this,viewSnapshot,verified.chunks);
      }else if(returnView)viewSnapshot=await this._readScope(frozen,{check},previous,pointer,true);
      if(!returnView)VERIFIED_SCOPE_READS.delete(previous);
      check();
      return {status:'saved',committedRevision:revision,...(viewSnapshot?{viewSnapshot}:{})};
    }),{check:callerCheck,signal,waitMs,storageArtifact:'memory'});
  }

  async _findReceipt(operationId) {
    return optionalGet(this.store, { namespace: this.namespace, key: this._operationKey(operationId) });
  }

  async commitBundle(bundle, options = {}) {
    const frozenScope = normalizeScope(options.scope ?? bundle?.scope);
    return withScopeLock(this.store, frozenScope, () => this._commitBundle(bundle, options));
  }

  async _commitBundle(bundle, {
    scope = bundle?.scope,
    expectedRevision = bundle?.expectedRevision,
    sourceRevision = bundle?.sourceRevision,
    controlsPatch = null,
  } = {}) {
    const frozenScope = normalizeScope(scope);
    const binding = { scope: frozenScope, operationId: bundle?.operationId, expectedRevision };
    const operationId = bundle.operationId;
    const bundleHash = sha256(controlsPatch?{bundle,controlsPatch}:bundle);
    const existingReceipt = await this._findReceipt(operationId);
    if (existingReceipt.found) {
      const receipt = existingReceipt.value;
      if (receipt.scopeKey !== scopeKey(frozenScope)) throw new ScopeConflictError('operationId was previously used by another scope', receipt);
      if (receipt.bundleHash !== bundleHash) throw new ScopeConflictError('operationId was previously used for different content', receipt);
      return { ...clone(receipt), idempotent: true };
    }
    const current = await this._getPointer(frozenScope);
    if (current.operationId === operationId && current.bundleHash === bundleHash && current.committedRevision >= expectedRevision) {
      await this.readScope(frozenScope);
      return { operationId, scope:clone(frozenScope),scopeKey:scopeKey(frozenScope),sourceRevision,bundleHash,expectedRevision,committedRevision: current.committedRevision, manifestRef: current.manifestRef, idempotent: true, readbackVerified: true };
    }
    if (current.committedRevision !== expectedRevision) {
      throw new RevisionConflictError('expected revision does not match committed revision', { expectedRevision, actualRevision: current.committedRevision });
    }
    // Validate references against the authoritative same-scope snapshot.  A
    // later batch may add awareness or a correction for an older event, but a
    // record from another scope/branch is never accepted as context.
    const previous = await this.readScope(frozenScope,{includeOperations:[operationId.split('/child-')[0]],includeHistory:false});
    const knownRecordIds = new Set();
    for (const category of CATEGORIES) {
      for (const record of previous.records?.[category] ?? []) if (record?.id) knownRecordIds.add(record.id);
    }
    for (const [from, to] of Object.entries(previous.records?.idAliases ?? {})) {
      if (previous.records?.idAliasAmbiguities?.[from]) continue;
      knownRecordIds.add(from);
      knownRecordIds.add(to);
    }
    const trustedCorrectionIds = new Set(bundle?.binding?.correctionAuthorizations ?? []);
    const validation = validateDraftBundle(bundle, {
      expectedBinding: binding,
      knownRecordIds,
      existingFacts: previous.records?.entityFactChanges ?? [],
      enforceCorrectionAuthority: true,
      trustedCorrectionIds,
    });
    if (!validation.valid) throw new ValidationError('cannot commit invalid DraftBundle', validation);
    if (sourceRevision !== undefined && bundle.sourceRevision !== undefined && sourceRevision !== bundle.sourceRevision) {
      throw new RevisionConflictError('source revision changed before commit', { expectedSourceRevision: sourceRevision, bundleSourceRevision: bundle.sourceRevision });
    }
    if (typeof this.verifySourceRevision === 'function') {
      const actualSourceRevision = await this.verifySourceRevision({ scope: clone(frozenScope), bundle: clone(bundle) });
      if (actualSourceRevision !== bundle.sourceRevision) {
        throw new RevisionConflictError('frozen source revision changed before commit', { expectedSourceRevision: bundle.sourceRevision, actualSourceRevision });
      }
    }
    const materialized = materializeBundle(bundle, frozenScope, previous.records, previous.records);
    const revision = current.committedRevision + 1;
    const keys = this._keys(frozenScope);
    const chunkKey = `${keys.chunkPrefix}-${revision}-${sha256(`${operationId}|${bundleHash}`).slice(0, 20)}`;
    const chunk = {
      schemaVersion: 1,
      kind: 'immutable-memory-chunk',
      bundleHash,
      scope: clone(frozenScope),
      scopeKey: scopeKey(frozenScope),
      operationId,
      sourceRevision,
      committedRevision: revision,
      createdAt: this.now(),
      ...Object.fromEntries(CATEGORIES.map((category) => [category, clone(materialized[category] ?? [])])),
      coverage: clone(materialized.coverage),
      idMap: clone(materialized.idMap),
    };
    const chunkHash = sha256(chunk);
    try {
      await verifiedWrite(this.store,{namespace:this.namespace,key:chunkKey},chunk);
      const manifest = {
        schemaVersion: 1,
        kind: 'memory-manifest',
        scope: clone(frozenScope),
        scopeKey: scopeKey(frozenScope),
        committedRevision: revision,
        chunks: [...(previous.manifest?.chunks ?? []), { key: chunkKey, sha256: chunkHash }],
        ...((previous.manifest?.controls||controlsPatch)?{controls:Object.fromEntries(['operations','deletedRecords','edits'].map(key=>[key,{...clone(previous.manifest?.controls?.[key]??{}),...clone(controlsPatch?.[key]??{})}]))}:{}),
        operationId,
        sourceRevision,
        bundleHash,
        createdAt: this.now(),
      };
      const manifestRef = `${keys.manifestPrefix}-${revision}-${sha256(manifest).slice(0, 20)}`;
      const manifestSha256 = sha256(manifest);
      await verifiedWrite(this.store,{namespace:this.namespace,key:manifestRef},manifest);
      // Source storage may be edited while the immutable chunk/manifest are
      // being written.  Recheck immediately before the mutable pointer write
      // so the new revision can never become visible for stale input.
      if (typeof this.verifySourceRevision === 'function') {
        const finalSourceRevision = await this.verifySourceRevision({ scope: clone(frozenScope), bundle: clone(bundle), phase: 'before-pointer' });
        if (finalSourceRevision !== bundle.sourceRevision) {
          throw new RevisionConflictError('source revision changed during storage I/O', { expectedSourceRevision: bundle.sourceRevision, actualSourceRevision: finalSourceRevision, phase: 'before-pointer' });
        }
      }
      const pointer = {
        schemaVersion: 1,
        kind: 'memory-pointer',
        scope: clone(frozenScope),
        scopeKey: scopeKey(frozenScope),
        committedRevision: revision,
        manifestRef,
        manifestSha256,
        operationId,
        sourceRevision,
        bundleHash,
        updatedAt: this.now(),
      };
      await verifiedWrite(this.store,{namespace:this.namespace,key:keys.pointer},pointer);
      const receipt = {
        schemaVersion: 1,
        operationId,
        scope: clone(frozenScope),
        scopeKey: scopeKey(frozenScope),
        expectedRevision,
        sourceRevision,
        committedRevision: revision,
        manifestRef,
        bundleHash,
        readbackVerified: true,
        committedAt: this.now(),
      };
      // A receipt is diagnostic/idempotency metadata.  Pointer is written only
      // after every immutable piece has verified. Missing receipts are recovered
      // from that verified chain, not treated as a failed memory commit.
      try{await verifiedWrite(this.store,{namespace:this.namespace,key:this._operationKey(operationId)},receipt);}
      catch{receipt.receiptPending=true;}
      return clone(receipt);
    } catch (error) {
      if (error instanceof PersistenceError || error instanceof RevisionConflictError || error instanceof ScopeConflictError) throw error;
      throw new PersistenceError('memory commit failed before pointer verification', { causeError:error,storageArtifact:'memory',storageStage:'write',stage:'storage',operationId });
    }
  }

  async commitDraftBundle(bundle, options = {}) { return this.commitBundle(bundle, options); }

  async saveCheckpoint(operationId, checkpoint) {
    if (!operationId) throw new ValidationError('checkpoint operationId is required');
    const supplied = clone(checkpoint ?? {});
    const frozenScope = supplied.scope ? normalizeScope(supplied.scope) : null;
    const value = {
      schemaVersion: 2,
      operationId,
      updatedAt: this.now(),
      ...supplied,
      ...(frozenScope ? { scope: frozenScope, scopeKey: scopeKey(frozenScope) } : {}),
    };
    const cacheKey = `${frozenScope ? scopeKey(frozenScope) : '*'}|${operationId}`;
    await verifiedWrite(this.store,{namespace:this.namespace,key:this._checkpointKey(operationId,frozenScope)},value);
    this._checkpointCache.set(cacheKey, value);
    return clone(value);
  }

  async getCheckpoint(operationId, scope = null) {
    const frozenScope = scope ? normalizeScope(scope) : null;
    const exactKey = `${frozenScope ? scopeKey(frozenScope) : '*'}|${operationId}`;
    if (this._checkpointCache.has(exactKey)) return clone(this._checkpointCache.get(exactKey));
    if (!frozenScope) {
      const matches = [...this._checkpointCache.entries()].filter(([key]) => key.endsWith(`|${operationId}`));
      if (matches.length === 1) return clone(matches[0][1]);
    }
    const found = await optionalGet(this.store, { namespace: this.namespace, key: this._checkpointKey(operationId, frozenScope) });
    if (!found.found) return null;
    if (frozenScope && found.value?.scopeKey && found.value.scopeKey !== scopeKey(frozenScope)) throw new ScopeConflictError('checkpoint scope differs from requested scope', found.value);
    this._checkpointCache.set(exactKey, found.value);
    return clone(found.value);
  }

  async clearCheckpoint(operationId, scope = null) {
    if (!operationId) return;
    const frozenScope = scope ? normalizeScope(scope) : null;
    const exactKey = `${frozenScope ? scopeKey(frozenScope) : '*'}|${operationId}`;
    this._checkpointCache.delete(exactKey);
    if (!frozenScope) {
      for (const key of [...this._checkpointCache.keys()]) {
        if (key.endsWith(`|${operationId}`)) this._checkpointCache.delete(key);
      }
    }
    if (this.store.deleteJson) await this.store.deleteJson({ namespace: this.namespace, key: this._checkpointKey(operationId, frozenScope) });
  }

  async getOperationReceipt(operationId) {
    const found = await this._findReceipt(operationId);
    return found.found ? clone(found.value) : null;
  }

  async recoverOperationReceipt(scope,operationId){
    const found=await this.getOperationReceipt(operationId);
    if(found){if(found.scopeKey!==scopeKey(scope))throw new ScopeConflictError('receipt scope mismatch');return found;}
    const snapshot=await this.readScope(scope),p=snapshot.pointer;
    if(p.operationId!==operationId){
      for(const ref of snapshot.manifest?.chunks??[]){
        const {value:c}=await optionalGet(this.store,{namespace:this.namespace,key:ref.key});
        if(c?.operationId===operationId&&c.bundleHash&&sha256(c)===ref.sha256)return {operationId,scope:clone(scope),scopeKey:scopeKey(scope),sourceRevision:c.sourceRevision,bundleHash:c.bundleHash,committedRevision:c.committedRevision,readbackVerified:true};
      }
      return null;
    }
    return {operationId,scope:clone(scope),scopeKey:scopeKey(scope),sourceRevision:p.sourceRevision,bundleHash:p.bundleHash,committedRevision:p.committedRevision,manifestRef:p.manifestRef,readbackVerified:true};
  }

  async readPrivateTask(scope,operationId) {
    const address={namespace:this.namespace,key:safeKey('task',`${scopeKey(scope)}|${operationId}`)};
    const found=await optionalGet(this.store,address);
    const volatile=this._responseCache.get(`${scopeKey(scope)}|${operationId}`);
    if(!found.found)return clone(volatile??null);
    if(found.value?.scopeKey!==scopeKey(scope)||found.value?.operationId!==operationId)throw new ScopeConflictError('private task scope mismatch');
    if(found.value.updatedAt<this.now()-7*86400000&&!volatile)return null;
    return clone({...found.value,...volatile});
  }

  async savePrivateTask(scope,operationId,patch) {
    const previous=await this.readPrivateTask(scope,operationId);
    const next={...previous,...clone(patch),scopeKey:scopeKey(scope),operationId,updatedAt:this.now()};
    delete next.volatile;
    if(new TextEncoder().encode(JSON.stringify(next)).length>8*1024*1024)throw new PersistenceError('任务暂存超过 8 MB，请缩小批次',{storageStage:'write'});
    await verifiedWrite(this.store,{namespace:this.namespace,key:safeKey('task',`${scopeKey(scope)}|${operationId}`)},next);
    this._responseCache.delete(`${scopeKey(scope)}|${operationId}`);
    // Bounded private recovery storage; never enumerated by memory exports.
    const catalogAddress={namespace:this.namespace,key:safeKey('task-catalog',scopeKey(scope))};
    const catalog=await optionalGet(this.store,catalogAddress);
    const entry={operationId,updatedAt:this.now(),bytes:new TextEncoder().encode(JSON.stringify(next)).length};
    const rows=[...(Array.isArray(catalog.value)?catalog.value:[]).filter(r=>r.operationId!==operationId),entry];
    let total=rows.reduce((n,r)=>n+r.bytes,0);
    const parent=operationId.split('/child-')[0];
    while(rows.length>24||total>32*1024*1024||rows.length>1&&rows[0].updatedAt<this.now()-7*86400000){
      const index=rows.findIndex(r=>r.operationId!==operationId&&r.operationId!==parent);
      if(index<0)break;
      const [old]=rows.splice(index,1);total-=old.bytes;
      const address={namespace:this.namespace,key:safeKey('task',`${scopeKey(scope)}|${old.operationId}`)};
      if(this.store.deleteJson&&(await optionalGet(this.store,address)).found)await this.store.deleteJson(address);
    }
    await verifiedWrite(this.store,catalogAddress,rows);
    return clone(next);
  }

  retainPrivateResponse(scope,operationId,patch){
    if(new TextEncoder().encode(JSON.stringify(patch)).length>8*1024*1024)return;
    const key=`${scopeKey(scope)}|${operationId}`;
    this._responseCache.set(key,{...clone(patch),scopeKey:scopeKey(scope),operationId,volatile:true});
    while(this._responseCache.size>2)this._responseCache.delete(this._responseCache.keys().next().value);
  }

  async clearPrivateTask(scope,operationId){
    this._responseCache.delete(`${scopeKey(scope)}|${operationId}`);
    const address={namespace:this.namespace,key:safeKey('task',`${scopeKey(scope)}|${operationId}`)};
    if(this.store.deleteJson&&(await optionalGet(this.store,address)).found)await this.store.deleteJson(address);
    const catalogAddress={namespace:this.namespace,key:safeKey('task-catalog',scopeKey(scope))};
    const catalog=await optionalGet(this.store,catalogAddress);
    if(Array.isArray(catalog.value)&&catalog.value.some(r=>r.operationId===operationId))await verifiedWrite(this.store,catalogAddress,catalog.value.filter(r=>r.operationId!==operationId));
  }

  async listRecords(scope) { return (await this.readScope(scope)).records; }
}
