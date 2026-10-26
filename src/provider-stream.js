import {SummaryResponseError,ShiyiError} from './errors.js';
import {nativeStreamErrorCode} from './diagnostics.js';
import {providerEnvelopeFailure} from './product-feedback.js';

const invalid=(reason='stream_invalid',details={})=>{throw new SummaryResponseError('chat stream was not complete or valid',{reason,stage:'read_body',...details});};
// One decoder for byte streams and native buffered SSE. No partial answer is
// exposed to the business layer; errors can terminate an open connection early.
export function createChatEventStreamParser({allowUnmarkedJson=false}={}){
  let pending='',trailingCR='',first=true,done=false,finish=null,usage,model,chunks=0,refusal='',tool=null;
  const content=[];
  function consume(event){
    const data=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
    if(!data.trim())return;
    if(done)invalid('stream_invalid',{streamChunks:chunks});
    if(data.trim()==='[DONE]'){done=true;return;}
    let value;try{value=JSON.parse(data);}catch{invalid('stream_invalid',{streamChunks:chunks});}
    chunks++;
    if(/^tauritavern-error-chunk-\d+$/.test(value?.id??'')){
      const error=providerEnvelopeFailure({message:value?.choices?.[0]?.delta?.content});
      const nativeErrorCode=nativeStreamErrorCode(value?.choices?.[0]?.delta?.content);
      throw new ShiyiError('native chat stream returned an error','PROVIDER_STREAM_ERROR',{...error.details,...(nativeErrorCode?{nativeErrorCode}:{}),reason:'stream_error',stage:'read_body',streamChunks:chunks,upstreamDetailsProvided:true});
    }
    if(value?.error){
      const reported=providerEnvelopeFailure({...value,...(typeof value.error==='object'?value.error:{message:value.error})});
      throw new ShiyiError('chat stream returned an error','PROVIDER_STREAM_ERROR',{...reported.details,reason:'stream_error',stage:'read_body',streamChunks:chunks,upstreamDetailsProvided:true});
    }
    if(!Array.isArray(value?.choices)||value.choices.length>1)invalid('stream_invalid',{streamChunks:chunks});
    if(value.usage)usage=value.usage;
    if(typeof value.model==='string')model=value.model;
    const choice=value.choices[0];if(!choice)return;
    if(choice.index!==undefined&&choice.index!==0)invalid('stream_invalid',{streamChunks:chunks});
    const delta=choice.delta;
    if(!delta||typeof delta!=='object'||Array.isArray(delta)||delta.function_call)invalid('stream_invalid',{streamChunks:chunks});
    if(delta.content!==undefined&&delta.content!==null){
      if(typeof delta.content!=='string'||finish&&delta.content)invalid('stream_invalid',{streamChunks:chunks});
      content.push(delta.content);
    }
    if(delta.tool_calls!==undefined){
      if(!Array.isArray(delta.tool_calls)||delta.tool_calls.length>1)invalid('stream_invalid',{streamChunks:chunks});
      for(const part of delta.tool_calls){
        if(finish||part?.index!==0||part.type!==undefined&&part.type!=='function'||part.function!==undefined&&(!part.function||typeof part.function!=='object'||Array.isArray(part.function)))invalid('stream_invalid',{streamChunks:chunks});
        tool??={id:'',type:'function',function:{name:'',arguments:''}};
        for(const [key,target] of [['id',tool],['name',tool.function],['arguments',tool.function]]){
          const fragment=key==='id'?part.id:part.function?.[key];
          if(fragment!==undefined){if(typeof fragment!=='string')invalid('stream_invalid',{streamChunks:chunks});target[key]+=fragment;}
        }
      }
    }
    // Reasoning stays outside stored memory and diagnostics.
    if(typeof delta.refusal==='string')refusal+=delta.refusal;
    if(choice.finish_reason!=null){if(finish)invalid('stream_invalid',{streamChunks:chunks});finish=choice.finish_reason;}
  }
  function push(text){
    text=trailingCR+String(text);trailingCR='';
    if(first&&text.length){text=text.replace(/^\uFEFF/,'');first=false;}
    if(text.endsWith('\r')){trailingCR='\r';text=text.slice(0,-1);}
    pending+=text.replace(/\r\n?/g,'\n');
    let boundary;while((boundary=pending.indexOf('\n\n'))>=0){const event=pending.slice(0,boundary);pending=pending.slice(boundary+2);consume(event);}
  }
  return {push,finish(){
    if(trailingCR){trailingCR='';push('\n');}
    if(pending.trim())consume(pending);
    const text=content.join('');
    // Some relays put a standalone prompt-rejection notice in delta.content,
    // then send usage and DONE without finish_reason. Match this observed
    // notice at the start, not policy words quoted inside valid summary JSON.
    if(!tool&&text.length<=4096&&/^The prompt could not be submitted\.\s+The prompt contains sensitive words that violate Google's \[Generative AI Prohibited Use policy\]\(https:\/\/policies\.google\.com\/terms\/generative-ai\/use-policy\)\./.test(text.trim())){
      throw new ShiyiError('provider rejected the prompt','PROVIDER_STREAM_ERROR',{reason:'output_blocked',upstreamHint:'content_blocked',stage:'read_body',streamChunks:chunks,responseChars:text.length,finishReason:finish??'missing',streamDone:done});
    }
    let json;
    if(!tool&&text.trim().startsWith('{'))try{json=JSON.parse(text);}catch{/* normal content validation handles syntax */}
    if(json?.error){
      const error=providerEnvelopeFailure(json);
      throw new ShiyiError('chat stream contained an error response','PROVIDER_STREAM_ERROR',{...error.details,reason:'stream_error',stage:'read_body',streamChunks:chunks,responseChars:text.length});
    }
    if(refusal.trim())throw new ShiyiError('chat stream refused the request','PROVIDER_STREAM_ERROR',{reason:'output_blocked',upstreamHint:'content_blocked',stage:'read_body',streamChunks:chunks,responseChars:text.length});
    // EOF plus the provider's finish frame is sufficient. Some relays omit
    // DONE, including after length/content_filter; preserve that actual reason.
    // Summary callers may pass a complete JSON object onward without inventing
    // a finish reason. Their normal source, floor and schema validators decide
    // whether it can be saved. Never close brackets or recover a partial object.
    const jsonComplete=allowUnmarkedJson&&!tool&&json&&typeof json==='object'&&!Array.isArray(json)&&Object.keys(json).length>0;
    if(typeof finish!=='string'&&!jsonComplete)invalid('stream_incomplete',{streamChunks:chunks,responseChars:text.length+(tool?.function.arguments.length??0),finishReason:'missing',streamDone:done});
    if(tool&&finish!=='tool_calls'&&finish!=='length'&&finish!=='content_filter')invalid('stream_invalid',{streamChunks:chunks});
    return {object:'chat.completion',...(model?{model}:{}),choices:[{index:0,message:{role:'assistant',content:content.join(''),...(tool?{tool_calls:[tool]}:{}),...(refusal?{refusal}:{})},finish_reason:finish}],...(usage?{usage}:{}),_shiyiStream:{streaming:true,streamChunks:chunks}};
  }};
}
export function parseChatEventStream(text){const parser=createChatEventStreamParser();parser.push(text);return parser.finish();}
