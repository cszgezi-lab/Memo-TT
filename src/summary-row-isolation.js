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

// Reject the complete floor row, never guess a replacement source identity.
// Other source/shape/binding failures retain their existing strict checks.
export function admitFloorSourceRows(input,transform,onSkipped=()=>{}){
 let output=input,skippedFloors=0,sourceError;
 for(;;){
  try{
   const expanded=transform(output);
   if(skippedFloors&&!Object.entries(expanded).some(([key,rows])=>key!=='coverage'&&Array.isArray(rows)&&rows.length))throw sourceError;
   return {output:expanded,skippedFloors};
  }catch(error){
   if(error?.code!=='VALIDATION_ERROR')throw error;
   const detail=discardInvalidDetailRows(output,error.details);
   if(detail.skippedRecords){output=detail.output;onSkipped(detail);continue;}
   const issue=error.details?.validationIssues?.find(issue=>issue.reason==='unknown_source'&&/^summaryView\[\d+\]\.sourceId$/.test(issue.path??''));
   if(!issue)throw error;
   const index=Number(/\[(\d+)\]/.exec(issue.path)[1]);
   if(!Array.isArray(output.summaryView)||!output.summaryView[index])throw error;
   sourceError??=error;output=clone(output);output.summaryView.splice(index,1);skippedFloors++;
  }
 }
}

// Floor event locators are optional metadata. Prune only a field explicitly
// diagnosed as unknown_event, using the validator's same local/known ID sets.
// Text, source evidence, coverage and required detail dependencies stay intact.
export function discardInvalidFloorEventLinks(input,validation,{knownRecordIds=new Set()}={}){
 const valid=new Set([...knownRecordIds,...(Array.isArray(input.events)?input.events:[]).map(e=>e.id)]),issues=[];
 let output=input,skippedLinks=0;
 for(const issue of validation?.validationIssues??[]){
  const match=/^summaryView\[(\d+)\]\.(eventRef|eventRefs|eventId|eventIds|sourceEventId)$/.exec(issue.path??'');
  if(issue.reason!=='unknown_event'||!match)continue;
  const index=Number(match[1]),key=match[2],row=output.summaryView?.[index];
  if(!row||!Object.hasOwn(row,key))continue;
  const value=row[key],array=key==='eventRefs'||key==='eventIds';
  if(array&&!Array.isArray(value))continue;
  const kept=array?value.filter(id=>valid.has(id)):undefined,removed=array?value.length-kept.length:valid.has(value)?0:1;
  if(!removed)continue;
  if(output===input)output=clone(input);
  if(array)output.summaryView[index][key]=kept;else delete output.summaryView[index][key];
  skippedLinks+=removed;issues.push(issue);
 }
 return {output,skippedLinks,validationIssues:issues};
}
