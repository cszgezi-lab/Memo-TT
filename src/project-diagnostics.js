import {captureProductHostSession,normalizeHostMessage} from './product-host-adapters.js';
import {stableStringify} from './utils.js';

/** Local explicit export, with no credential-store or model port. */
export async function createProjectDiagnostics({version,check,readBackup,readWorkspace,readChat,readRuntimeLog,readInjections}) {
 const startedAt=new Date().toISOString();check();
 const backup=await readBackup();check();
 // Connection URLs can contain credentials even though settings exclude Keys.
 backup.settings={...backup.settings};
 for(const [key,value]of Object.entries(backup.settings))if(key.endsWith('Endpoint')&&typeof value==='string'&&value){
  try{const url=new URL(value);url.username='';url.password='';url.search='';url.hash='';backup.settings[key]=url.href;}catch{backup.settings[key]='[invalid endpoint]';}
 }
 const workspace=await readWorkspace();check();
 const chat=await readChat();check();
 const runtimeLog=await readRuntimeLog();check();
 const recentInjections=await readInjections();check();
 return {kind:'memo-project-diagnostics',schemaVersion:1,version,startedAt,exportedAt:new Date().toISOString(),atomicSnapshot:false,
  contents:'当前聊天正文、记忆与人物档案、批次与进度、设置与规则、运行日志、最近20次注入；不读取API凭据。',backup,workspace,chat,runtimeLog,recentInjections};
}

/** One backwards traversal: do not reread the entire prefix for every page. */
export async function readDiagnosticChat(adapter,scope,check){
 const session=await captureProductHostSession(adapter);check();
 if(session.scope.chatId!==scope.chatId)throw Object.assign(new Error('聊天已变化'),{code:'CHAT_CHANGED'});
 const history=session.handle.history;
 if(typeof history?.tail!=='function')throw Object.assign(new Error('聊天历史不可读'),{code:'HISTORY_UNAVAILABLE'});
 const checkBound=async()=>{check();if(stableStringify(await adapter.currentRef())!==session.refKey)throw Object.assign(new Error('聊天已变化'),{code:'CHAT_CHANGED'});};
 await checkBound();let page=await history.tail({limit:100});await checkBound();
 const pages=[];let totalCount=null,expectedEnd=null,complete=true;
 while(page){
  if(!Array.isArray(page.messages)||!Number.isSafeInteger(page.startIndex)||page.startIndex<0||page.messages.length===0){complete=false;break;}
  const end=page.startIndex+page.messages.length;
  if(expectedEnd!==null&&end!==expectedEnd){complete=false;break;}
  if(totalCount===null){totalCount=page.totalCount??end;if(totalCount!==end)complete=false;}
  pages.push(page.messages.map((m,i)=>{const index=page.startIndex+i;
    if(m.complete===false||m.streaming||m.isStreaming)return {index,role:m.role??(m.is_user?'user':'assistant'),text:String(m.text??m.mes??m.content??''),complete:false};
    return normalizeHostMessage(m,index);
  }));
  expectedEnd=page.startIndex;if(expectedEnd===0)break;
  if(typeof history.before!=='function'){complete=false;break;}
  await new Promise(resolve=>setTimeout(resolve,0));await checkBound();page=await history.before(page,{limit:100});await checkBound();
 }
 const messages=pages.reverse().flat();
 return {complete:complete&&expectedEnd===0&&messages.length===totalCount,totalCount,pages:pages.length,messages};
}
