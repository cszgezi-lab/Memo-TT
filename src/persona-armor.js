import {personaWireMessages} from './persona-request-body.js';
import {applySummaryArmor,normalizeSummaryArmor,summaryArmorEnabled,summaryToolContent} from './summary-armor.js';
import {activeSummaryPreset} from './summary-presets.js';
import {estimateUnits,sha256,isPlainObject} from './utils.js';
import {SUMMARY_ARMOR_HEADER_TEXT,SUMMARY_ARMOR_USER_TEXT} from './summary-armor-text.js';

// Historical paid receipts bind exact message bytes. Reconstruct the retired
// format only for local receipt verification, never for model dispatch.
function legacyAuditPayload(base,armor){
  const sentinel='MEMO_LOCAL_RECEIPT_AUDIT_ONLY',prefix=text=>`<summary_compatibility_context>\n${text}\n</summary_compatibility_context>\n\n`;
  const payload=applySummaryArmor(base,{...armor,words:sentinel},{task:'persona'});
  const header=armor.headerPadding?Array.from(SUMMARY_ARMOR_HEADER_TEXT).slice(0,14460).join(''):'';
  const preface=[header,armor.words].filter(Boolean).join('\n\n');
  const system=payload.messages.find(m=>m.role==='system');
  system.content=(preface?prefix(preface):'')+system.content.slice(prefix(sentinel).length);
  if(armor.userPadding){
    const user=payload.messages.find(m=>m.role==='user'),envelope=JSON.parse(user.content);
    if(!isPlainObject(envelope)||Object.hasOwn(envelope,'compatibilityPadding'))throw Object.assign(new Error('历史人设审计输入异常'),{code:'SOURCE_INVALIDATED'});
    user.content=JSON.stringify({...envelope,compatibilityPadding:{kind:'non_story_padding',text:SUMMARY_ARMOR_USER_TEXT,ignoreForSummary:true}});
  }
  return payload;
}

/** Transport-only options share the active summary preset. Source requests and
 * native persona output contracts are still prepared and checked by their owners. */
export const activePersonaArmor=settings=>normalizeSummaryArmor(activeSummaryPreset(settings?.summaryPresets??'')?.armor);
export function preparePersonaTransport(request,config,{replay=false,compatibility,expectedWireSha256}={}){
  const armor=normalizeSummaryArmor(replay?compatibility:activePersonaArmor(config));
  const base={model:config.dynamicPersonaModel,messages:personaWireMessages(request),stream:true,...(config.dynamicPersonaJsonMode&&!armor.antiTruncation?{response_format:{type:'json_object'}}:{}),...(config.dynamicPersonaOutputTokens>0?{max_tokens:config.dynamicPersonaOutputTokens}:{})};
  let payload=applySummaryArmor(base,armor,{task:'persona'});
  if(replay){
    if(expectedWireSha256&&sha256(JSON.stringify(payload.messages))!==expectedWireSha256&&(armor.headerPadding||armor.userPadding)){
      const legacy=legacyAuditPayload(base,armor);
      // Select only a deterministic format with the already verified receipt's
      // exact digest. A mismatch still fails the ordinary recovery validator.
      if(sha256(JSON.stringify(legacy.messages))===expectedWireSha256)payload=legacy;
    }
    Object.defineProperty(payload,'_personaLocalAuditOnly',{value:true});
  }
  const unpackedChars=JSON.stringify(request.messages).length,encodedChars=JSON.stringify(base.messages).length;
  const inputSize={...request.inputSize,personaRequestChars:JSON.stringify(payload.messages).length,personaPayloadChars:JSON.stringify(payload).length,personaUnpackedChars:unpackedChars,personaStructureSavedChars:Math.max(0,unpackedChars-encodedChars)};
  return {...request,messages:payload.messages,transportPayload:payload,inputSize,...(summaryArmorEnabled(armor)?{wireCompatibility:armor}:{})};
}
export const personaTransportUnits=request=>request.wireCompatibility?estimateUnits(JSON.stringify(request.transportPayload)):estimateUnits(JSON.stringify(request.messages));
export function decodePersonaTransport(reply,armor){
  if(['length','max_tokens','truncated','abort','content_filter'].includes(String(reply?.choices?.[0]?.finish_reason).toLowerCase())||reply?.choices?.[0]?.message?.refusal)return reply;
  try{const content=summaryToolContent(reply,{enabled:normalizeSummaryArmor(armor).antiTruncation});if(content===null)return reply;return {...reply,choices:[{...reply.choices[0],message:{...reply.choices[0].message,content}}]};}
  catch(cause){throw Object.assign(new Error('人设反截断回复不完整；原正式档案保留'),{code:'PERSONA_RESPONSE_INVALID',details:{stage:'parse_content',reason:'persona_fields',personaIssue:'invalid_json',causeError:cause}});}
}
export function assertPersonaWire(messages,payload){if(!payload||payload._personaLocalAuditOnly||sha256(JSON.stringify(messages))!==sha256(JSON.stringify(payload.messages)))throw Object.assign(new Error('人设实际发送与已核对请求不一致'),{code:'SOURCE_INVALIDATED'});}
