import {applySummaryArmor,normalizeSummaryArmor,summaryArmorEnabled,summaryToolContent} from './summary-armor.js';
import {activeSummaryPreset} from './summary-presets.js';
import {estimateUnits,sha256} from './utils.js';

/** Transport-only options share the active summary preset. Source requests and
 * native persona output contracts are still prepared and checked by their owners. */
export const activePersonaArmor=settings=>normalizeSummaryArmor(activeSummaryPreset(settings?.summaryPresets??'')?.armor);
export function preparePersonaTransport(request,config,{replay=false,compatibility}={}){
  const armor=normalizeSummaryArmor(replay?compatibility:activePersonaArmor(config));
  const base={model:config.dynamicPersonaModel,messages:request.messages,stream:true,...(config.dynamicPersonaJsonMode&&!armor.antiTruncation?{response_format:{type:'json_object'}}:{}),...(config.dynamicPersonaOutputTokens>0?{max_tokens:config.dynamicPersonaOutputTokens}:{})};
  const payload=applySummaryArmor(base,armor,{task:'persona'});
  return {...request,messages:payload.messages,transportPayload:payload,...(summaryArmorEnabled(armor)?{wireCompatibility:armor}:{})};
}
export const personaTransportUnits=request=>request.wireCompatibility?estimateUnits(JSON.stringify(request.transportPayload)):estimateUnits(JSON.stringify(request.messages));
export function decodePersonaTransport(reply,armor){
  if(['length','max_tokens','truncated','abort','content_filter'].includes(String(reply?.choices?.[0]?.finish_reason).toLowerCase())||reply?.choices?.[0]?.message?.refusal)return reply;
  try{const content=summaryToolContent(reply,{enabled:normalizeSummaryArmor(armor).antiTruncation});if(content===null)return reply;return {...reply,choices:[{...reply.choices[0],message:{...reply.choices[0].message,content}}]};}
  catch(cause){throw Object.assign(new Error('人设反截断回复不完整；原正式档案保留'),{code:'PERSONA_RESPONSE_INVALID',details:{stage:'parse_content',reason:'persona_fields',personaIssue:'invalid_json',causeError:cause}});}
}
export function assertPersonaWire(messages,payload){if(!payload||sha256(JSON.stringify(messages))!==sha256(JSON.stringify(payload.messages)))throw Object.assign(new Error('人设实际发送与已核对请求不一致'),{code:'SOURCE_INVALIDATED'});}
