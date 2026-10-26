import { safeLogDetails } from '../product-runtime-log.js';
import { errorDiagnostics } from '../diagnostics.js';

/** diagnostics orchestration. Dependencies are limited by service-contracts.js. */
export function createDiagnosticsService(appScope) {
function trackDiagnostic(work){const job=Promise.resolve(work).catch(()=>{});appScope.diagnosticJobs.add(job);void job.finally(()=>appScope.diagnosticJobs.delete(job));return job;}

function reportError(error,{task='operation',stage='ui',modelRole,action,level='error'}={}){
    if(error&&typeof error==='object'){if(appScope.recordedErrors.has(error))return Promise.resolve();appScope.recordedErrors.add(error);}
    const details=safeLogDetails({stage,modelRole,action,...errorDiagnostics(error)});
    const startDetails=Object.fromEntries(['action','stage','code','reason','field','ruleIndex','kind','modelRequested'].filter(key=>Object.hasOwn(details,key)).map(key=>[key,details[key]]));
    return trackDiagnostic((async()=>{const run=await appScope.runtimeLog.start(task,startDetails);appScope.runtimeLog.record({run,task,phase:details.code==='CANCELED'?'canceled':'failed',level,details});await appScope.runtimeLog.flush();})());
  }

async function flushDiagnostics(){await Promise.all([...appScope.diagnosticJobs]);await appScope.runtimeLog.flush();}

async function logged(task,fn,details={}){
    const version=appScope.cancelVersion,run=await appScope.runtimeLog.start(task,details),started=Date.now();
    try{
      if(version!==appScope.cancelVersion)throw Object.assign(new Error('任务已停止'),{code:'CANCELED'});
      const result=await fn(run);
      appScope.runtimeLog.record({run,task,phase:['waiting','skipped'].includes(result?.phase)?result.phase:'complete',level:result?.level==='warning'||result?.degraded?'warning':result?.level==='info'?'info':'success',details:{...details,...result?.diagnostics,...(task==='summary'?result?.timings:{}),...(task==='recall'?{degraded:result?.degraded,vectorStatus:result?.trace?.vector?.status,rerankStatus:result?.trace?.rerank?.status}:{}),...(task==='vectors'?{indexedItems:result?.indexed,pendingItems:result?.pending,failedItems:result?.failed,requestNumber:result?.requests}:{}),elapsedMs:Date.now()-started,savedBatches:result?.batches}});
      return result;
    }catch(error){
      const canceled=['CANCELED','CHAT_CHANGED','SOURCE_INVALIDATED'].includes(error?.code)||error?.name==='AbortError';
      if(error&&typeof error==='object')appScope.recordedErrors.add(error);
      const autoRetry=task==='vectors'&&!canceled&&appScope.state.vectorIndex?.automatic;
      appScope.runtimeLog.record({run,task,phase:canceled?'canceled':autoRetry?'retry_wait':'failed',level:canceled||autoRetry?'warning':'error',details:{...details,...errorDiagnostics(error),...(autoRetry?{retryDelayMs:Math.max(0,appScope.state.vectorIndex.retryAt-Date.now())}:{}),elapsedMs:Date.now()-started}});
      throw error;
    }finally{await flushDiagnostics();}
  }
  return Object.freeze({ trackDiagnostic, reportError, flushDiagnostics, logged });
}
