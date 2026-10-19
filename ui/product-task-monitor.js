import { taskMonitorText } from '../src/product-task-monitor.js';

// These actual automatic states need a visible recovery/pause explanation even
// while the detailed schedule is closed. Unknown provider/source text is never
// used here; taskMonitorText supplies the existing closed, safe wording.
const ATTENTION_REASONS=new Set(['plugin_paused','summary_hold','manual_plan','retry_wait','retry_exhausted','history_unavailable','api_unconfigured','focus_required']);

export function taskMonitorHTML(){
 return `<section class="memo-task-monitor" data-task-monitor aria-label="当前任务"><div class="memo-task-head"><strong data-task-current role="status" aria-live="polite">当前没有运行任务</strong><button type="button" data-task-stop hidden>强制停止</button></div><p class="memo-help memo-task-attention" data-task-attention role="status" hidden></p><details class="memo-task-details" data-task-details><summary>任务详情</summary><p class="memo-help" data-task-automatic></p><div class="memo-task-meta memo-help"><span data-task-next></span><span data-task-manual></span></div><details data-task-queue hidden><summary data-task-queue-title>等待接口的请求</summary><ul data-task-requests></ul></details></details></section>`;
}

export function mountTaskMonitor({panel,app,run}){
 const root=panel.querySelector('[data-task-monitor]');if(!root)return {paint(){}};
 const $=selector=>root.querySelector(selector),stop=$('[data-task-stop]');let stopping=false,lastMonitor={};
 function paint(monitor={}){
  lastMonitor=monitor;const text=taskMonitorText(monitor);
  const current=!monitor.current&&text.requests.length?text.queueTitle:text.current;
  const attention=ATTENTION_REASONS.has(monitor.automatic?.reason)?text.automatic:'';
  for(const [selector,value]of [['[data-task-current]',current],['[data-task-attention]',attention],['[data-task-automatic]',text.automatic],['[data-task-next]',text.next],['[data-task-manual]',text.manualPending],['[data-task-queue-title]',text.queueTitle]]){
   const node=$(selector);if(node.textContent!==value)node.textContent=value;node.hidden=!value;
  }
  stop.hidden=!text.canStop&&!stopping;stop.disabled=stopping;stop.textContent=stopping?'正在停止…':'强制停止';stop.setAttribute('aria-busy',String(stopping));
  $('[data-task-queue]').hidden=!text.requests.length;
  const list=$('[data-task-requests]');
  if(list.dataset.content!==JSON.stringify(text.requests)){
   list.replaceChildren(...text.requests.map(value=>{const row=root.ownerDocument.createElement('li');row.textContent=value;return row;}));list.dataset.content=JSON.stringify(text.requests);
  }
 }
 stop.addEventListener('click',async()=>{
  if(stopping||!taskMonitorText(lastMonitor).canStop)return;
  stopping=true;paint(lastMonitor);
  try{await run(()=>app.stop(),{name:'stop',button:stop});}finally{stopping=false;paint(app.readViewState?.().taskMonitor??app.state?.taskMonitor??{});}
 });
 return {paint};
}
