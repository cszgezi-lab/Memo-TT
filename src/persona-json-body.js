// Shared by native parsing, reference expansion and the recovery receipt.
// No fields are repaired: only a unique complete fenced contract may be read
// after an incomplete prefix. Earlier complete roots remain ambiguous.
function completeFencedJSONPrefix(text){
  if(!['{','['].includes(text[0]))return false;
  const stack=[],pairs={'{':'}','[':']'};let quoted=false,escaped=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;continue;}
    if(pairs[c])stack.push(pairs[c]);
    else if(c==='}'||c===']'){
      if(stack.pop()!==c)return false;
      if(!stack.length){try{JSON.parse(text.slice(0,i+1));return true;}catch{return false;}}
    }
  }
  return false;
}
export function personaContentText(content){
  if(typeof content==='string')return content;
  if(Array.isArray(content)&&content.length>0&&content.every(part=>part&&part.type==='text'&&typeof part.text==='string'))return content.map(part=>part.text).join('');
  throw new SyntaxError('Unsupported persona text content');
}
export function personaJSONBody(content,{allowRestart=false}={}){
  const source=personaContentText(content),direct=source.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{return JSON.parse(direct);}catch(error){if(!allowRestart)throw error;}
  const markers=[...source.matchAll(/```json(?=[\s{])[ \t]*(?:\r?\n)?/gi)],roots=[];let complete=0;
  for(let i=0;i<markers.length;i++){
    const from=markers[i].index+markers[i][0].length,to=i+1<markers.length?markers[i+1].index:source.length;
    const text=source.slice(from,to).trim().replace(/\s*```$/,'').trim();
    if(completeFencedJSONPrefix(text))complete++;
    let value;try{value=JSON.parse(text);}catch{continue;}
    if(value&&typeof value==='object'&&!Array.isArray(value)&&value.contractVersion===2&&Array.isArray(value.profiles)&&Array.isArray(value.entryReview))roots.push(value);
  }
  if(complete!==1||roots.length!==1)throw new SyntaxError('No unique complete persona JSON contract');
  return roots[0];
}
