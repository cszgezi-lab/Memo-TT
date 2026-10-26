// User-requested failure evidence, kept locally and included in diagnostic export.
// This bounded buffer observes the existing response; it never reads a request.
const LIMIT=8192,EDGE=4096;
function redact(text,secrets=[]){
  let value=String(text);
  for(const secret of secrets.filter(s=>typeof s==='string'&&s.length>=4)){
    value=value.split(secret).join('[REDACTED]');
    // A retained edge may bisect a credential before export truncation.
    for(let n=Math.min(secret.length-1,value.length);n>=8;n--){
      if(value.endsWith(secret.slice(0,n))){value=value.slice(0,-n)+'[REDACTED]';break;}
      if(value.startsWith(secret.slice(-n))){value='[REDACTED]'+value.slice(n);break;}
    }
  }
  return value.replace(/\bBearer\s+[^\s"'\\,;}]+/gi,'Bearer [REDACTED]')
    .replace(/\b(?:sk-|github_pat_|gh[pousr]_)[A-Za-z0-9_-]{8,}/g,'[REDACTED]')
    .replace(/([?&](?:key|api_key|token|access_token|auth)=)[^&\s"'<>\\]+/gi,'$1[REDACTED]')
    .replace(/(\b(?:api[_-]?key|authorization|access[_-]?token|password|secret)\b\s*["']?\s*[:=]\s*["']?)[^\s"'\\,;}]+/gi,'$1[REDACTED]');
}
export function safeResponseExcerpt(value){
  if(value?.kind!=='response-excerpt-v1'||!Number.isSafeInteger(value.totalChars)||value.totalChars<0||typeof value.prefix!=='string'||typeof value.suffix!=='string')return null;
  const prefix=redact(value.prefix).slice(0,value.suffix?EDGE:LIMIT),suffix=redact(value.suffix).slice(-EDGE);
  return {kind:'response-excerpt-v1',totalChars:value.totalChars,truncated:value.truncated===true,prefix,suffix,
    finishReason:typeof value.finishReason==='string'?value.finishReason.replace(/[^a-z0-9_-]/gi,'').slice(0,40):'unknown',
    streamChunks:Number.isSafeInteger(value.streamChunks)?Math.max(0,value.streamChunks):null,
    streamDone:typeof value.streamDone==='boolean'?value.streamDone:null};
}
export function createResponseExcerpt({secrets=[]}={}){
  let head='',tail='',totalChars=0;
  return {push(text){
    text=String(text);totalChars+=text.length;
    if(head.length<LIMIT)head+=Array.from(text.slice(0,LIMIT-head.length)).join('');
    tail=Array.from((tail+text).slice(-EDGE)).join('');
  },snapshot(details={}){
    const truncated=totalChars>LIMIT;
    return safeResponseExcerpt({kind:'response-excerpt-v1',totalChars,truncated,
      prefix:redact(head,secrets).slice(0,truncated?EDGE:LIMIT),suffix:truncated?redact(tail,secrets):'',
      finishReason:details.finishReason,streamChunks:details.streamChunks,streamDone:details.streamDone});
  }};
}
