import {personaCompositionText,compactPersonaParts} from './persona-composition.js';
import {qualitySourceSegments,safeSourceRanges} from './source-evidence.js';
import {withoutPrivateSpeech} from './memory-evidence.js';

// Derived views only. The saved source, DIY prose and immutable checkpoints
// remain recoverable. Do not guess semantic equivalence between different facts.
const cache=new WeakMap(),frameCache=new WeakMap();
const stagePattern=/(?:国中|初中|高中|大学)[一二三四1-4]年级/g;
const sameStage=s=>s.replace('国中','初中').replace(/[1234]/g,c=>'一二三四'[Number(c)-1]);
const sourceStage='(?:(?:国中|初中|高中|大学)[一二三四1-4](?:年级|年)?|[国初高大][一二三四1-4])';
const globalScope='((?:所有|全部)(?:主线)?(?:角色|人物))';
const currentTime='(?:现在|当前|目前)(?:的)?(?:叙事时点|时间线|剧情时点)?';
const joins='\\s*(?:[:：，,]\\s*)?(?:(?:是|为|都|均|正|在|处于|回到|进入|切换到|转到|的)\\s*)*';
const sourceFramePatterns=[
 new RegExp(`^(?:请注意|注意|提醒)?\\s*[:：]?\\s*${currentTime}${joins}${globalScope}${joins}(${sourceStage})(?:的)?(?:时期|时点|阶段|时候|时)?\\s*$`,'u'),
 new RegExp(`^(?:请注意|注意|提醒)?\\s*[:：]?\\s*${globalScope}${joins}${currentTime}${joins}(${sourceStage})(?:的)?(?:时期|时点|阶段|时候|时)?\\s*$`,'u'),
];
const narrativeFramePattern=new RegExp(`^(当前叙事时点|当前时间线)${joins}(${sourceStage})(?:的)?(?:时期|时点|阶段|时候|时)?\\s*$`,'u');
function normalizedStage(value){
 if(typeof value!=='string')return null;
 const match=/^(国中|初中|高中|大学|国|初|高|大)([一二三四1-4])(?:年级|年)?$/u.exec(value);
 if(!match)return null;
 const school=({国中:'初中',国:'初中',初:'初中',高:'高中',大:'大学'})[match[1]]??match[1];
 const year=/[1-4]/u.test(match[2])?'一二三四'[Number(match[2])-1]:match[2];
 return school!=='大学'&&year==='四'?null:`${school}${year}年级`;
}
function validFrame(frame,endFloor,{sourceOnly=false}={}){
 if(!frame||!Number.isSafeInteger(frame.floor)||frame.floor<0||frame.floor>endFloor)return null;
 const source=sourceOnly||frame.provenance?.kind==='source-message';
 if(source?!normalizedStage(frame.stage):!/^(?:国中|初中|高中|大学)[一二三四1-4]年级$/u.test(frame.stage))return null;
 if(frame.scope!==undefined&&!['main','all'].includes(frame.scope))return null;
 if(source&&(frame.provenance?.kind!=='source-message'||frame.provenance?.role!=='user'||!['main','all'].includes(frame.scope)))return null;
 if(frame.provenance?.floor!==undefined&&frame.provenance.floor!==frame.floor)return null;
 return frame;
}
function latestFrame(frames){
 if(!frames.length)return null;
 const floor=Math.max(...frames.map(f=>f.floor)),latest=frames.filter(f=>f.floor===floor);
 // Contradictory declarations at the same source position need review. Do
 // not turn array order into a silent current-state decision.
 if(new Set(latest.map(f=>f.stage===null?null:normalizedStage(f.stage)??f.stage)).size!==1)return null;
 return latest.find(f=>f.provenance?.kind==='source-message')??latest[0];
}
function sourceTimelineFrames(messages,endFloor){
 const frames=[],blank=s=>s.replace(/[^\r\n]/g,' ');
 for(const message of messages){
  if(message?.role!=='user'||!Number.isSafeInteger(message.index)||message.index<0||message.index>endFloor)continue;
  // Reuse the existing nested/orphan private-boundary scanner. Quote/private
  // wrappers share the same exclusion semantics here, not global truth.
  const original=withoutPrivateSpeech(String(message.text??'').replace(/(<\s*\/?\s*)(?:private|blockquote|q)(?=[\s/>])/giu,'$1sy_private'));let text='',cursor=0;
  for(const [start,end]of safeSourceRanges({text:original})){text+=blank(original.slice(cursor,start))+original.slice(start,end);cursor=end;}
  text+=blank(original.slice(cursor));
  // A user can quote a character or include private/reasoning material. Only
  // the user's visible, unquoted declaration is a global frame.
  text=text.replace(/^[ \t]*>[^\r\n]*/gmu,blank)
   .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\r\n]*(?:`|$)/gu,blank)
   .replace(/“[^”]*(?:”|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)/gu,blank)
   .replace(/<[^>]*>/gu,blank);
  for(const piece of text.matchAll(/[^()（）\n。！？!?;；]+/gu)){
   const declaration=piece[0].trim();
   if(!declaration||/[？?]/u.test(text[piece.index+piece[0].length]??''))continue;
   const prefixStart=Math.max(text.lastIndexOf('\n',piece.index-1),text.lastIndexOf('。',piece.index-1),text.lastIndexOf('；',piece.index-1))+1;
   const prefix=text.slice(prefixStart,piece.index);
   if(/如果|假如|假设|要是|是否|可能|也许|并非|不是|不在|尚未|未来|以后|曾经|当年|回忆|想起|记得/u.test(prefix+declaration))continue;
   // A separate OOC parenthesis after a closed spoken quote is outside that
   // speech. A prior "他说" must not swallow the user's following declaration.
   const afterSpeech=/[”」』"']\s*[(（]\s*$/u.test(original.slice(prefixStart,piece.index));
   const reported=/转述|复述|举例|示例|例如|引用|说|表示|写道|心想/u;
   if(reported.test(declaration)||reported.test(prefix)&&!afterSpeech)continue;
   let match=sourceFramePatterns.map(pattern=>pattern.exec(declaration)).find(Boolean),scope;
   if(match)scope=match[1].includes('主线')?'main':'all';
   else {match=narrativeFramePattern.exec(declaration);scope='all';}
   const stage=normalizedStage(match?.[2]);if(!stage)continue;
   frames.push({stage,floor:message.index,scope,provenance:{kind:'source-message',role:'user',floor:message.index}});
  }
 }
 return frames;
}
function recordsTimelineFrame(records,endFloor){
 const cached=frameCache.get(records);if(cached?.endFloor===endFloor)return cached.frame;
 let frame=null;
 for(const row of records.summaryView??[]){
  if(!Number.isSafeInteger(row.floorIndex)||row.floorIndex>endFloor)continue;
  const text=row.originalSource?.text??'';
  // Only an explicit global narrative frame, never a guessed age, isolated
  // school mention, a date calculation, or a character remembering school.
  const pattern=/(?:所有角色|所有人物|当前叙事时点|当前时间线)[^\n。]{0,50}?((?:国中|初中|高中|大学)[一二三四1-4]年级)/u;
  if(!/所有角色|所有人物|当前叙事时点|当前时间线/.test(text))continue;
  for(const line of qualitySourceSegments({text}).flatMap(s=>s.text.split(/[。！？\n]/u))){
    if(/如果|假如|假设|要是|是否|并非|不是|不在|[“”「」『』]/u.test(line))continue;
    const match=pattern.exec(line);
    if(!match&&!/(?:当前叙事时点|当前时间线)\s*(?:[:：]|切换|转到|回到|进入)/u.test(line))continue;
    if(!frame||row.floorIndex>=frame.floor)frame={stage:match?.[1]??null,floor:row.floorIndex};
  }
 }
 frameCache.set(records,{endFloor,frame});return frame;
}
// Source parsing and persisted source frames are explicit opt-ins. The old
// two-argument summary-view contract keeps its exact result shape and text.
export function personaTimelineFrame(records={},endFloor=Infinity,options){
 const recorded=recordsTimelineFrame(records,endFloor);
 if(options?.sourceMessages===undefined&&options?.previousFrames===undefined)return recorded?.stage?recorded:null;
 const previous=(Array.isArray(options.previousFrames)?options.previousFrames:[]).map(f=>validFrame(f,endFloor,{sourceOnly:true})).filter(Boolean);
 const source=sourceTimelineFrames(Array.isArray(options.sourceMessages)?options.sourceMessages:[],endFloor);
 const latest=latestFrame([...(recorded?[recorded]:[]),...previous,...source]);
 return latest?.stage?latest:null;
}
function sourceStageProjection(text,frame,name){
 let ownStage=false;
 const projected=text.replace(/[^\n。；;，,]+/gu,clause=>{
  const stages=clause.match(stagePattern);if(!stages)return clause;
  // These grades refer to teaching, relatives, or another explicitly named
  // person. Ambiguous mixed clauses stay verbatim rather than rewriting an
  // unrelated identity or marking every fact on a compound line historical.
  if(/原卡默认|原设定时点|并非当前|不是当前|历史|倒叙|此前|当时|曾经|回忆|任教|授课|执教|任课|教导|教师|老师|教授|讲师|班主任|负责|管理|担任|母亲|父亲|妹妹|姐姐|弟弟|哥哥|儿子|女儿|同伴|朋友|旁人|他人|别人|对方/u.test(clause))return clause;
  const start=clause.search(stagePattern),before=clause.slice(0,start);
  if(/(?:与|和|向|给|关于|提到|提及|说起).{0,24}$/u.test(before))return clause;
  const subject=/^\s*(?:【[^】]*】\s*)?(?:(?:核心身份|当前身份|身份|当前学段|学段|年级)\s*[:：]\s*)?([\p{L}·・]{1,40}?)\s*(?:现为|目前(?:是|在)?|现在(?:是|在)?|就读于?|在|是)/u.exec(clause)?.[1];
  if(subject&&![name,'她','他','本人','自己','当前','目前','现在'].includes(subject))return clause;
  ownStage=true;
  return clause.replace(stagePattern,stage=>sameStage(stage)===sameStage(frame.stage)?stage:`${stage}〔非当前时点的学段参考〕`);
 });
 return {text:projected,ownStage};
}
export function applyUserDirectives(profile){
  const lines=Array.isArray(profile?.userDirectives)?profile.userDirectives.map(item=>String(item??'').trim()).filter(Boolean):[];
  if(!lines.length)return profile;
  const head=`【强调】\n这里的句子优先于原书、语料和后文概括。冲突时只照这里做。\n${lines.join('\n')}`;
  const tail=`【强调 · 收束】\n和上面的档案冲突时，仍以这几句为准：\n${lines.join('\n')}`;
  let text=String(profile.text??'');
  if(text.startsWith(head))text=text.slice(head.length).replace(/^\n+/u,'');
  if(text.endsWith(tail))text=text.slice(0,-tail.length).replace(/\n+$/u,'');
  return {...profile,text:[head,text,tail].filter(Boolean).join('\n\n')};
}
export function projectCurrentPersona(profile,frame=null){
 if(!profile?.composition||profile.manual||profile.locked)return applyUserDirectives(profile);
 const endFloor=Number.isSafeInteger(profile.through)?profile.through:Infinity;
 const applicable=f=>f&&(f.scope!=='main'||profile.bindings?.length||profile.casting?.role==='lead');
 frame=latestFrame([validFrame(frame,endFloor),validFrame(profile.composition.narrativeFrame,endFloor,{sourceOnly:true})].filter(applicable));
 const cached=cache.get(profile),frameKey=frame?`${frame.floor}:${frame.stage}:${frame.scope??''}:${frame.provenance?.kind??''}`:'';
 if(cached?.frameKey===frameKey)return cached.profile;
 const c=profile.composition,parts=compactPersonaParts(c.parts??[]),duplicates=(c.parts??[]).length-parts.length;
 const seen=new Set(parts.filter(p=>p.source==='chat'&&p.text.trim().length>=8).map(p=>p.text.trim()));
 // Notes must remain a CURRENT snapshot. Remove only literal repeats, never
 // similarity-based omissions of new conditions, names, dates or negation.
 const notes=String(c.notes??'').split(/(?<=[。！？])|\n/u).filter(t=>!seen.has(t.trim())).join('\n');
 const composition={...c,parts,notes};
 let text=personaCompositionText(composition,{hasSources:Boolean(profile.bindings?.length)});
 if(frame?.provenance?.kind==='source-message'){
  const projected=sourceStageProjection(text,frame,profile.name);
  if(!projected.ownStage)frame=null;
  else text=`【当前叙事时点：${frame.stage}；第${frame.floor}楼明确指定。标注的不同学段仅作原设定参考；不据此推算年龄、改写学校或其他身份。】\n${projected.text}`;
 }else if(frame){
  text=text.split('\n').map(line=>{
   const stages=line.match(stagePattern)??[];
   if(!stages.some(s=>sameStage(s)!==sameStage(frame.stage)))return line;
   if(/原卡默认|原设定时点|并非当前|不是当前|历史|倒叙|此前|当时/.test(line))return line;
   // Qualify a conflicting snapshot, without silently inventing replacement
   // ages/schools or editing the underlying original-book/DIY value.
   return `〔非当前时点的设定参考〕${line.replace(/当前/g,'原设定')}`;
  }).join('\n');
  text=`【当前叙事时点：${frame.stage}；第${frame.floor}楼明确指定。以下不同学段/年龄属于原设定参考，不据此改变当前场景；不推算未说明的年龄。】\n${text}`;
 }
 const projected=applyUserDirectives({...profile,composition,text,projection:{version:1,duplicateParts:duplicates,timeline:frame}});
 cache.set(profile,{frameKey,profile:projected});return projected;
}
