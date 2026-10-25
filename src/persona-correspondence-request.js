import {personaWireMessages} from './persona-request-body.js';
// Pure request preparation for the explicitly selected production contract.
// Complete source/baseline/current notes remain unchanged; focus indices are not fact judgments.
import {estimateUnits,sha256} from './utils.js';
import {foldName} from './persona-identity.js';
import {hasPersonaSpeechEvidence,personaSpeechPairs,personaSpeechSpanEnd} from './persona-speech-evidence.js';
import {decorate} from './persona-entry-review.js';

export const PERSONA_FRESH_REQUEST_VIEW=17;
export const PERSONA_NEUTRAL_SYSTEM='你是文本助手。';
export const PERSONA_COMPACT_TASK=`你只生成JSON文本，宿主负责读取、保存和替换人物档案；不需要操作外部软件、文件或世界书。根据用户JSON中的完整source，对照original.parts的B段和previous的N段，写出人物当前有效的完整局部修改，不写事件总结或只加态度、台词。
保留未被正文改变的身份、职业、爱好、安全或保密习惯；不补未知身份、知情或原因。计划不当完成，一次行为不扩大成永久规则。已有B有对应属性时局改B，旧N有相反当前表述时同步局改N，不能让旧反向指令继续有效。保留具体方法、理由、对象、条件、限度和优先级；未修改部分由宿主保留。
只返回一份JSON对象，不要解释、围栏、裸数组或items。顶层仅contractVersion、profiles、entryReview，contractVersion必须为2。下面仅是字段骨架，不是当前人物答案；填入真实修改和对应决定，不能用空壳声称已完成：
{"contractVersion":2,"profiles":[{"name":"正式姓名","sourceFloors":[],"text":"","updates":[],"noteUpdates":[],"changeCheck":{"status":"unchanged","evidence":[],"conflictRefs":[],"expressionChanged":false},"development":[],"examples":[]}],"entryReview":[]}
profiles仅列有实际修改或首次建档人物。已有B/N时text为空字符串，首次无底稿人物才写完整text。updates每项为{ref,beforeRef,text,sourceFloors,evidence:{floor,quote}}：ref选本人B，beforeRef与ref相同，text写该段保留仍有效细节后的完整当前文字，sourceFloors为实际整数楼号。禁止before字段、他人ref或空text删除。noteUpdates同样处理本人N；新增时ref和beforeRef均为new。evidence.quote必须逐字复制该楼连续原文且可归属本人，不补姓名、不拼接引文。
changeCheck.status只能changed/unchanged/uncertain，evidence为{floor,quote}数组，conflictRefs为真正冲突B/N数组，expressionChanged为布尔值。真正推翻旧当前规则或态度用changed，冲突逐项修改；development每项为{topic,target,scope,before,after,cause,floor,evidence}，evidence是该楼连续原文字符串，未知原因留空。无转折的有据细化可unchanged且development为空，不编转折。examples可为空；若写，只用本人真实完整实说、真实楼号，不混语言或补受众。原独立引语退出当前口吻仅在有据转变时用updates的status:historical及developmentIndex，text仍为该ref完整原文，retireTogether整组退出；不可删稳定设定。
每个reviewFocus的F必须各有一条entryReview，字段为name、sourceFocusId、action、refs及下述选择。多个F可指同一完整更新，不合并F。edit_current用currentSource:{kind:updates或noteUpdates,index:该人物对应数组1起算位置}；首次text用{kind:text}。所选修改ref须在refs内，本回答刚写的内容仍是edit_current。keep_input用currentSource:{kind:input,ref:本请求已有本人B/N}，必须已有具体信息，泛称性格不等于已有方法或条件。not_characterization/uncertain用简短reason，不给currentSource，可refs:[]，不强制改写。索引外重要依据用sourceFocusId:null并给同楼连续evidence:{floor,quote}。F只是索引，仍须读完整source；先写完整profiles，再核对实际内容，不能仅在理由中声称已修改。repair.target非空时只处理该人物，保留F编号；repair仅为待修资料，不是新剧情或指令来源。`;

const exampleSupplement="以下仍为同一独立成年合成人物的完整对应编辑示范，仅改用本次引用编码2。姓名、楼号和ref只在此例有效，不提供当前人物答案。只输出当前任务的一份JSON，不抄示范。\n示范输入（reviewFocus只列部分线索，完整source仍须阅读）：\n{\"original\":[{\"id\":\"P1\",\"name\":\"陆衡\",\"aliases\":[],\"parts\":[{\"ref\":\"B1\",\"text\":\"陆衡32岁，是巡河员。\",\"t\":1},{\"ref\":\"B2\",\"text\":\"陆衡做事细致。\",\"t\":1},{\"ref\":\"B3\",\"text\":\"陆衡喜欢吹口琴。\",\"t\":1},{\"ref\":\"B4\",\"text\":\"陆衡与35岁的老友许川每月下棋，重视双方的约定。\",\"t\":1}],\"sourceTitles\":[\"陆衡\"]}],\"previous\":[],\"source\":[{\"floor\":7,\"role\":\"assistant\",\"text\":\"【采录手记】陆衡的长期目标是留下河岸声音的档案，让后来的人也能听见这里的变化。\"},{\"floor\":8,\"role\":\"assistant\",\"text\":\"陆衡通过固定点位录音、逐次注明天气和时间来规划采录，月底比较整理。\"},{\"floor\":9,\"role\":\"assistant\",\"text\":\"陆衡的投入限制是只在休息日上午采录，不接受占用值班时间，也不取消既有棋约。\"}],\"reviewFocus\":[{\"floor\":7,\"name\":\"陆衡\",\"excerpt\":\"【采录手记】陆衡的长期目标是留下河岸声音的档案，让后来的人也能听见这里的变化。\",\"id\":\"F1\"},{\"floor\":9,\"name\":\"陆衡\",\"excerpt\":\"陆衡的投入限制是只在休息日上午采录，不接受占用值班时间，也不取消既有棋约。\",\"id\":\"F2\"}]}\n示范的唯一输出JSON（先profiles，后entryReview）：\n{\"contractVersion\":2,\"profiles\":[{\"name\":\"陆衡\",\"sourceFloors\":[7,8,9],\"text\":\"\",\"updates\":[{\"ref\":\"B2\",\"text\":\"陆衡做事细致。他想长期留下河岸声音档案，让后来的人了解这里的变化；为此固定点位录音，每次注明天气和时间，月底比较整理。采录只放在休息日上午，不占值班时间，也不取消与许川的既有棋约。\",\"sourceFloors\":[7,8,9],\"evidence\":{\"floor\":7,\"quote\":\"【采录手记】陆衡的长期目标是留下河岸声音的档案，让后来的人也能听见这里的变化。\"},\"beforeRef\":\"B2\"}],\"noteUpdates\":[],\"development\":[],\"examples\":[],\"changeCheck\":{\"status\":\"unchanged\",\"evidence\":[{\"floor\":7,\"quote\":\"【采录手记】陆衡的长期目标是留下河岸声音的档案，让后来的人也能听见这里的变化。\"},{\"floor\":8,\"quote\":\"陆衡通过固定点位录音、逐次注明天气和时间来规划采录，月底比较整理。\"},{\"floor\":9,\"quote\":\"陆衡的投入限制是只在休息日上午采录，不接受占用值班时间，也不取消既有棋约。\"}],\"conflictRefs\":[],\"expressionChanged\":false}}],\"entryReview\":[{\"name\":\"陆衡\",\"refs\":[\"B2\"],\"sourceFocusId\":\"F1\",\"action\":\"edit_current\",\"currentSource\":{\"kind\":\"updates\",\"index\":1}},{\"name\":\"陆衡\",\"refs\":[\"B2\"],\"sourceFocusId\":null,\"evidence\":{\"floor\":8,\"quote\":\"陆衡通过固定点位录音、逐次注明天气和时间来规划采录，月底比较整理。\"},\"action\":\"edit_current\",\"currentSource\":{\"kind\":\"updates\",\"index\":1}},{\"name\":\"陆衡\",\"refs\":[\"B2\"],\"sourceFocusId\":\"F2\",\"action\":\"edit_current\",\"currentSource\":{\"kind\":\"updates\",\"index\":1}}]}\n目标、方法、投入条件已先融入同一完整B段，身份、爱好和仍有效约定保留。F1、索引外第8楼、F2分别核对这一实际更新，所以均为edit_current，currentSource均指updates第1项；同一回答里前面已写过，不叫keep_input。程序从该项实际完整text取连续摘录作可追溯记录，不让模型重复改写核对文字。keep_input仅指这次请求已经提供的原B/N，不指本回答刚生成的文字。索引外仍需同楼连续逐字evidence。本例兼容信息揭示，无新弧光或新N；无新重要信息可以不改，真实反向变化仍须处理实际冲突和转折，不照抄unchanged。";
const decisionPreservationRule="写当前表述时保留依据中的决策内容：人物选择了什么可行路径、为何采用，以及使接受/拒绝或计划成立的对象、条件、限度和优先级。不能把具体方法压成“会分析/很务实”，也不能仅留同一来源的第一项条件。对本批决定采用的信息，把仍有效的限制一起融合进对应B或该项目N；无依据的维度不补，临时细节仍可不入档。不把多个来源的片段拼成虚构实说，不把一次项目限制推广为普遍禁令。";

const finalReviewRule="先完成profiles中的当前完整文字，再对照完整source和各线索核对实际成品。重要的方法或成立限制必须写进实际当前档案，不能只在核对理由中声称已经包含；若核对发现遗漏，先补正当前文字再输出。无据内容不补，引用索引和宿主生成的摘录不代替语义判断。";

const encodedContracts=[
  ['只输出一个合法JSON对象 {"entryReview"','只输出一个合法JSON对象 {"contractVersion":2,"profiles":[人物对象],"entryReview":[对应决定]}，禁止多份JSON或旧编码。先写完整当前人物修改profiles，再核对其实际内容写entryReview；清单是核对记录，不写入人物档案。'],
  ['先在完整source中选择影响人物后续演绎的重要依据，再与本人物已有B/N逐项对应。reviewFocus','先在完整source中选择影响人物后续演绎的重要依据，再与本人物已有B/N逐项对应。reviewFocus只是可能相关的逐字线索索引，不是事实结论或完整材料。每个F编号必须恰好由一条独立决定处理，sourceFocusId只填一个现有F，禁止合并多个F；不同决定可映射同一B，并合并成一次完整段落更新。索引外的重要依据也须处理，sourceFocusId:null并给同楼连续逐字evidence。不要按B数量或属性模板凑编辑，不要求编转折。repair.target非空时只回答该目标的F及额外重要依据，保留现有F编号。'],
  ['entryReview每行仅','entryReview索引行仅{name:"正式姓名",sourceFocusId:"F1",action:"edit_current|keep_input|not_characterization|uncertain",refs:["B1|N1|new"],currentSource:{kind:"updates|noteUpdates",index:该人物本回答对应数组中1起算位置}}。edit_current也可在首次无底稿人物用currentSource:{kind:"text"}指本回答text；keep_input用currentSource:{kind:"input",ref:"请求中该人物已有B/N"}。禁止decision/current字段，禁止再给focusIds/evidence。程序恢复该F原floor/完整excerpt及所选当前文字的连续摘录，依旧逐字/归属/实际落点核验，不把引用当事实。索引外sourceFocusId:null且必须有evidence:{floor:实际楼号,quote:"同楼连续逐字依据，最多600字"}。not_characterization/uncertain仅给reason简短理由，不给currentSource；所有name/refs及选择的当前文字只属于本人物。'],
  ['integrate表示此重要信息尚须融合进对应当前B/N','edit_current表示信息需在本回答当前档案落地，refs包含实际已应用更新，currentSource指本人物实际updates/noteUpdates中对应项，其ref必须在refs内；多条F可指同一项完整更新。keep_input严格只表示信息在本次请求已有B/N中已经具体体现，refs及currentSource.ref必须指该输入，不允许new，也不允许本回答刚产生的条目；原B泛称性格或能力不等于已有具体动机、方法或条件。本回答中已写过的新增信息仍用edit_current共享实际更新，不能因先写过就改成keep_input。not_characterization/uncertain可refs:[]，不强制改写。宿主恢复摘录只证明可追溯性，不证明语义；原来源、归属、实际应用与整篇语义核验继续。'],
  ['updates:[{ref:"本人物B编号",before:','updates:[{ref:"本人物B编号",beforeRef:"与ref相同的本人物B编号",text:"融合后的完整当前段落",sourceFloors:[实际楼号],evidence:{floor:实际楼号,quote:"同楼连续且可归属本人原文"}}]。beforeRef只指向本次请求original.parts中该人物该ref的完整原片段，程序按实际已发请求快照恢复其原字节，再执行既有精确修改校验。禁止输出before字段，禁止换ref、合并相邻片段或引用其它请求/人物。未列B自动保留，不能空text删除或抄整卡；未被推翻的否定、对象、条件、细节继续保留，不用一句概括替掉整段。'],
  ['noteUpdates同样含ref/before/text/evidence','noteUpdates含ref/beforeRef/text/evidence；已有N用beforeRef与ref相同，按本请求previous.noteParts所指previous.text完整空行段恢复原字节；新增ref:"new",beforeRef:"new"，程序恢复before为空。禁止before字段，B与N不可混用。有原书/聊天B时text:""，新补充用noteUpdates；首次无底稿人物才用text。未知身份信息不补全，不套scene地点或别人属性；某次穿着不当常穿，单次行为不升级为总是、极度、毫不犹豫。'],
  ['输出前逐个核对原书retirable:true口吻引语','输出前逐个核对原书retirable:true口吻引语是否仍适用于当前对象。冲突时updates用{ref,beforeRef:与ref相同,text:该ref原文逐字全文,status:"historical",developmentIndex:本次development数组中对应项的1起算位置,evidence:{floor,quote}}退出当前口吻，不改写原引语；禁止before字段。retireTogether须整组逐项给同一转变位置与依据，各自text保留原字。必须关联本批有据的对象/情境转变及changed核对，相关refs列入conflictRefs；原因和本人原话可在不同楼，不伪造同楼引文。稳定资料、非独立引语、无冲突范例不可退出。程序保留历史，仅退出当前模仿；亲近不授权撤掉自主、工作或其它对象边界。']
];

function invalid(){return Object.assign(new Error('人物对应比较请求未通过核对；旧正式档案保留'),{code:'PERSONA_RESPONSE_INVALID',details:{stage:'validate',reason:'persona_fields',personaIssue:'unapplied_revision',personaField:'entryReview',entryReviewIssues:[{code:'REQUEST_SHAPE',focusIds:[],refs:[]}]}});}
function bodyOf(req){
  try{
    if(!Array.isArray(req?.messages)||req.messages.length!==2||req.messages[0]?.role!=='system'||req.messages[1]?.role!=='user')throw invalid();
    const body=JSON.parse(req.messages[1].content);
    if(!Array.isArray(body.source)||!Array.isArray(body.reviewFocus)||body.source.some(row=>!row||typeof row.text!=='string'))throw invalid();
    return body;
  }catch{throw invalid();}
}
function checkBudget(req,inputLimit){
  const inputUnits=estimateUnits(JSON.stringify(personaWireMessages(req)));
  if(inputLimit!==undefined&&(!Number.isFinite(inputLimit)||inputLimit<0||inputUnits>inputLimit))throw Object.assign(new Error('人物对应比较输入超过原预算，尚未发送'),{code:'INPUT_BUDGET_EXCEEDED'});
}
function checkEncodedRequest(req,frozenManifest){
  const system=req.messages[0].content,lines=system.split('\n');
  for(const[prefix,expected]of encodedContracts){
    if(lines.filter(line=>line===expected).length!==1)throw invalid();
    const old=lines.filter(line=>line.startsWith(prefix));
    if(expected.startsWith(prefix)?old.length!==1:old.length!==0)throw invalid();
  }
  if(lines.filter(line=>line.startsWith('只输出一个合法JSON对象')).length!==1)throw invalid();
  if(system.split(exampleSupplement).length!==2||!system.endsWith(exampleSupplement+'\n\n'+decisionPreservationRule+'\n'+finalReviewRule))throw invalid();
  // Reuse the production decorator's input/frozen-manifest validation without
  // asking it to recognize the already encoded response contract.
  const checked=decorate({...req,messages:[{...req.messages[0],content:'只输出合法JSON对象 {"profiles":[人物对象]}。'},req.messages[1]]},frozenManifest);
  if(checked.messages[1].content!==req.messages[1].content||req.referenceEncoding.preparedMessagesSha256!==sha256(JSON.stringify(req.messages))||req.referenceEncoding.inputUnits!==estimateUnits(JSON.stringify(req.messages)))throw invalid();
}
function replaceLine(system,prefix,replacement){
  const lines=system.split('\n'),matches=lines.map((line,i)=>line.startsWith(prefix)?i:-1).filter(i=>i>=0);
  if(matches.length!==1)throw invalid();
  lines[matches[0]]=replacement;return lines.join('\n');
}

function augmentPublicDialogueFocus(req){
 const body=bodyOf(req),identity=req.identity,maxPerActor=24;
 if(!identity||!Array.isArray(body.source)||!Array.isArray(body.reviewFocus)||!Number.isSafeInteger(maxPerActor)||maxPerActor<8||maxPerActor>24)throw invalid();
 const canonical=name=>identity.resolve(name)?.key??foldName(name);
 const hints=body.reviewFocus.map(hint=>({...hint})),counts=new Map();
 for(const hint of hints){const key=canonical(hint.name);counts.set(key,(counts.get(key)??0)+1);}
 const people=identity.people;
 for(const source of body.source)for(const line of source.text.match(/[^\r\n]+/gu)??[]){
  if(line.length>600||/^\s*(?:time|scene)\s*[:：]/iu.test(line))continue;
  // Use one complete language utterance with its unchanged explicit lead.
  // Attribution MUST be checked in the full source: an isolated line can
  // conceal an enclosing private-thought/narrator bracket from the scanner.
  let excerpt;
  for(let i=0;i<line.length;i++)if(personaSpeechPairs.has(line[i])){
   const end=personaSpeechSpanEnd(line,i);if(end<0)break;
   if(/[“「『"]/u.test(line[i])){excerpt=line.slice(0,end+1).trim();break;}i=end;
  }
  if(!excerpt)continue;
  const named=identity.mentions(excerpt);
  for(const person of people){
   if(!named.some(p=>p.key===person.key)||(counts.get(person.key)??0)>=maxPerActor||hints.some(h=>canonical(h.name)===person.key&&h.floor===source.floor&&h.excerpt.includes(excerpt)))continue;
   if(!hasPersonaSpeechEvidence(source.text,excerpt,person.name,identity,{includeLead:true,allowQuotedSpan:true}))continue;
   hints.push({floor:source.floor,name:person.name,excerpt});counts.set(person.key,(counts.get(person.key)??0)+1);
  }
 }
 const messages=[req.messages[0],{...req.messages[1],content:JSON.stringify({...body,reviewFocus:hints})}];
 return {...req,messages,inputSize:{...req.inputSize,personaRequestChars:JSON.stringify(messages).length}};
}

function encodeReferenceRequest(req,{inputLimit}={}){
  if(!req?.entryReview||req.messages?.length!==2||req.referenceEncoding)throw invalid();
  let system=req.messages[0].content;
  for(const[prefix,replacement]of encodedContracts)system=replaceLine(system,prefix,replacement);
  const supplement=exampleSupplement;
  system+='\n\n'+supplement+'\n\n'+decisionPreservationRule+'\n'+finalReviewRule;
  const next={...req,messages:[{...req.messages[0],content:system},req.messages[1]]};
  const inputUnits=estimateUnits(JSON.stringify(next.messages));
  if(inputLimit!==undefined&&(!Number.isFinite(inputLimit)||inputLimit<0||inputUnits>inputLimit))throw Object.assign(new Error('引用编码输入超过原预算，尚未发送'),{code:'INPUT_BUDGET_EXCEEDED'});
  return {...next,inputSize:{...req.inputSize,personaSystemChars:system.length,personaRequestChars:JSON.stringify(next.messages).length},entryReview:{...req.entryReview,inputUnits},referenceEncoding:{version:2,inputUnits,preparedMessagesSha256:sha256(JSON.stringify(next.messages))}};
}

const taskFor=taskPrompt=>taskPrompt===undefined?PERSONA_COMPACT_TASK:typeof taskPrompt==='string'?taskPrompt+'\n\n'+PERSONA_COMPACT_TASK:(()=>{throw invalid();})();
function checkTaskLastRequest(req,body,{frozenManifest,taskPrompt,inputLimit}){
  if(req.messages[0].content!==PERSONA_NEUTRAL_SYSTEM||body.task!==taskFor(taskPrompt)||req.referenceEncoding?.version!==2||!req.entryReview)throw invalid();
  const {task,...data}=body,wire=JSON.stringify(req.messages),inputUnits=estimateUnits(wire);
  // Validate the same body and frozen IDs through the existing decorator;
  // an encoded marker alone never grants idempotency or new hint ownership.
  const checked=decorate({...req,messages:[{role:'system',content:'只输出合法JSON对象 {"profiles":[人物对象]}。'},{...req.messages[1],content:JSON.stringify(data)}]},frozenManifest);
  if(checked.messages[1].content!==JSON.stringify(data)||req.referenceEncoding.preparedMessagesSha256!==sha256(wire)||req.referenceEncoding.inputUnits!==inputUnits||req.entryReview.inputUnits!==inputUnits)throw invalid();
  checkBudget(req,inputLimit);return req;
}
function prepareTaskLastRequest(req,body,{inputLimit,frozenManifest,taskPrompt}){
  if(req.referenceEncoding)return checkTaskLastRequest(req,body,{inputLimit,frozenManifest,taskPrompt});
  if(Object.hasOwn(body,'task'))throw invalid();
  const base=frozenManifest!==undefined||body.repair?req:augmentPublicDialogueFocus(req),decorated=decorate(base,frozenManifest);
  const messages=[{...decorated.messages[0],content:PERSONA_NEUTRAL_SYSTEM},{...decorated.messages[1],content:JSON.stringify({...JSON.parse(decorated.messages[1].content),task:taskFor(taskPrompt)})}],wire=JSON.stringify(messages),inputUnits=estimateUnits(wire);
  const prepared={...decorated,messages,inputSize:{...decorated.inputSize,personaSystemChars:PERSONA_NEUTRAL_SYSTEM.length,personaRequestChars:wire.length},entryReview:{...decorated.entryReview,inputUnits},referenceEncoding:{version:2,inputUnits,preparedMessagesSha256:sha256(wire)}};
  checkBudget(prepared,inputLimit);return prepared;
}

/** Fresh opt-in only. Older request objects and bytes are returned untouched.
 * A frozen or repair request uses only its existing hints and retains sparse IDs. */
export function prepareCorrespondingRequest(req,{inputLimit,frozenManifest,taskPrompt}={}){
  const view=req?.requestViewVersion??req?.inputSize?.personaRequestView;
  if(!Number.isSafeInteger(view)||view<12)return req;
  const body=bodyOf(req);
  if(view>=16&&view<=PERSONA_FRESH_REQUEST_VIEW)return prepareTaskLastRequest(req,body,{inputLimit,frozenManifest,taskPrompt});
  if(view>PERSONA_FRESH_REQUEST_VIEW)throw invalid();
  if(req.referenceEncoding){
    if(req.referenceEncoding.version!==2||!req.entryReview||typeof req.messages[0].content!=='string'||!req.messages[0].content.endsWith(exampleSupplement+'\n\n'+decisionPreservationRule+'\n'+finalReviewRule))throw invalid();
    checkEncodedRequest(req,frozenManifest);checkBudget(req,inputLimit);return req;
  }
  const base=frozenManifest!==undefined||body.repair?req:augmentPublicDialogueFocus(req);
  const decorated=decorate(base,frozenManifest),prepared=encodeReferenceRequest(decorated,{inputLimit});
  checkBudget(prepared,inputLimit);return prepared;
}
