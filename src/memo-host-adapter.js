import { createMemoIdentity } from './memo-identity.js';

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
 * No construction read, source rewrite, automatic import or fallback to the old
 * owner's namespace occurs. The original adapter remains the authority for chat
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

  const stores = new WeakMap(), handles = new WeakMap(), metadata = new WeakMap();
  const listeners = new Set(), promptKeys = new Map(), pendingPrompts = new Set();
  let disposed = false, disposal, status = 'active';
  const check = () => { if (disposed) throw closed(); };
  const address = args => {
    if (!object(args) || Array.isArray(args)) throw new TypeError('Memo store address is required');
    return { ...args, namespace: identity.namespace(args.namespace) };
  };

  function wrapStore(store) {
    if (!object(store)) return store;
    if (stores.has(store)) return stores.get(store);
    const wrapped = {};
    // Optional host methods remain optional; do not invent a successful read
    // path or silently turn host errors into an empty/new workspace.
    for (const method of STORE_METHODS) if (typeof store[method] === 'function') {
      wrapped[method] = (...args) => store[method].call(store, address(args[0]), ...args.slice(1));
    }
    Object.freeze(wrapped); stores.set(store, wrapped);
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
    const wrapped = facade(handle, key => key === 'store'
      ? { found: true, value: wrapStore(handle.store) }
      : key === 'metadata' ? { found: true, value: wrapMetadata(handle.metadata) } : { found: false });
    handles.set(handle, wrapped);
    return wrapped;
  }

  const overrides = new Map([
    ['memoIdentity', identity],
    ['getStore', async (...args) => { check(); return wrapStore(await adapter.getStore(...args)); }],
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
  for (const key of [...overrides.keys()]) if (!['memoIdentity', 'dispose'].includes(key) && typeof adapter[key] !== 'function') overrides.delete(key);
  const wrapper = facade(adapter, key => overrides.has(key)
    ? { found: true, value: overrides.get(key) } : { found: false });
  if (!independentLifetime) byIdentity.set(identity.id, { wrapper, status: () => status, disposeUnderlying });
  wrapperOwners.set(wrapper, { identity, adapter });
  return wrapper;
}
