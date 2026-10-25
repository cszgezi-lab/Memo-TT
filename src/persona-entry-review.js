import {personaRequestBody} from './persona-request-body.js';
// Opt-in comparison metadata only. The original parser/edit guards run first.
// This module performs no I/O and never changes a profile or recovery state.
import {estimateUnits,sha256} from './utils.js';
import {foldName} from './persona-identity.js';
import {hasPersonaSpeechEvidence} from './persona-speech-evidence.js';

const originalContract='只输出合法JSON对象 {"profiles":[人物对象]}。';
const marker='{"entryReview":[对应决定],"profiles":[人物对象]}';
const reviewContract=`只输出一个合法JSON对象 ${marker}，禁止多份JSON。entryReview是顶层字段，不放进人物对象；它是本次对应比较记录，不写入人物档案。
先在完整source中选择影响人物后续演绎的重要依据，再与本人物已有B/N逐项对应。reviewFocus是可不相关的逐字线索索引，不是事实结论或完整材料；每个F编号恰好由一个决定覆盖。可合并同人物、同楼且被同段连续依据覆盖的多个F；不同依据可用多条决定映射同一B，并合并为一次完整段落更新。完整source中索引未列的重要依据也可补入，focusIds:[]。不要按B数量、预设属性或人物模板凑编辑，不要求先编转折。repair.target非空时只回答该目标的F和额外重要依据，其他已通过人物不重答，保留所给F编号。
entryReview每行仅{name:"正式姓名",focusIds:["F1"],decision:"integrate|already_reflected|not_characterization|uncertain",refs:["B1|N1|new"],evidence:{floor:实际楼号,quote:"同楼连续逐字依据，最多600字"},current:"简短当前表述或不改理由"}。name及refs只属于本人物；quote按既有本人归属与来源规则核对，不能改写或补姓名。
integrate表示此重要信息尚须融合进对应当前B/N，refs必须有本次真正应用的updates/noteUpdates落点；首次无底稿人物可用refs:["new"]对应text。多项依据可以落同一段，不要求多次修改。already_reflected必须指向已有具体B/N，说明该信息已经如何体现；原B泛称某类性格或能力，不等于已表达新揭示的具体动机、方法或条件，不能因同属务实、学习或亲近就跳过新增信息。not_characterization用于确非人物演绎信息的线索；uncertain用于归属或意义不明确。后二者允许refs:[]并给短理由，不强制改写。以上决定及理由仍待语义审查，不是正确性证书。
profiles仍仅返回需要建档或更新的人物；即使profiles:[]，顶层entryReview也须逐个处理全部F。仅有清单声明不算修改落地；pending候选不算应用。不相关或不确定线索不要求制造更新，unchanged仍可有据细化，已有转折与精确编辑规则保持。`;
const unsafe=/\[\[(?:SHIYI|MEMO_(?:TT|ST))_PERSONA:|<%|%>|<\/?script\b|\{\{(?!\s*(?:user|char)\s*\}\})|@@/i;
const focusId=value=>typeof value==='string'&&/^F[1-9]\d{0,5}$/.test(value);
const refId=value=>typeof value==='string'&&/^(?:[BN][1-9]\d{0,5}|new)$/.test(value);
const decisions=new Set(['integrate','already_reflected','not_characterization','uncertain']);
const codes=new Set(['REQUEST_SHAPE','REVIEW_MISSING','REVIEW_SHAPE','ROW_SHAPE','UNKNOWN_FOCUS','DUPLICATE_FOCUS','MISSING_FOCUS','NAME_OWNERSHIP','REF_OWNERSHIP','INVALID_EVIDENCE','FOCUS_EVIDENCE','INVALID_CURRENT','INVALID_DECISION','INTEGRATION_NOT_APPLIED','REFLECTED_REF_MISSING']);
const unique=values=>[...new Set(values)];

export function safeIssues(value){
  return (Array.isArray(value)?value:[]).slice(0,64).filter(issue=>issue&&codes.has(issue.code)).map(issue=>({code:issue.code,focusIds:unique((Array.isArray(issue.focusIds)?issue.focusIds:[]).filter(focusId)).slice(0,64),refs:unique((Array.isArray(issue.refs)?issue.refs:[]).filter(refId)).slice(0,48)}));
}
function invalid(){return Object.assign(new Error('人物对应比较请求未通过核对；旧正式档案保留'),{code:'PERSONA_RESPONSE_INVALID',details:{stage:'validate',reason:'persona_fields',personaIssue:'unapplied_revision',personaField:'entryReview',entryReviewIssues:safeIssues([{code:'REQUEST_SHAPE'}])}});}
function bodyOf(req){
  try{
    if(!Array.isArray(req?.messages)||req.messages.length!==2||req.messages[0]?.role!=='system'||req.messages[1]?.role!=='user')throw Error();
    const body=personaRequestBody(req);
    if(!Array.isArray(body.source)||!Array.isArray(body.reviewFocus)||!Array.isArray(body.original)||!Array.isArray(body.previous))throw Error();
    if(body.source.some(m=>!m||!Number.isSafeInteger(m.floor)||m.floor<0||typeof m.text!=='string')||body.reviewFocus.some(h=>!h||!Number.isSafeInteger(h.floor)||h.floor<0||typeof h.name!=='string'||!h.name.trim()||typeof h.excerpt!=='string'))throw Error();
    if([...body.original,...body.previous].some(p=>!p||typeof p.name!=='string'||!p.name.trim()||p.parts!==undefined&&(!Array.isArray(p.parts)||p.parts.some(part=>!part||typeof part.ref!=='string'||typeof part.text!=='string'))||p.noteParts!==undefined&&(!Array.isArray(p.noteParts)||p.noteParts.some(note=>!note||typeof note.ref!=='string'||!Number.isSafeInteger(note.paragraph)||note.paragraph<1))))throw Error();
    return body;
  }catch{throw invalid();}
}
const hintKey=hint=>JSON.stringify([foldName(String(hint?.name??'')),hint?.floor,hint?.excerpt]);

// frozenManifest may be the initial decorated reviewFocus array or {reviewFocus}.
// It supplies stable IDs only; it cannot introduce hints absent from this request.
export function decorate(req,frozenManifest){
  const body=bodyOf(req),system=req.messages[0].content;
  if(typeof system!=='string')throw invalid();
  let nextSystem;
  if(system.split(originalContract).length===2&&!system.includes('entryReview'))nextSystem=system.replace(originalContract,reviewContract);
  else if(!system.includes(originalContract)&&system.split(marker).length===2&&system.split('只输出一个合法JSON对象').length===2)nextSystem=system;
  else throw invalid();
  const frozen=frozenManifest===undefined?null:Array.isArray(frozenManifest)?frozenManifest:frozenManifest?.reviewFocus;
  if(frozen!==null&&!Array.isArray(frozen))throw invalid();
  const byHint=new Map(),frozenIds=new Set();
  for(const hint of frozen??[]){
    const key=hintKey(hint);
    if(!focusId(hint?.id)||byHint.has(key)||frozenIds.has(hint.id))throw invalid();
    byHint.set(key,hint.id);frozenIds.add(hint.id);
  }
  const ids=new Set(),reviewFocus=body.reviewFocus.map((hint,index)=>{
    const saved=byHint.get(hintKey(hint));
    if(frozen&&(!saved||hint.id!==undefined&&hint.id!==saved))throw invalid();
    const id=saved??hint.id??'F'+(index+1);
    if(!focusId(id)||ids.has(id))throw invalid();ids.add(id);
    return {...hint,id};
  });
  const messages=[{...req.messages[0],content:nextSystem},{...req.messages[1],content:JSON.stringify({...body,reviewFocus})}];
  const inputUnits=estimateUnits(JSON.stringify(messages));
  return {...req,messages,inputSize:{...req.inputSize,personaSystemChars:nextSystem.length,personaRequestChars:JSON.stringify(messages).length},entryReview:{version:1,inputUnits,focusCount:reviewFocus.length}};
}

// Returns independent actor results. Native failures are kept by the caller;
// skipActors avoids replacing them, while all other actors still undergo audit.
// Receipts are metadata only: no candidate is created for a legal empty profile.
export function inspect(rows,req,{skipActors=[]}={}){
  const body=bodyOf(req);
  if(!Array.isArray(rows)||!rows.body||!Array.isArray(rows.body.profiles))throw invalid();
  const canon=name=>req.identity?.resolve?.(String(name??''))?.key??foldName(String(name??''));
  const display=name=>req.identity?.resolve?.(String(name??''))?.name??String(name??'').trim();
  const safeName=name=>typeof name==='string'&&name.trim()&&name.length<=64&&!unsafe.test(name)&&!/[<>\n\r]/.test(name);
  const target=typeof body.repair?.target==='string'&&body.repair.target.trim()?canon(body.repair.target):null;
  const focus=target?body.reviewFocus.filter(h=>canon(h.name)===target):body.reviewFocus;
  const known=new Map();
  for(const person of [...body.original,...body.previous,...focus,...rows])if(safeName(person?.name))known.set(canon(person.name),display(person.name));
  const skipped=new Set(Array.from(skipActors??[],canon)),actors=new Map(),globalIssues=[];
  const get=key=>{if(!actors.has(key))actors.set(key,{target:known.get(key),key,issues:[]});return actors.get(key);};
  const add=(key,code,coordinates={})=>{const issue={code,focusIds:coordinates.focusIds,refs:coordinates.refs};if(key&&known.has(key))get(key).issues.push(issue);else globalIssues.push(issue);};
  const byId=new Map(),counts=new Map();
  for(const hint of focus){
    const key=canon(hint?.name);if(known.has(key))get(key);
    if(!focusId(hint?.id)||byId.has(hint.id)){add(key,'REQUEST_SHAPE');continue;}
    byId.set(hint.id,hint);counts.set(hint.id,0);
  }
  for(const profile of [...rows,...rows.body.profiles]){
    const key=canon(profile?.name);if(known.has(key)&&(!target||target===key))get(key);
    else add(null,'NAME_OWNERSHIP');
  }
  const review=rows.body.entryReview;
  if(review===undefined||!Array.isArray(review)){
    const code=review===undefined?'REVIEW_MISSING':'REVIEW_SHAPE';
    if(!actors.size)add(null,code);else for(const key of actors.keys())if(!skipped.has(key))add(key,code);
  }
  for(const item of Array.isArray(review)?review:[]){
    const key=canon(item?.name),coordinates={focusIds:item?.focusIds,refs:item?.refs};
    if(target&&key!==target){add(null,'NAME_OWNERSHIP',coordinates);continue;}
    if(!known.has(key)||!safeName(item?.name)){add(null,'NAME_OWNERSHIP',coordinates);for(const id of Array.isArray(item?.focusIds)?item.focusIds:[]){const hint=byId.get(id);if(hint)add(canon(hint.name),'NAME_OWNERSHIP',coordinates);}continue;}
    get(key);if(skipped.has(key))continue;
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(field=>!['name','focusIds','decision','refs','evidence','current'].includes(field))||!Array.isArray(item.focusIds)||!Array.isArray(item.refs)){add(key,'ROW_SHAPE',coordinates);continue;}
    const ids=item.focusIds,refs=item.refs;
    if(!decisions.has(item.decision))add(key,'INVALID_DECISION',coordinates);
    if(typeof item.current!=='string'||!item.current.trim()||item.current.length>600||unsafe.test(item.current))add(key,'INVALID_CURRENT',coordinates);
    for(const id of ids){
      const hint=byId.get(id);if(!hint){add(key,'UNKNOWN_FOCUS',coordinates);continue;}
      counts.set(id,counts.get(id)+1);
      if(canon(hint.name)!==key){add(key,'NAME_OWNERSHIP',coordinates);add(canon(hint.name),'NAME_OWNERSHIP',coordinates);}
    }
    const original=body.original.filter(p=>canon(p.name)===key),previous=body.previous.filter(p=>canon(p.name)===key);
    const ownParts=original.flatMap(p=>p.parts??[]),ownNotes=previous.flatMap(p=>{
      const paragraphs=String(p.text??'').split(/\n\s*\n/u);
      return (p.noteParts??[]).map(note=>({...note,text:Number.isSafeInteger(note.paragraph)&&note.paragraph>0?paragraphs[note.paragraph-1]:undefined}));
    }),ownRefs=new Set([...ownParts,...ownNotes].map(p=>p.ref));
    if(new Set(refs).size!==refs.length||refs.some(ref=>!refId(ref)||ref!=='new'&&!ownRefs.has(ref)))add(key,'REF_OWNERSHIP',coordinates);
    const evidence=item.evidence,source=body.source.find(m=>m.floor===evidence?.floor),quote=evidence?.quote;
    const literal=source&&typeof quote==='string'&&quote.length>=4&&quote.length<=600&&!unsafe.test(quote)&&typeof source.text==='string'&&source.text.includes(quote);
    const own=literal&&(req.identity?.mentions?.(quote)?.some(person=>person.key===key)||!req.identity?.resolve?.(item.name)&&foldName(quote).includes(key)||req.identity&&hasPersonaSpeechEvidence(source.text,quote,item.name,req.identity,{allowQuotedSpan:true}));
    if(!literal||!own&&!['not_characterization','uncertain'].includes(item.decision))add(key,'INVALID_EVIDENCE',coordinates);
    for(const id of ids){const hint=byId.get(id);if(hint&&(!literal||hint.floor!==evidence.floor||typeof hint.excerpt!=='string'||!quote.includes(hint.excerpt)))add(key,'FOCUS_EVIDENCE',{focusIds:[id],refs});}
    if(item.decision==='already_reflected'&&(!refs.length||refs.includes('new')||refs.some(ref=>!ownRefs.has(ref))))add(key,'REFLECTED_REF_MISSING',coordinates);
    if(item.decision!=='integrate')continue;
    const profile=rows.find(p=>canon(p?.name)===key),composition=profile?.composition,raw=rows.body.profiles.find(p=>canon(p?.name)===key);
    if(!refs.length||!profile||!composition||composition.pendingRevision||composition.pendingOnly||composition.changeCheck?.status==='pending'){add(key,'INTEGRATION_NOT_APPLIED',coordinates);continue;}
    for(const ref of refs){
      let applied=false;
      if(/^B[1-9]\d*$/.test(ref)){
        const before=ownParts.find(p=>p.ref===ref),part=composition.parts?.find(p=>p.ref===ref),edit=raw?.updates?.find(edit=>edit.ref===ref);
        applied=!!before&&!!part&&!!edit&&edit.before===before.text&&typeof edit.text==='string'&&edit.text.trimEnd()===part.text.trimEnd()&&composition.changes?.some(change=>change.key===part.key&&change.after===part.text);
      }else if(/^N[1-9]\d*$/.test(ref)){
        const before=ownNotes.find(p=>p.ref===ref),edit=raw?.noteUpdates?.find(edit=>edit.ref===ref);
        applied=!!before&&typeof before.text==='string'&&!!edit&&edit.before===before.text&&composition.noteChanges?.some(change=>change.ref===ref&&change.before===before.text&&typeof change.after==='string'&&change.after.trim()&&change.after===edit.text?.trim());
      }else if(ref==='new'){
        const note=composition.noteChanges?.some(change=>change.ref==='new'&&change.before===''&&typeof change.after==='string'&&change.after.trim()&&raw?.noteUpdates?.some(edit=>edit.ref==='new'&&edit.before===''&&edit.text?.trim()===change.after));
        const biography=!ownParts.length&&!ownNotes.length&&!previous.length&&typeof raw?.text==='string'&&raw.text.trim()&&composition.sourceBaseline?.length;
        applied=!!note||!!biography;
      }
      if(!applied)add(key,'INTEGRATION_NOT_APPLIED',{focusIds:ids,refs:[ref]});
    }
  }
  for(const [id,count]of counts){const key=canon(byId.get(id).name);if(skipped.has(key))continue;if(!count)add(key,'MISSING_FOCUS',{focusIds:[id]});else if(count>1)add(key,'DUPLICATE_FOCUS',{focusIds:[id]});}
  const results=[];
  if(globalIssues.length)results.push({target:null,issues:safeIssues(globalIssues),receipt:null});
  for(const actor of actors.values()){
    if(skipped.has(actor.key)){results.push({target:actor.target,issues:[],receipt:null,skipped:true});continue;}
    const issues=safeIssues(actor.issues);
    let receipt=null;
    if(!issues.length&&!globalIssues.length){
      const ownFocus=focus.filter(h=>canon(h.name)===actor.key),ownReview=(Array.isArray(review)?review:[]).filter(row=>canon(row?.name)===actor.key),ownRaw=rows.body.profiles.filter(p=>canon(p?.name)===actor.key);
      // A private recovery proof needs only the fields inspected here. Neither
      // receipts nor their digest require copying the unchanged whole dossier.
      const rawProfiles=ownRaw.map(({name,text,updates,noteUpdates})=>({name,text,updates,noteUpdates}));
      const accepted=rows.filter(p=>canon(p?.name)===actor.key).map(p=>{
        const composition=p.composition??{},changed=new Set((composition.changes??[]).map(change=>change.key)),raw=ownRaw.find(row=>canon(row.name)===actor.key);
        return {name:p.name,composition:{parts:(composition.parts??[]).filter(part=>changed.has(part.key)).map(({ref,key,text})=>({ref,key,text})),changes:(composition.changes??[]).map(({key,after})=>({key,after})),noteChanges:(composition.noteChanges??[]).map(({ref,before,after})=>({ref,before,after})),pendingRevision:!!composition.pendingRevision,pendingOnly:!!composition.pendingOnly,changeCheck:{status:composition.changeCheck?.status},...(typeof raw?.text==='string'&&raw.text.trim()&&composition.sourceBaseline?.length?{sourceBaseline:composition.sourceBaseline}:{})}};
      });
      receipt={version:1,target:actor.target,targetKey:actor.key,requestSha256:sha256(req.messages),scopeSha256:sha256({requestViewVersion:req.requestViewVersion??null,targetKey:actor.key,source:body.source,original:body.original.filter(p=>canon(p.name)===actor.key),previous:body.previous.filter(p=>canon(p.name)===actor.key),reviewFocus:ownFocus}),outputSha256:sha256({entryReview:ownReview,profiles:rawProfiles,accepted}),focusIds:ownFocus.map(h=>h.id),decisions:Object.fromEntries([...decisions].map(decision=>[decision,ownReview.filter(row=>row.decision===decision).length])),appliedRefs:unique(ownReview.filter(row=>row.decision==='integrate').flatMap(row=>row.refs)),semanticAccepted:false};
    }
    results.push({target:actor.target,issues,receipt});
  }
  return results;
}
