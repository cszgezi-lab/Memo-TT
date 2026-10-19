// Explicit reference decoding only. No I/O, provider calls or profile mutation.
// The caller supplies a binding from its final send or verified exact cache.
import {sha256} from './utils.js';
import {safeIssues} from './persona-entry-review.js';
import {foldName} from './name-fold.js';

// Wire hashes preserve JSON key order; sha256(object) uses stable key order.
const exactSha=value=>sha256(JSON.stringify(value));
const copy=value=>JSON.parse(JSON.stringify(value));
const plain=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const validRef=value=>typeof value==='string'&&/^[BN][1-9]\d{0,5}$/.test(value);
const validFocus=value=>typeof value==='string'&&/^F[1-9]\d{0,5}$/.test(value);
const decisions=new Set(['integrate','already_reflected','not_characterization','uncertain']);
const reviewFields=new Set(['name','focusIds','decision','refs','evidence','current']);
const safeName=value=>typeof value==='string'&&value.trim()&&value.length<=64&&!/[<>\n\r]|\[\[(?:SHIYI|MEMO_(?:TT|ST))_PERSONA:|<%|%>|@@|\{\{(?!\s*(?:user|char)\s*\}\})/i.test(value);
function refuse(code,{focusIds=[],refs=[]}={}){
  return Object.assign(new Error('引用协议未通过请求与归属核对；原正式结果保留'),{code:'PERSONA_RESPONSE_INVALID',details:{stage:'validate',reason:'persona_fields',personaIssue:'unapplied_revision',personaField:'entryReview',entryReviewIssues:safeIssues([{code,focusIds,refs}])}});
}
function requestBody(req){
  try{
    if(!Array.isArray(req?.messages)||req.messages.length!==2||req.messages[0]?.role!=='system'||req.messages[1]?.role!=='user'||typeof req.messages[0].content!=='string'||typeof req.messages[1].content!=='string'||typeof req.identity?.resolve!=='function')throw Error();
    const body=JSON.parse(req.messages[1].content);
    if(!plain(body)||!Array.isArray(body.original)||!Array.isArray(body.previous)||!Array.isArray(body.reviewFocus)||!Array.isArray(body.source))throw Error();
    if(body.source.some(s=>!plain(s)||!Number.isSafeInteger(s.floor)||s.floor<0||typeof s.text!=='string'))throw Error();
    if([...body.original,...body.previous].some(p=>!plain(p)||!safeName(p.name)||p.parts!==undefined&&(!Array.isArray(p.parts)||p.parts.some(part=>!plain(part)||!validRef(part.ref)||typeof part.text!=='string'))||p.noteParts!==undefined&&(!Array.isArray(p.noteParts)||p.noteParts.some(note=>!plain(note)||!validRef(note.ref)||!Number.isSafeInteger(note.paragraph)||note.paragraph<1))))throw Error();
    return body;
  }catch{throw refuse('REQUEST_SHAPE');}
}
function canonical(req,name){
  if(!safeName(name))return null;
  try{const person=req.identity.resolve(name);return person&&typeof person.key==='string'&&person.key&&safeName(person.name)?person:null;}catch{return null;}
}

// The native parser can create a biography from a named source without a
// worldbook/dictionary identity. This grants only that new text, never B/N or
// note-edit ownership; native source/floor/content validation still follows.
function sourceOnlyPeople(req,body,profiles){
  const people=new Map(),source=foldName(body.source.map(row=>row.text).join('\n'));
  for(const profile of Array.isArray(profiles)?profiles:[]){
    const name=profile?.name;
    if(canonical(req,name)||!safeName(name)||typeof profile.text!=='string'||!profile.text.trim())continue;
    if(['updates','noteUpdates'].some(field=>profile[field]!==undefined&&(!Array.isArray(profile[field])||profile[field].length)))continue;
    const key=foldName(name.trim());
    if(!key||!source.includes(key)||[...body.original,...body.previous].some(person=>foldName(person.name)===key))continue;
    if((req.identity.people??[]).some(person=>[person.name,...(person.aliases??[])].some(alias=>foldName(alias)===key)))continue;
    people.set(key,{key,name:name.trim()});
  }
  return people;
}

function sealLegacyReferenceBytes(req,{enabled=false}={}){
  if(enabled!==true)throw refuse('REQUEST_SHAPE');
  const body=requestBody(req),messages=copy(req.messages),messageSha256=exactSha(messages),owned=new Map(),focus=new Map();
  const personFor=name=>{const person=canonical(req,name);if(!person)throw refuse('NAME_OWNERSHIP');return person;};
  const put=(name,ref,text)=>{
    const key=personFor(name).key;
    if(!validRef(ref)||typeof text!=='string')throw refuse('REQUEST_SHAPE');
    if(!owned.has(key))owned.set(key,new Map());
    if(owned.get(key).has(ref))throw refuse('REQUEST_SHAPE');
    owned.get(key).set(ref,text);
  };
  for(const person of body.original){
    personFor(person.name);
    for(const part of person.parts??[]){if(!plain(part))throw refuse('REQUEST_SHAPE');put(person.name,part.ref,part.text);}
  }
  for(const person of body.previous){
    personFor(person.name);const paragraphs=String(person.text??'').split(/\n\s*\n/u);
    for(const note of person.noteParts??[]){if(!plain(note)||!Number.isSafeInteger(note.paragraph)||note.paragraph<1)throw refuse('REQUEST_SHAPE');put(person.name,note.ref,paragraphs[note.paragraph-1]);}
  }
  for(const hint of body.reviewFocus){
    if(!plain(hint)||!validFocus(hint.id)||focus.has(hint.id)||!Number.isSafeInteger(hint.floor)||hint.floor<0||typeof hint.excerpt!=='string'||!body.source.some(s=>s.floor===hint.floor&&s.text.includes(hint.excerpt)))throw refuse('REQUEST_SHAPE');
    personFor(hint.name);focus.set(hint.id,copy(hint));
  }
  const expand=(raw,{request,responseMessagesSha256}={})=>{
    // A model-provided digest cannot establish actual send/cache provenance.
    if(responseMessagesSha256!==messageSha256||!Array.isArray(request?.messages)||exactSha(request.messages)!==messageSha256)throw refuse('REQUEST_SHAPE');
    if(!plain(raw)||raw.contractVersion!==1||Object.keys(raw).some(k=>!['contractVersion','entryReview','profiles'].includes(k))||!Array.isArray(raw.profiles)||!Array.isArray(raw.entryReview))throw refuse('REVIEW_SHAPE');
    const sourceActors=sourceOnlyPeople(req,body,raw.profiles);
    const responsePersonFor=name=>{const person=canonical(req,name)??sourceActors.get(foldName(String(name??'').trim()));if(!person)throw refuse('NAME_OWNERSHIP');return person;};
    const expanded=copy(raw);delete expanded.contractVersion;
    for(const profile of expanded.profiles){
      if(!plain(profile))throw refuse('REVIEW_SHAPE');
      const own=owned.get(responsePersonFor(profile.name).key);
      for(const [field,prefix] of [['updates','B'],['noteUpdates','N']]){
        if(!Array.isArray(profile[field]))continue; // Original native parser owns field-shape validation.
        for(const edit of profile[field]){
          if(field==='noteUpdates'&&edit?.ref==='new'){
            if(Object.hasOwn(edit,'before')||edit.beforeRef!=='new')throw refuse('REF_OWNERSHIP');
            edit.before='';delete edit.beforeRef;continue;
          }
          if(!plain(edit)||Object.hasOwn(edit,'before')||typeof edit.beforeRef!=='string'||edit.beforeRef!==edit.ref||!validRef(edit.ref)||!edit.ref.startsWith(prefix)||!own?.has(edit.ref))throw refuse('REF_OWNERSHIP',{refs:[edit?.ref]});
          edit.before=own.get(edit.ref);delete edit.beforeRef;
        }
      }
    }
    expanded.entryReview=expanded.entryReview.map(row=>{
      if(!plain(row))throw refuse('ROW_SHAPE');
      const actor=responsePersonFor(row.name);
      if(Object.hasOwn(row,'sourceFocusId')&&row.sourceFocusId!==null){
        if(Object.hasOwn(row,'focusIds')||Object.hasOwn(row,'evidence')||!validFocus(row.sourceFocusId))throw refuse('ROW_SHAPE',{focusIds:[row.sourceFocusId]});
        const hint=focus.get(row.sourceFocusId);
        if(!hint||personFor(hint.name).key!==actor.key)throw refuse('NAME_OWNERSHIP',{focusIds:[row.sourceFocusId]});
        const {sourceFocusId,...rest}=row;return {...rest,focusIds:[sourceFocusId],evidence:{floor:hint.floor,quote:hint.excerpt}};
      }
      // Unindexed source keeps literal evidence and all native checks.
      if(row.sourceFocusId!==null||Object.hasOwn(row,'focusIds')||!row.evidence)throw refuse('ROW_SHAPE');
      const {sourceFocusId,...rest}=row;return {...rest,focusIds:[]};
    });
    return expanded;
  };
  return {version:1,messageSha256,scopeSha256:exactSha({original:body.original,previous:body.previous,source:body.source,reviewFocus:body.reviewFocus}),expand};
}

// Traceability only, after native parsing and entry-review inspection. Results
// remain actor-scoped so a native failure never exempts a good actor's claims.
// Global malformed/unknown ownership is always reported, even for skipped actors.
export function inspectCurrentClaims(rows,req,{skipActors=[]}={}){
  const actors=new Map(),global=[];
  const result=()=>{
    const perActor=[...(global.length?[{target:null,targetKey:null,passed:false,issues:safeIssues(global),semanticAccepted:false}]:[]),...actors.values()].map(actor=>({...actor,issues:safeIssues(actor.issues),passed:actor.skipped||actor.issues.length===0,semanticAccepted:false}));
    const issues=perActor.flatMap(actor=>actor.issues);
    return {passed:issues.length===0,issues,actors:perActor,semanticAccepted:false};
  };
  let body;
  try{body=requestBody(req);}catch{global.push({code:'REQUEST_SHAPE'});return result();}
  if(!Array.isArray(rows)||!plain(rows.body)||!Array.isArray(rows.body.profiles)){global.push({code:'REVIEW_SHAPE'});return result();}
  if(!Array.isArray(rows.body.entryReview)){global.push({code:rows.body.entryReview===undefined?'REVIEW_MISSING':'REVIEW_SHAPE'});return result();}
  const sourceActors=sourceOnlyPeople(req,body,rows.body.profiles),resolve=name=>canonical(req,name)??sourceActors.get(foldName(String(name??'').trim()));
  const target=body.repair?.target?resolve(body.repair.target):null;
  if(body.repair?.target&&!target){global.push({code:'NAME_OWNERSHIP'});return result();}
  const skipped=new Set(Array.from(skipActors??[],name=>resolve(name)?.key).filter(Boolean));
  const actorFor=person=>{
    if(!actors.has(person.key))actors.set(person.key,{target:person.name,targetKey:person.key,issues:[],...(skipped.has(person.key)?{skipped:true}:{})});
    return actors.get(person.key);
  };
  for(const profile of [...rows,...rows.body.profiles]){
    const person=resolve(profile?.name);
    if(!person||target&&target.key!==person.key)global.push({code:'NAME_OWNERSHIP'});else actorFor(person);
  }
  for(const item of rows.body.entryReview){
    if(!plain(item)||Object.keys(item).some(k=>!reviewFields.has(k))||!Array.isArray(item.focusIds)||!Array.isArray(item.refs)){global.push({code:'ROW_SHAPE'});continue;}
    const person=resolve(item.name),coordinates={focusIds:item.focusIds,refs:item.refs};
    if(!person||target&&target.key!==person.key){global.push({code:'NAME_OWNERSHIP',...coordinates});continue;}
    const actor=actorFor(person);if(actor.skipped)continue;
    if(!decisions.has(item.decision)){actor.issues.push({code:'INVALID_DECISION',...coordinates});continue;}
    if(!['integrate','already_reflected'].includes(item.decision))continue;
    const key=person.key,refs=item.refs,texts=[],ownRefs=new Set([...body.original,...body.previous].filter(p=>canonical(req,p.name)?.key===key).flatMap(p=>[...(p.parts??[]),...(p.noteParts??[])]).map(p=>p.ref));
    if(refs.some(ref=>ref!=='new'&&(!validRef(ref)||!ownRefs.has(ref)))){actor.issues.push({code:'REF_OWNERSHIP',...coordinates});continue;}
    if(item.decision==='already_reflected'){
      for(const p of body.original.filter(p=>canonical(req,p.name)?.key===key))for(const part of p.parts??[])if(refs.includes(part.ref))texts.push(part.text);
      for(const p of body.previous.filter(p=>canonical(req,p.name)?.key===key)){const paragraphs=String(p.text??'').split(/\n\s*\n/u);for(const note of p.noteParts??[])if(refs.includes(note.ref))texts.push(paragraphs[note.paragraph-1]);}
    }else{
      const accepted=rows.find(p=>resolve(p.name)?.key===key),composition=accepted?.composition;
      if(composition&&!composition.pendingRevision&&!composition.pendingOnly&&composition.changeCheck?.status!=='pending'){
        for(const part of composition.parts??[])if(refs.includes(part.ref)&&composition.changes?.some(c=>c.key===part.key&&c.after===part.text))texts.push(part.text);
        for(const change of composition.noteChanges??[])if(refs.includes(change.ref))texts.push(change.after);
        if(refs.includes('new')&&composition.sourceBaseline?.length&&!body.original.some(p=>canonical(req,p.name)?.key===key)&&!body.previous.some(p=>canonical(req,p.name)?.key===key))texts.push(rows.body.profiles.find(p=>resolve(p.name)?.key===key)?.text);
      }
    }
    if(typeof item.current!=='string'||!item.current.trim()||!texts.some(text=>typeof text==='string'&&text.includes(item.current)))actor.issues.push({code:item.decision==='integrate'?'INTEGRATION_NOT_APPLIED':'REFLECTED_REF_MISSING',...coordinates});
  }
  return result();
}

// Explicit v2 resolves action/currentSource into native values inside the same
// actual-send closure. The v1 byte restorer is private, never a legacy fallback.
const validV2Ref=value=>typeof value==='string'&&/^(?:[BN][1-9]\d{0,5}|new)$/.test(value);
const inputRef=value=>validV2Ref(value)&&value!=='new';
const unsafe=/\[\[(?:SHIYI|MEMO_(?:TT|ST))_PERSONA:|<%|%>|<\/?script\b|\{\{(?!\s*(?:user|char)\s*\}\})|@@/i;
const actions=new Map([['edit_current','integrate'],['keep_input','already_reflected'],['not_characterization','not_characterization'],['uncertain','uncertain']]);
function fields(value,allowed){return plain(value)&&Object.keys(value).every(key=>allowed.includes(key));}
function refuseV2(code,row={}){
  if(!plain(row))row={};
  return refuse(code,{focusIds:validFocus(row.sourceFocusId)?[row.sourceFocusId]:[],refs:(Array.isArray(row.refs)?row.refs:[]).filter(validV2Ref)});
}
export function sealReferenceProtocol(req,{enabled=false}={}){
  if(enabled!==true)throw refuseV2('REQUEST_SHAPE');
  const sealed=sealLegacyReferenceBytes(req,{enabled:true}),body=requestBody(req);
  const input=copy(body),canon=name=>{const person=canonical(req,name);if(!person)throw refuseV2('NAME_OWNERSHIP');return person.key;};
  const owned=new Map(),hasBaseline=new Set();
  const put=(name,ref,text)=>{const key=canon(name);if(!owned.has(key))owned.set(key,new Map());owned.get(key).set(ref,text);hasBaseline.add(key);};
  for(const person of input.original)for(const part of person.parts??[])put(person.name,part.ref,part.text);
  for(const person of input.previous){hasBaseline.add(canon(person.name));const paragraphs=String(person.text??'').split(/\n\s*\n/u);for(const note of person.noteParts??[])put(person.name,note.ref,paragraphs[note.paragraph-1]);}
  let lastProvenance=[];
  const expand=(raw,{request,responseMessagesSha256}={})=>{
    lastProvenance=[];
    // Check actual send/context binding before every shape or response branch.
    if(responseMessagesSha256!==sealed.messageSha256||!Array.isArray(request?.messages)||exactSha(request.messages)!==sealed.messageSha256)throw refuseV2('REQUEST_SHAPE');
    if(!fields(raw,['contractVersion','profiles','entryReview'])||raw.contractVersion!==2||!Array.isArray(raw.profiles)||!Array.isArray(raw.entryReview))throw refuseV2('REVIEW_SHAPE');
    const sourceActors=sourceOnlyPeople(req,body,raw.profiles),responseCanon=name=>{const person=canonical(req,name)??sourceActors.get(foldName(String(name??'').trim()));if(!person)throw refuseV2('NAME_OWNERSHIP');return person.key;};
    const mapped=copy(raw),provenance=[];mapped.contractVersion=1;
    mapped.entryReview=mapped.entryReview.map((row,index)=>{
      if(!fields(row,['name','sourceFocusId','action','refs','currentSource','reason','evidence'])||typeof row.name!=='string'||!row.name.trim()||!Array.isArray(row.refs))throw refuseV2('ROW_SHAPE',row);
      if(!actions.has(row.action))throw refuseV2('INVALID_DECISION',row);
      if(new Set(row.refs).size!==row.refs.length||row.refs.some(ref=>!validV2Ref(ref)))throw refuseV2('REF_OWNERSHIP',row);
      const {action,currentSource,reason,...rest}=row,key=responseCanon(row.name),decision=actions.get(action);
      if(action==='uncertain'||action==='not_characterization'){
        if(Object.hasOwn(row,'currentSource')||typeof reason!=='string'||!reason.trim()||reason.length>600||unsafe.test(reason))throw refuseV2('INVALID_CURRENT',row);
        return {...rest,decision,current:reason};
      }
      if(Object.hasOwn(row,'reason')||!fields(currentSource,['kind','index','ref']))throw refuseV2('ROW_SHAPE',row);
      let text,source;
      if(action==='keep_input'){
        if(currentSource.kind!=='input'||Object.keys(currentSource).length!==2||!inputRef(currentSource.ref)||!row.refs.includes(currentSource.ref)||!owned.get(key)?.has(currentSource.ref))throw refuseV2('REF_OWNERSHIP',row);
        text=owned.get(key).get(currentSource.ref);source={kind:'input',ref:currentSource.ref};
      }else{
        const profiles=mapped.profiles.filter(profile=>responseCanon(profile?.name)===key);
        if(profiles.length!==1)throw refuseV2('NAME_OWNERSHIP',row);
        const profile=profiles[0];
        if(currentSource.kind==='text'){
          if(Object.keys(currentSource).length!==1||hasBaseline.has(key)||!row.refs.includes('new'))throw refuseV2('REF_OWNERSHIP',row);
          text=profile.text;source={kind:'text',ref:'new'};
        }else if(currentSource.kind==='updates'||currentSource.kind==='noteUpdates'){
          if(Object.keys(currentSource).length!==2||!Number.isSafeInteger(currentSource.index)||currentSource.index<1||!Array.isArray(profile[currentSource.kind]))throw refuseV2('REF_OWNERSHIP',row);
          const edit=profile[currentSource.kind][currentSource.index-1];
          if(!edit||!validV2Ref(edit.ref)||!row.refs.includes(edit.ref))throw refuseV2('REF_OWNERSHIP',row);
          text=edit.text;source={kind:currentSource.kind,index:currentSource.index,ref:edit.ref};
        }else throw refuseV2('REF_OWNERSHIP',row);
      }
      if(typeof text!=='string'||!text.trim())throw refuseV2('INVALID_CURRENT',row);
      const current=text.slice(0,600);
      if(!current.trim()||unsafe.test(current))throw refuseV2('INVALID_CURRENT',row);
      provenance.push({row:index+1,ownerKey:key,...source,textSha256:exactSha(text),span:{start:0,end:current.length},derivedExcerpt:true,semanticAccepted:false});
      return {...rest,decision,current};
    });
    // The private byte restorer still restores exact before/F bytes and rejects ownership,
    // double-field and legacy-shape violations. Nativeparse/landing follow outside.
    const expanded=sealed.expand(mapped,{request,responseMessagesSha256});
    lastProvenance=provenance;return expanded;
  };
  return {version:2,messageSha256:sealed.messageSha256,scopeSha256:exactSha({version:2,inputScopeSha256:sealed.scopeSha256}),expand,provenance:()=>copy(lastProvenance)};
}
