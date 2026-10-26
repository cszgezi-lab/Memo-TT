import {clone} from './utils.js';

const detailKinds=new Set(['events','awarenessChanges','entityFactChanges','relationshipChanges','personaChanges','commitmentChanges','performanceHints','conflicts']);
// Remove whole, precisely diagnosed detail rows. Floor text, coverage and
// execution binding are never manufactured or removed to obtain a pass.
export function discardInvalidDetailRows(input,validation){
 const bad=new Map(),issues=[];
 for(const issue of validation?.validationIssues??[]){
  const match=/^(\w+)\[(\d+)\](?:\.|$)/.exec(issue.path??'');
  if(!match||!detailKinds.has(match[1])||issue.reason==='binding_mismatch')continue;
  const [,kind,position]=match,index=Number(position);
  if(!Array.isArray(input?.[kind])||index>=input[kind].length)continue;
  if(!bad.has(kind))bad.set(kind,new Set());bad.get(kind).add(index);issues.push(issue);
 }
 if(!bad.size)return {output:input,skippedRecords:0,validationIssues:[]};
 const output=clone(input),removedEvents=new Set();let skippedRecords=0;
 for(const [kind,indices]of bad){
  if(kind==='events')for(const index of indices){const id=input[kind][index]?.id;if(typeof id==='string')removedEvents.add(id);}
  output[kind]=output[kind].filter((_,index)=>!indices.has(index));skippedRecords+=indices.size;
 }
 // Optional event links can leave with their rejected local event, while the
 // independently sourced floor text and remaining references stay intact.
 const remainingEvents=new Set((output.events??[]).map(e=>e?.id));
 for(const id of remainingEvents)removedEvents.delete(id);
 for(const row of output.summaryView??[]){
  if(removedEvents.has(row.eventRef))delete row.eventRef;
  if(Array.isArray(row.eventRefs))row.eventRefs=row.eventRefs.filter(id=>!removedEvents.has(id));
 }
 return {output,skippedRecords,validationIssues:issues};
}

export function withSummaryRowIsolation(input,transform,onSkipped=()=>{}){
 let output=input;
 for(;;){
  try{return transform(output);}catch(error){
   if(error?.code!=='VALIDATION_ERROR')throw error;
   const isolated=discardInvalidDetailRows(output,error.details);
   if(!isolated.skippedRecords)throw error;
   output=isolated.output;onSkipped(isolated);
  }
 }
}
