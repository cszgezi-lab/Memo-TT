// Version 17 changes only the representation of owned source parts on the wire.
// Saved dossiers and all local edit/evidence checks use the same full objects.
// Older paid request views must keep their exact bytes.
export const PERSONA_PARTS_WIRE='original.parts每行依次为[ref,完整text,标题t或null,可选原属性对象]。人物partDefaultTitle=1时省略t并默认1；没有第三、四项表示没有其它属性。t引用同人物sourceTitles（从1起算）。B/N编号、全文、归属、受保护引语及回复合同均不变；不合并或重新编号。';
const own=(v,k)=>Object.hasOwn(v,k);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const ref=v=>typeof v==='string'&&/^[BN][1-9]\d{0,5}$/.test(v);
const attrs=new Set(['title','editable','protectedQuotes','kind','retirable','retireTogether']);
function invalid(){throw Object.assign(new Error('人物输入结构核对失败；原档案保留'),{code:'SOURCE_INVALIDATED'});}
function attributes(value){
  if(!plain(value)||Object.keys(value).some(k=>!attrs.has(k)))invalid();
  if(own(value,'title')&&typeof value.title!=='string'||own(value,'editable')&&value.editable!==false&&value.editable!=='surrounding_prose'||own(value,'kind')&&value.kind!=='source_style_quote'||own(value,'retirable')&&typeof value.retirable!=='boolean')invalid();
  if(own(value,'protectedQuotes')&&(!Array.isArray(value.protectedQuotes)||value.protectedQuotes.some(q=>typeof q!=='string'))||own(value,'retireTogether')&&(!Array.isArray(value.retireTogether)||value.retireTogether.some(r=>!ref(r))))invalid();
  return value;
}
function unpack(body){
  if(body.partsWire!==PERSONA_PARTS_WIRE||!Array.isArray(body.original))invalid();
  const {partsWire,...out}=body;
  out.original=body.original.map(person=>{
    if(!plain(person)||!Array.isArray(person.parts))invalid();
    const {partDefaultTitle,...rest}=person,hasDefault=own(person,'partDefaultTitle'),seen=new Set();
    if(hasDefault&&(partDefaultTitle!==1||person.sourceTitles?.length!==1))invalid();
    if(person.sourceTitles!==undefined&&(!Array.isArray(person.sourceTitles)||person.sourceTitles.some(t=>typeof t!=='string')))invalid();
    return {...rest,parts:person.parts.map(row=>{
      if(!Array.isArray(row)||row.length<2||row.length>4||!ref(row[0])||typeof row[1]!=='string'||seen.has(row[0]))invalid();
      seen.add(row[0]);const t=row[2];
      if(row.length>=3&&(hasDefault?t!==null:t!==null&&(!Number.isSafeInteger(t)||t<1||t>(person.sourceTitles?.length??0))))invalid();
      const extra=row.length===4?attributes(row[3]):{};
      return {ref:row[0],text:row[1],...extra,...(hasDefault?{t:1}:row.length>=3&&t!==null?{t}:{})};
    })};
  });
  return out;
}
export function personaRequestBody(request){
  const body=JSON.parse(request.messages[1].content);
  if(!plain(body))invalid();
  if(!own(body,'partsWire')){
    if(body.original?.some(p=>own(p,'partDefaultTitle')||p.parts?.some(Array.isArray)))invalid();
    return body;
  }
  if(request.requestViewVersion!==17)invalid();
  return unpack(body);
}
export function personaWireMessages(request){
  if(request.requestViewVersion!==17)return request.messages;
  const input=JSON.parse(request.messages[1].content);
  if(own(input,'partsWire')){personaRequestBody(request);return request.messages;}
  const body=personaRequestBody(request);
  if(!Array.isArray(body.original)||!body.original.some(p=>p.parts?.length))return request.messages;
  const original=body.original.map(person=>{
    if(own(person,'partDefaultTitle')||!Array.isArray(person.parts))invalid();
    const allDefault=person.parts.length>0&&person.sourceTitles?.length===1&&person.parts.every(p=>own(p,'t')&&p.t===1);
    const seen=new Set(),parts=person.parts.map(p=>{
      if(!plain(p)||!ref(p.ref)||typeof p.text!=='string'||seen.has(p.ref))invalid();seen.add(p.ref);
      const {ref:r,text,t,...extra}=p;attributes(extra);
      if(own(p,'t')&&(!Number.isSafeInteger(t)||t<1||t>(person.sourceTitles?.length??0)))invalid();
      const row=[r,text],hasExtra=Object.keys(extra).length>0;
      if(!allDefault&&(own(p,'t')||hasExtra)||allDefault&&hasExtra)row.push(!allDefault&&own(p,'t')?t:null);
      if(hasExtra)row.push(extra);
      return row;
    });
    return {...person,parts,...(allDefault?{partDefaultTitle:1}:{})};
  });
  const messages=[request.messages[0],{...request.messages[1],content:JSON.stringify({...body,original,partsWire:PERSONA_PARTS_WIRE})}];
  // The same deterministic decision is used for budget, send and receipt replay.
  // A small dossier keeps its ordinary representation when a legend costs more.
  return JSON.stringify(messages).length<JSON.stringify(request.messages).length?messages:request.messages;
}
