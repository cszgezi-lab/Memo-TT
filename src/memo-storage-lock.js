const queues=new Map();
/** Same-origin Web Locks cover separate Memo windows; the local queue covers
 * hosts without Web Locks and in-process adapters sharing a native store. */
export function memoStorageLock(store,key,task){
  if(globalThis.navigator?.locks?.request)return globalThis.navigator.locks.request(key,{mode:'exclusive'},task);
  const work=(queues.get(key)??Promise.resolve()).catch(()=>{}).then(task);queues.set(key,work);return work.finally(()=>{if(queues.get(key)===work)queues.delete(key);});
}
