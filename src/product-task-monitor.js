const TASKS={summary:'聊天总结',chat:'读取聊天',operation:'处理当前操作',vectors:'建立向量索引',persona:'更新动态人设',api:'模型请求',quality:'检查记忆'};
const ROLES={summary:'主总结',assistant:'配置助手',dynamicPersona:'动态人设',personaReview:'人设核查',persona:'动态人设',embedding:'向量',rerank:'重排',knowledge:'知识导入',supplement:'补充总结',quality:'记忆检查'};
const WAIT={queue_foreground:'等待当前对话完成',queue_busy:'等待前一个请求结束',queue_cooldown:'等待接口恢复',queue_rpm:'等待接口频率限制解除'};
const AUTOMATIC={
 progress_unknown:'尚未读取聊天楼数，可到总结页检查进度。',history_unavailable:'聊天原文仍不可读，已停止本轮重读；等待下一次回复完成或回到前台后再检查。',
 disabled:'自动总结未开启。',plugin_paused:'拾忆已暂停，开启记忆功能后继续。',no_chat:'打开聊天后检查自动总结。',chat_loading:'正在读取当前聊天。',task_busy:'等待当前任务结束。',manual_plan:'有未完成的手动总结，请到总结页继续、删除或放弃对应批次。',summary_hold:'自动接续已暂停；需要时在总结页明确开启自动总结。',foreground:'等待当前对话完成。',hidden:'页面隐藏时暂停自动总结。',api_unconfigured:'请先保存主总结模型连接。',retry_wait:'上次未完成，正在等待再次尝试。',retry_exhausted:'自动重试已暂停，请到总结页查看失败批次并重试。',focus_required:'当前设置要求每批填写侧重点，请到手动总结处理下一批。',not_enough_floors:'等待聊天楼数达到下一批要求。',pending:'等待下一次聊天更新时检查。',ready:'已满足下一批总结条件。',running:'正在自动总结。'
};
const number=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const range=(start,end)=>number(start)!==null&&number(end)!==null&&end>=start?`${start}–${end} 楼`:'';
const PHASES={preparing:'正在准备',queued:'正在等待接口',waiting:'等待模型答复',composing:'正在生成总结',validating:'正在检查与整理',saving:'正在保存',running:'正在进行'};

// A closed projection keeps raw provider details and source text out of the UI.
export function taskMonitorText(monitor={}){
 const current=monitor.current,requests=Array.isArray(monitor.providerRequests)?monitor.providerRequests:[],automatic=monitor.automatic??{};
 const task=current?`${current.trigger==='auto'?'自动':current.trigger==='manual'?'手动':''}${TASKS[current.kind]??'当前任务'}`:'当前没有运行任务';
 const phase=PHASES[current?.phase]??'正在进行';
 const total=number(current?.totalBatches),done=number(current?.completedBatches);
 const progress=total>0&&done!==null&&done<=total?{value:done,max:total}:null;
 const currentText=current?[task,range(current.startIndex,current.endIndex),progress?`已保存 ${done}/${total} 批`:'',phase].filter(Boolean).join(' · '):task;
 const requestRows=requests.map(request=>{
  const label=ROLES[request.modelRole]??'模型请求',reason=WAIT[request.reason]??'等待接口可用',position=number(request.queuePosition);
  return `${label} · ${reason}${position!==null&&position>0?` · 排队位置 ${position}`:''}`;
 });
 const next=range(automatic.nextStart,automatic.nextEnd),pending=number(automatic.manualPending)??0;
 return {current:currentText,automatic:`自动总结：${AUTOMATIC[automatic.reason]??'正在检查状态。'}`,next:next?`下一批：${next}`:'',manualPending:pending?`未完成的手动批次：${pending}`:'',requests:requestRows,queueTitle:requestRows.length?`等待接口的请求（${requestRows.length}）`:'等待接口的请求',canStop:Boolean(current)||requestRows.length>0,progress};
}

// Closed, small projection for the host chat surface, independent of panel visibility.
export function hostTaskStatus(monitor={}){
 const text=taskMonitorText(monitor),blocked=['history_unavailable','retry_exhausted'].includes(monitor.automatic?.reason),busy=text.canStop;
 return {visible:busy||blocked,title:busy?(monitor.current?text.current:'任务正在等待接口'):'自动总结已暂停',detail:text.requests[0]??(blocked?text.automatic:''),
  hint:monitor.current?.kind==='summary'?'聊天与召回可继续；切换聊天或删改本批原文前，请先停止或等保存完成。':busy?'后台任务进行中；需要切换或删改相关内容时，可先停止任务。':blocked?'打开拾忆查看未完成批次，再重试或继续。':'',
  canStop:busy,progress:text.progress};
}
