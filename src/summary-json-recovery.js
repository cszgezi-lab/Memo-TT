import {parseSummaryJson} from './summary-json.js';
const details=new Set(['events','awarenessChanges','entityFactChanges','relationshipChanges','personaChanges','commitmentChanges','performanceHints','conflicts']);
const arrays=new Set([...details,'summaryView','excluded','unprocessed']);
// The scanner finds complete lexical elements only. JSON.parse remains the
// authority for every admitted element; no quotes/brackets/values are added.
export function recoverModuleJsonRows(text){
 let i=0,skippedRecords=0;const value={},validationIssues=[];
 const fail=()=>{throw new SyntaxError('Unrecoverable module JSON boundary');};
 const space=()=>{while(i<text.length&&[9,10,13,32].includes(text.charCodeAt(i)))i++;};
 function string(){const start=i;if(text[i++]!=='"')fail();while(i<text.length){if(text.charCodeAt(i)===92){i+=2;continue;}if(text[i++]==='"')return JSON.parse(text.slice(start,i));}fail();}
 function element(){
  const start=i,stack=[];let quoted=false;
  while(i<text.length){const c=text[i];
   if(quoted){if(c.charCodeAt(0)===92){i+=2;continue;}if(c==='"')quoted=false;i++;continue;}
   if(c==='"'){quoted=true;i++;continue;}
   if(!stack.length&&(c===','||c===']'))break;
   if(c==='{'||c==='[')stack.push(c);
   else if(c==='}'||c===']'){if(stack.pop()!==(c==='}'?'{':'['))fail();}
   i++;
  }
  if(quoted||stack.length||i===start)fail();return text.slice(start,i);
 }
 try{
  space();if(text[i++]!=='{')fail();space();
  while(text[i]!=='}'){
   const key=string();if(Object.hasOwn(value,key)||key!=='format'&&!arrays.has(key))fail();space();if(text[i++]!==':')fail();space();
   if(key==='format')value[key]=string();
   else{
    if(text[i++]!=='[')fail();space();const rows=[];let index=0;
    while(text[i]!==']'){
     const raw=element();if(!raw.trim())fail();
     try{rows.push(parseSummaryJson(raw).value);}catch(error){if(!details.has(key))throw error;skippedRecords++;validationIssues.push({path:key+'['+index+']',reason:'invalid_shape'});}
     index++;space();if(text[i]===']')break;if(text[i++]!==',')fail();space();if(text[i]===']')fail();
    }
    if(text[i++]!==']')fail();value[key]=rows;
   }
   space();if(text[i]==='}')break;if(text[i++]!==',')fail();space();if(text[i]==='}')fail();
  }
  if(text[i++]!=='}')fail();space();
  if(i!==text.length||value.format!=='shiyi-module-records-v1'||!skippedRecords||![...details,'summaryView'].every(k=>Array.isArray(value[k]))||!value.summaryView.length)fail();
  return {value,skippedRecords,validationIssues};
 }catch{return null;}
}
