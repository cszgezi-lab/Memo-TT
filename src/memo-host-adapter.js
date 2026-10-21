import { createMemoIdentity } from './memo-identity.js';
import {prepareLegacyMemory as prepareMemoLegacyMemory,prepareLegacyGlobal,LEGACY_MEMORY_NAMESPACES,optionalLegacyRead} from './memo-legacy-memory.js';
import {stableStringify} from './utils.js';
import {runStorageOperation} from './reliable-storage.js';

const adapterCache = new WeakMap();
const wrapperOwners = new WeakMap();
const STORE_METHODS = Object.freeze(['getJson', 'tryGetJson', 'setJson', 'updateJson', 'deleteJson', 'listKeys']);
const METADATA_METHODS = new Set(['getExtension', 'setExtension', 'deleteExtension']);
const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
const closed = () => Object.assign(new Error('Memo host adapter has been disposed'), { code: 'MEMO_ADAPTER_DISPOSED' });

/** Never proxy a frozen native object as the proxy target: replacing its
 * non-configurable store property would violate JavaScript proxy invariants.
 * Methods still run on the real owner, including native/private-field methods. */
function facade(source, special) {
  const methods = new Map();
  return new Proxy(Object.create(Object.getPrototypeOf(source)), {
    get(_target, key) {
      const override = special(key);
      if (override.found) return override.value;
      const value = Reflect.get(source, key, source);
      if (typeof value !== 'function') return value;
      const prior = methods.get(key);
      if (prior?.original === value) return prior.bound;
      const bound = value.bind(source);
      methods.set(key, { original: value, bound });
      return bound;
    },
    has: (_target, key) => special(key).found || Reflect.has(source, key),
    ownKeys: () => Reflect.ownKeys(source),
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
      if (!descriptor) return undefined;
      return { configurable: true, enumerable: descriptor.enumerable,
        get: () => { const override = special(key); return override.found ? override.value : Reflect.get(source, key, source); } };
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}

/** Isolates all public storage paths, including captured session.handle.store.
 * Construction does no I/O. An explicit captured-chat preparation may copy a
 * verified old generation to Memo-owned storage. No ongoing old-store fallback
 * or source rewrite occurs. The original adapter remains the authority for chat
 * identity, history, capability, cancellation and persistence errors. */
export function createMemoHostAdapter(adapter, { edition, identity, disposeUnderlying = false, independentLifetime = false } = {}) {
  if (!object(adapter)) throw new TypeError('Memo requires a real host adapter');
  identity ??= createMemoIdentity(edition ?? 'tt');
  const canonical = createMemoIdentity(identity.edition);
  if (identity !== canonical || edition !== undefined && edition !== identity.edition) {
    throw new TypeError('Memo requires the matching canonical edition identity');
  }
  const existingOwner = wrapperOwners.get(adapter);
  if (existingOwner) {
    if (existingOwner.identity !== identity) throw new TypeError('Memo cannot wrap another edition adapter');
    if (!independentLifetime) return adapter;
    // Applications share native storage, but own separate cleanup lifetimes.
    adapter = existingOwner.adapter;
  }
  let byIdentity = adapterCache.get(adapter);
  if (!byIdentity) { byIdentity = new Map(); adapterCache.set(adapter, byIdentity); }
  const cached = independentLifetime ? null : byIdentity.get(identity.id);
  if (cached?.status() === 'disposing') throw Object.assign(new Error('Memo host cleanup is still pending'), { code: 'MEMO_ADAPTER_DISPOSING' });
  if (cached?.status() === 'active') {
    if (cached.disposeUnderlying !== disposeUnderlying) throw new TypeError('Memo adapter lifetime ownership is already fixed');
    return cached.wrapper;
  }

  const stores = new WeakMap(), handles = new WeakMap(), metadata = new WeakMap(),contexts=new WeakMap();
  const listeners = new Set(), promptKeys = new Map(), pendingPrompts = new Set();
  let disposed = false, disposal, status = 'active';
  const globalPreparations=new WeakMap();
  const legacyGlobal=async()=>runStorageOperation(()=>typeof adapter.legacyGlobalStore==='function'?adapter.legacyGlobalStore():adapter.getStore?.({scope:'extension'}),{waitMs:10000,storageArtifact:'legacy_memory'});
  const check = () => { if (disposed) throw closed(); };
  const address = (args,context) => {
    if (!object(args) || Array.isArray(args)) throw new TypeError('Memo store address is required');
    return { ...args, namespace: context?.namespacePrefix&&LEGACY_MEMORY_NAMESPACES.includes(args.namespace)?context.namespacePrefix+args.namespace:identity.namespace(args.namespace) };
  };

  function wrapStore(store,context=null) {
    if (!object(store)) return store;
    let owners=stores.get(store);if(!owners){owners=new Map();stores.set(store,owners);}if(owners.has(context))return owners.get(context);
    const wrapped = {};
    // Optional host methods remain optional; do not invent a successful read
    // path or silently turn host errors into an empty/new workspace.
    for (const method of STORE_METHODS) if (typeof store[method] === 'function') {
      wrapped[method] = (...args) => store[method].call(store, address(args[0],context), ...args.slice(1));
    }
    Object.freeze(wrapped); owners.set(context,wrapped);
    return wrapped;
  }

  function wrapMetadata(owner) {
    if (!object(owner)) return owner;
    if (metadata.has(owner)) return metadata.get(owner);
    const mapped = new Map();
    const wrapped = facade(owner, key => {
      if (!METADATA_METHODS.has(key) || typeof owner[key] !== 'function') return { found: false };
      if (!mapped.has(key)) mapped.set(key, (...args) => {
        if (key !== 'getExtension') check();
        if (typeof args[0] === 'string') return owner[key].call(owner, identity.metadataNamespace(args[0]), ...args.slice(1));
        return owner[key].call(owner, { ...args[0], namespace: identity.metadataNamespace(args[0]?.namespace) }, ...args.slice(1));
      });
      return { found: true, value: mapped.get(key) };
    });
    metadata.set(owner, wrapped);
    return wrapped;
  }

  function wrapHandle(handle) {
    if (!object(handle)) return handle;
    if (handles.has(handle)) return handles.get(handle);
    const context={handle,namespacePrefix:null};
    const wrapped = facade(handle, key => key === 'store'
      ? { found: true, value: wrapStore(handle.store,context.namespacePrefix?context:null) }
      : key === 'metadata' ? { found: true, value: wrapMetadata(handle.metadata) } : { found: false });
    handles.set(handle, wrapped);contexts.set(wrapped,context);
    return wrapped;
  }

  const overrides = new Map([
    ['memoIdentity', identity],
    ['prepareLegacyMemory', async (session,options={})=>{
      check();const context=contexts.get(session.handle);if(!context)throw new TypeError('Memo legacy import requires its captured handle');
      const current=async()=>{check();options.check?.();if(options.signal?.aborted)throw Object.assign(new Error('旧成果读取已停止'),{code:'CANCELED'});if(stableStringify(await adapter.currentRef())!==session.refKey)throw Object.assign(new Error('聊天已切换，旧成果接续未激活'),{code:'CHAT_CHANGED'});options.check?.();};await current();
      const completed=await prepareMemoLegacyMemory({source:null,target:context.handle.store,scope:session.scope,identity,check:current,signal:options.signal});if(completed.status==='imported'){context.namespacePrefix=completed.namespacePrefix;return {status:'imported',documents:completed.receipt.documents};}
      const legacy=typeof adapter.legacyMemorySource==='function'?await runStorageOperation(()=>adapter.legacyMemorySource(session),{signal:options.signal,waitMs:10000,storageArtifact:'legacy_memory'}):{store:context.handle.store,scope:session.scope};if(!legacy)return {status:'absent'};
      if(stableStringify(legacy.scope)!==stableStringify(session.scope))throw Object.assign(new Error('旧成果身份与当前聊天不一致'),{code:'SCOPE_CONFLICT'});
      const global=await legacyGlobal(),oldSettings=global?await runStorageOperation(()=>optionalLegacyRead(global,{namespace:'shiyi-product-global',key:'settings-v1'}),{signal:options.signal,waitMs:10000,storageArtifact:'legacy_memory'}):null;
      const result=await prepareMemoLegacyMemory({source:legacy.store,target:context.handle.store,scope:session.scope,identity,check:current,signal:options.signal,sourceSettings:legacy.settings??oldSettings?.value?.settings??{}});await current();context.namespacePrefix=result.namespacePrefix??null;return {status:result.status,documents:result.receipt?.documents??0};
    }],
    ['getStore', async (...args) => { check();const store=await runStorageOperation(()=>adapter.getStore(...args),{waitMs:10000,storageArtifact:'legacy_memory'});if(args[0]?.scope==='extension'){let pending=globalPreparations.get(store);if(!pending){pending=(async()=>{const source=await legacyGlobal();check();if(source)await prepareLegacyGlobal({source,target:store,identity,check});})().catch(error=>{globalPreparations.delete(store);throw error;});globalPreparations.set(store,pending);}await pending;}return wrapStore(store); }],
    ['openHandle', async (...args) => { check(); return wrapHandle(await adapter.openHandle(...args)); }],
    ['currentHandle', async (...args) => { check(); return wrapHandle(await adapter.currentHandle(...args)); }],
    ['setExtensionMetadata', (...args) => { check(); return adapter.setExtensionMetadata(identity.metadataNamespace(args[0]), ...args.slice(1)); }],
    ['setExtensionPrompt', (...args) => {
      check();
      const key = identity.promptKey(args[0]);
      // Defer through a promise to track both sync throws and asynchronous
      // native completion. Unload waits for these writes before clearing ours.
      const pending = Promise.resolve().then(() => { check(); return adapter.setExtensionPrompt(key, ...args.slice(1)); });
      pending.then(() => promptKeys.set(key, args.slice(2)), error => {
        // The native adapter's closed capability refusal happens before a write.
        // Unknown failures may have written and still require owned cleanup.
        if (error?.code !== 'CAPABILITY_UNAVAILABLE') promptKeys.set(key, args.slice(2));
      });
      pendingPrompts.add(pending);
      pending.then(() => pendingPrompts.delete(pending), () => pendingPrompts.delete(pending));
      return pending;
    }],
    ['subscribe', (eventName, listener) => {
      check();
      if (typeof listener !== 'function') throw new TypeError('Memo event listener is required');
      let active = true;
      const ownedListener = function (...args) { if (active && !disposed) return listener.apply(this, args); };
      const subscription = adapter.subscribe(eventName, ownedListener);
      const remove = typeof subscription === 'function' ? subscription
        : typeof subscription?.unsubscribe === 'function' ? subscription.unsubscribe.bind(subscription) : null;
      if (!remove) { active = false; throw new TypeError('Memo host subscription requires exact cancellation'); }
      const unsubscribe = () => {
        if (!active) return;
        active = false; listeners.delete(unsubscribe);
        return remove();
      };
      listeners.add(unsubscribe);
      return unsubscribe;
    }],
    ['dispose', () => {
      if (disposal) return disposal;
      disposed = true; status = 'disposing';
      disposal = (async () => {
        const failures = [];
        for (const unsubscribe of [...listeners]) try { await unsubscribe(); } catch (error) { failures.push(error); }
        await Promise.allSettled([...pendingPrompts]);
        for (const [key, rest] of promptKeys) try { await adapter.setExtensionPrompt(key, '', ...rest); } catch (error) { failures.push(error); }
        if (disposeUnderlying && typeof adapter.dispose === 'function') try { await adapter.dispose(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Memo host cleanup was incomplete');
      })().finally(() => { status = 'disposed'; });
      return disposal;
    }],
  ]);
  // Preserve the host's capability surface; an absent optional operation must
  // not become a callable wrapper around undefined.
  for (const key of [...overrides.keys()]) if (!['memoIdentity', 'dispose','prepareLegacyMemory'].includes(key) && typeof adapter[key] !== 'function') overrides.delete(key);
  const wrapper = facade(adapter, key => overrides.has(key)
    ? { found: true, value: overrides.get(key) } : { found: false });
  if (!independentLifetime) byIdentity.set(identity.id, { wrapper, status: () => status, disposeUnderlying });
  wrapperOwners.set(wrapper, { identity, adapter });
  return wrapper;
}
