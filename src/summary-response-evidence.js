import {createResponseExcerpt} from './response-excerpt.js';

// Response-only diagnostic ports. No history, credentials storage or model port.
export function modelResponseExcerpt(raw,{secrets=[]}={}) {
 let payload=typeof raw?.body==='string'?raw.body:raw;
 if(typeof payload==='string'){try{payload=JSON.parse(payload);}catch{/* preserve non-JSON response */}}
 const choice=payload?.choices?.[0],message=choice?.message;
 let content=message?.content??payload?.output_text;
 if(Array.isArray(content))content=content.map(p=>typeof p?.text==='string'?p.text:JSON.stringify(p)).join('\n');
 if(message?.tool_calls?.length)content=[content,...message.tool_calls.map(t=>t?.function?.arguments)].filter(x=>typeof x==='string').join('\n');
 if(typeof message?.refusal==='string')content=[content,message.refusal].filter(x=>typeof x==='string').join('\n');
 if(typeof content!=='string')content=typeof payload==='string'?payload:JSON.stringify(payload);
 if(typeof content!=='string')return null;
 const buffer=createResponseExcerpt({secrets});buffer.push(content);
 return buffer.snapshot({finishReason:choice?.finish_reason??choice?.finishReason??payload?.finish_reason});
}
export async function parseWithResponseEvidence(raw,{parse,onFailure=()=>{},secrets=[]}) {
 try{return await parse(raw);}catch(error){
  try{const excerpt=modelResponseExcerpt(raw,{secrets});if(excerpt)onFailure(excerpt,error);}catch{/* evidence never masks the original failure */}
  throw error;
 }
}
export async function readCachedFailureResponses({batches,readTask,readCheckpoint,check=()=>{},secrets=[]}) {
 check();const out=[],seen=new Set();let reads=0;
 const read=async id=>{check();if(!id||seen.has(id)||reads>=10)return null;seen.add(id);reads++;const task=await readTask(id);check();return task;};
 const rows=batches.filter(b=>['failed','interrupted','running','queued'].includes(b.status)).sort((a,b)=>(b.updatedAt??b.createdAt??0)-(a.updatedAt??a.createdAt??0)).slice(0,5);
 for(const row of rows){
  const ids=[...new Set([row.operationId,row.previousOperation,...(row.attempts??[]).slice(-2)].filter(id=>typeof id==='string'))].slice(0,3);
  for(const id of ids){
   const task=await read(id);if(!task)continue;
   const add=(value,operationId)=>{
    if(value?.raw===undefined)return;
    const responseExcerpt=modelResponseExcerpt(value.raw,{secrets});
    const sourceLocators=(value.batch?.sourceMessages??task.batch?.sourceMessages??[]).slice(0,200).map(m=>({sourceId:m.id,floorIndex:m.index,...(m.fragmentId!=null?{fragmentId:m.fragmentId}:{})}));
    if(responseExcerpt)out.push({origin:'cached-unvalidated-response',batchNumber:row.number,startIndex:row.startIndex,endIndex:row.endIndex,operationId,updatedAt:value.updatedAt,...(sourceLocators.length?{sourceLocators}:{}),responseExcerpt});
   };
   add(task,id);
   const plan=task.requestPlan?.splitPlan??(await readCheckpoint(id))?.splitPlan??[];check();
   for(const child of plan){if(reads>=10)break;const cached=await read(child.operationId);if(cached)add(cached,child.operationId);}
  }
 }
 check();return out;
}
