/** Prompt comparison release: return the pre-compaction built-in prose unchanged.
 * Keep the projection ports so preview and actual dispatch stay consistent.
 * Saved/custom presets and provider reasoning options are unchanged.
 */
export function compactSummarySystem(system, _guard = '') { return system; }
export function compactSummaryContract(contract) { return contract; }
export function summaryReasoningOptions(profile = {}) {
 let url;try{url=new URL(profile.url??profile.endpoint);}catch{return {};}
 // Custom relays can reject otherwise standard fields. Never probe or retry
 // just to detect capabilities, and never infer them from a model alias.
 return url.protocol==='https:'&&url.hostname==='generativelanguage.googleapis.com'&&/^\/v1(?:beta)?\/openai\//.test(url.pathname)&&/^gemini-(?:2\.5|3(?:\.\d+)?)[-]/.test(profile.model??'')?{reasoning_effort:'low'}:{};
}
