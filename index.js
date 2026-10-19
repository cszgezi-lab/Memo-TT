import { initProductShell } from './ui/product-view.js';

export { initProductShell } from './ui/product-view.js';
import { createProductShellController as createCoreController } from './src/product-shell-controller.js';
import { HostAdapter } from './src/host-adapter.js';
import { createMemoHostAdapter } from './src/memo-host-adapter.js';
export function createProductShellController(options={}){const host=options.host??globalThis,adapter=createMemoHostAdapter(options.adapter??new HostAdapter(host),{edition:'tt',disposeUnderlying:options.adapter==null,independentLifetime:true}),core=createCoreController({...options,host,adapter}),descriptors=Object.getOwnPropertyDescriptors(core);descriptors.dispose={...descriptors.dispose,value:async()=>{try{return await core.dispose();}finally{await adapter.dispose();}}};return Object.freeze(Object.defineProperties({},descriptors));}
export * from './src/product-settings.js';
export {
  DEFAULT_USER_EXTRACTORS,
  DEFAULT_SUMMARY_LANGUAGE,
  PROMPT_LABELS,
  applyExtractors,
  buildPromptFromExtracted,
  extractSingleAssistantReply,
} from './src/user-extractors.js';

/** Mount UI and follow the current chat locally; model requests remain explicit/opt-in. */
export function init(options = {}) {
  return initProductShell(options);
}
