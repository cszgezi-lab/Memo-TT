import {clone,sha256} from './utils.js';
import {defaultProductSettings,validateProductPatch} from './product-settings.js';
import {credentialOrigin} from './product-credentials.js';
import {isMissingProductEntry} from './product-host-adapters.js';
import {verifiedWrite} from './reliable-storage.js';
import {memoStorageLock} from './memo-storage-lock.js';
export const SUMMARY_API_PRESET_KEYS=Object.freeze(['providerEndpoint','providerEndpointMode','providerModel','providerAuthMode','summaryRequestMode','summaryStreaming','summaryDeadlineMs','deadlineMs','chatRequestsPerMinute','inputBudgetUnits','outputBudgetUnits']);
const address={namespace:'shiyi-device-credentials',key:'summary-presets-v1'};
const publicItem=({id,name,settings,key})=>({id,name,model:settings.providerModel,hasKey:Boolean(key)});
export function summaryApiPresetSettings(settings){return Object.fromEntries(SUMMARY_API_PRESET_KEYS.map(k=>[k,settings[k]]));}
export function createSummaryApiPresets({getStore}){
 const defaults=summaryApiPresetSettings(defaultProductSettings());
 const validate=item=>{
  if(!item||typeof item.name!=='string'||!item.name.trim()||item.name.length>60||typeof item.id!=='string'||item.id!=='preset-'+sha256(item.name).slice(0,16)||!item.settings||Object.keys(item.settings).some(k=>!SUMMARY_API_PRESET_KEYS.includes(k))||typeof item.key!=='string'||item.key.length>16384||/[\r\n]/.test(item.key))throw Error('连接预设格式异常，未覆盖已有预设');
  const settings=validateProductPatch(item.settings);if(!settings.providerEndpoint||!settings.providerModel||item.key&&!credentialOrigin(settings.providerEndpoint))throw Error('请先填写预设的 API 地址和模型名称');
  return {...item,settings};
 };
 async function read(store){try{const found=store.tryGetJson?await store.tryGetJson(address):{found:true,value:await store.getJson(address)};if(!found?.found||found.value==null)return [];const doc=found.value;if(doc.version!==1||!Array.isArray(doc.items)||doc.items.length>30)throw Error('invalid');const items=doc.items.map(validate);if(new Set(items.map(x=>x.id)).size!==items.length)throw Error('invalid');return items;}catch(error){if(isMissingProductEntry(error))return [];throw Error('本机连接预设读取失败，未修改当前 API');}}
 return {
  async list(){return (await read(await getStore())).map(publicItem);},
  async get(id){const item=(await read(await getStore())).find(x=>x.id===id);if(!item)throw Error('所选连接预设不存在，请重新选择');return clone(item);},
  async save(name,settings,key){
   name=String(name??'').trim();const item=validate({id:'preset-'+sha256(name).slice(0,16),name,settings:{...defaults,...settings},key});
   const store=await getStore();return memoStorageLock(store,'memo-settings-v1',async()=>{const items=await read(store),index=items.findIndex(x=>x.id===item.id);if(index<0){if(items.length>=30)throw Error('最多保存30个连接预设，可用已有名称覆盖保存');items.push(item);}else items[index]=item;await verifiedWrite(store,address,{version:1,items});return publicItem(item);});
  }
 };
}
