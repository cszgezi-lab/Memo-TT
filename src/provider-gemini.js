import {ShiyiError,SummaryResponseError} from './errors.js';
import {createChatEventStreamParser,createEventStreamFraming} from './provider-stream.js';

const invalidProfile=message=>new ShiyiError(message,'PROVIDER_PROFILE_INVALID');
const invalidStream=()=>new SummaryResponseError('Gemini 流式回复格式不完整或无效',{reason:'stream_invalid',stage:'read_body'});
const blocked=new Set(['SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT','SPII','IMAGE_SAFETY','MODEL_ARMOR']);

export function geminiBase(input){
  const url=new URL(input);
  const path=url.pathname.replace(/\/+$/,'');
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||/(?:\/models(?:\/|$)|\/openai(?:\/|$)|:)/i.test(path)){
    throw invalidProfile('Gemini 原生请填写服务的基础地址，可带 /v1beta，Key 请填入专用输入框');
  }
  url.pathname=/\/v1(?:beta)?$/.test(path)?path:path+'/v1beta';
  return url.href;
}

export function geminiModel(value){
  const model=String(value??'').trim().replace(/^models\//,'');
  if(!/^[\w.-]+$/.test(model)||model==='.'||model==='..')throw invalidProfile('请填写有效的 Gemini 模型名称');
  return model;
}

export function geminiEndpoint(base,resource,{model,stream}={}){
  const url=geminiBase(base);
  if(resource==='models')return url+'/models';
  if(resource!=='chat'&&resource!=='chatCompletions')throw invalidProfile('Gemini 原生连接用于聊天模型，请单独配置向量和重排');
  return url+'/models/'+geminiModel(model)+(stream===true?':streamGenerateContent?alt=sse':':generateContent');
}

function mappedFinish(reason,hasTool){
  if(reason==='STOP')return hasTool?'tool_calls':'stop';
  if(reason==='MAX_TOKENS')return 'length';
  if(blocked.has(reason))return 'content_filter';
  return null;
}

/** TT may forward Gemini frames or emit its own OpenAI error frame. Convert
 * each Gemini data event and keep the existing stream completion checks. */
export function createGeminiEventStreamParser(){
  const parser=createChatEventStreamParser();
  let protocol=null,hasTool=false;
  const send=value=>parser.push('data: '+JSON.stringify(value)+'\n\n');
  const framing=createEventStreamFraming(data=>{
    if(data.trim()==='[DONE]'){parser.push('data: [DONE]\n\n');return;}
    let value;
    try{value=JSON.parse(data);}catch{throw invalidStream();}
    if(value?.error||Array.isArray(value?.choices)){
      if(!value.error&&protocol==='native'&&!/^tauritavern-error-chunk-\d+$/.test(value.id??''))throw invalidStream();
      if(!value.error&&!protocol)protocol='normalized';
      send(value);
      return;
    }
    if(protocol==='normalized'||!value||!['candidates','usageMetadata','promptFeedback'].some(key=>Object.hasOwn(value,key)))throw invalidStream();
    protocol='native';
    if(value.candidates!==undefined&&(!Array.isArray(value.candidates)||value.candidates.length>1))throw invalidStream();
    const candidate=value.candidates?.[0];
    if(candidate?.index!==undefined&&candidate.index!==0)throw invalidStream();
    const parts=candidate?.content?.parts??[];
    if(!Array.isArray(parts))throw invalidStream();
    const visible=parts.filter(part=>part?.thought!==true);
    const text=visible.map(part=>typeof part?.text==='string'?part.text:'').join('');
    const calls=visible.filter(part=>Object.hasOwn(part??{},'functionCall')).map(part=>part.functionCall);
    if(calls.length){
      const call=calls[0];
      if(hasTool||calls.length!==1||typeof call?.name!=='string'||!call.name||!call.args||typeof call.args!=='object'||Array.isArray(call.args))throw invalidStream();
      hasTool=true;
      send({choices:[{index:0,delta:{...(text?{content:text}:{}),tool_calls:[{index:0,id:call.id??'gemini-call-0',type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]}}]});
    }else if(text)send({choices:[{index:0,delta:{content:text}}]});
    const reason=candidate?.finishReason;
    const blockReason=value.promptFeedback?.blockReason;
    const finish=blockReason&&blockReason!=='BLOCK_REASON_UNSPECIFIED'?'content_filter':mappedFinish(reason,hasTool);
    if(reason&&reason!=='FINISH_REASON_UNSPECIFIED'&&!finish)throw invalidStream();
    const usage=value.usageMetadata;
    const counts=usage&&Object.fromEntries([
      ['prompt_tokens',usage.promptTokenCount],['completion_tokens',usage.candidatesTokenCount],['total_tokens',usage.totalTokenCount],
    ].filter(([,count])=>Number.isSafeInteger(count)&&count>=0));
    if(finish||counts)send({choices:finish?[{index:0,delta:{},finish_reason:finish}]:[],...(counts?{usage:counts}:{})});
  });
  return {push:framing.push,finish(){framing.end();return parser.finish();}};
}
