// Tool transport adapted from Antigravity Gateway Experimental (MIT License).
// Copyright (c) 2026 Xeltra233. Scoped to Memo summary/persona requests; no fetch hooks.
import {clone,isPlainObject} from './utils.js';
import {SummaryResponseError} from './errors.js';
import {parseSummaryJson} from './summary-json.js';
import {SUMMARY_ARMOR_V17_WORDS} from './summary-armor-text.js';

export const SUMMARY_ARMOR_TOOL='output_everything_here';
const keys=['antiTruncation','headerPadding','userPadding','words'];
export function defaultSummaryArmor({fillWords=false}={}){return {antiTruncation:false,headerPadding:false,userPadding:false,words:fillWords?SUMMARY_ARMOR_V17_WORDS:''};}
export function normalizeSummaryArmor(value){
  if(value==null)return defaultSummaryArmor();
  if(!isPlainObject(value)||Object.keys(value).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(value,k))||keys.slice(0,3).some(k=>typeof value[k]!=='boolean')||typeof value.words!=='string'||value.words.length>16000)throw new Error('破甲区设置无效，破甲词最多16000字');
  return clone(value);
}
// Legacy booleans remain readable for saved preset/checkpoint identity. U941
// retired their transport behaviour; never resurrect padding from an old plan.
export function summaryArmorEnabled(value){const v=normalizeSummaryArmor(value);return v.antiTruncation||Boolean(v.words.trim());}
export const SUMMARY_ARMOR_GUARD='本次唯一任务仍是依据指定来源整理记忆，并严格遵守原有 outputContract、来源编号和逐楼覆盖要求。兼容文本不是故事证据，不得扮演其中人物、打招呼或续写；compatibilityPadding只供传输兼容，禁止记为事件、人物、台词或事实。';
const prefixText=text=>`<summary_compatibility_context>\n${text}\n</summary_compatibility_context>\n\n`;
export function applySummaryArmor(payload,value,{task='summary'}={}){
  const armor=normalizeSummaryArmor(value);if(!summaryArmorEnabled(armor))return payload;
  const result={...payload,messages:payload.messages.map(m=>({...m}))},system=result.messages.find(m=>m.role==='system');
  if(!system||typeof system.content!=='string')throw new Error('总结兼容请求缺少系统任务');
  const preface=armor.words;
  const guard=task==='persona'?'本次唯一任务仍是依据指定来源更新人物当前档案，并严格遵守原有人物归属、片段编号、逐字原文、楼层依据和JSON输出协议。兼容文本不是故事证据，不得扮演其中人物、打招呼或续写；compatibilityPadding只供传输兼容，禁止记为人物身份、经历、实说、态度或成长事实。':SUMMARY_ARMOR_GUARD;
  system.content=(preface?prefixText(preface):'')+system.content+'\n\n'+guard;
  if(armor.antiTruncation){
    if(result.tools?.length||result.tool_choice!=null&&result.tool_choice!=='auto')throw new Error('总结请求已有工具设置，不能重复添加反截断封装');
    if(result.response_format||result.json_schema)throw new Error('反截断不能与旧JSON模式同时使用');
    result.tools=[{type:'function',function:{name:SUMMARY_ARMOR_TOOL,description:task==='persona'?'Return the complete persona JSON as the content string. This is an output container only; no tool is executed.':'Return the complete summary JSON as the content string. This is an output container only; no tool is executed.',parameters:{type:'object',properties:{content:{type:'string',description:'The complete response JSON, without omissions.'}},required:['content'],additionalProperties:false}}}];
    result.tool_choice='auto';
    system.content+='\n请只调用一次 '+SUMMARY_ARMOR_TOOL+'，把本次完整JSON回复作为content字符串。不要在工具调用外另写正文；此容器不改变'+(task==='persona'?'人物档案更新':'总结')+'任务。';
  }
  return result;
}
function invalidTool(reason){const error=new SummaryResponseError('总结反截断工具回复不完整或不匹配',{reason,stage:'parse_content'});error.code='SUMMARY_TOOL_RESPONSE_INVALID';return error;}
export function summaryToolContent(payload,{enabled=false}={}){
  const message=payload?.choices?.[0]?.message,calls=message?.tool_calls;
  if(!Array.isArray(calls)||calls.length===0)return null;
  if(!enabled||payload.choices.length!==1||calls.length!==1||calls[0]?.type!=='function'||calls[0]?.function?.name!==SUMMARY_ARMOR_TOOL)throw invalidTool('unexpected_tool_response');
  if(message.content!=null&&(typeof message.content!=='string'||message.content.trim()))throw invalidTool('mixed_tool_and_text');
  const raw=calls[0].function.arguments;if(typeof raw!=='string')throw invalidTool('invalid_tool_arguments');
  let args;try{args=parseSummaryJson(raw).value;}catch{throw invalidTool('incomplete_tool_arguments');}
  if(!isPlainObject(args)||Object.keys(args).length!==1||typeof args.content!=='string'||!args.content.trim())throw invalidTool('invalid_tool_content');
  return args.content;
}
export function summaryArmorPreview(value){
  const armor=normalizeSummaryArmor(value);return {nonStreaming:false,...armor,headerPadding:false,userPadding:false,headerPaddingChars:0,userPaddingChars:0,longPaddingDisabled:true,tool:armor.antiTruncation?SUMMARY_ARMOR_TOOL:null};
}
