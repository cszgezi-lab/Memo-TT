import {esc} from '../src/product-settings-ui.js';
export function mountSummaryApiPresets({panel,app,run,readPatch,onLoaded=()=>{}}){
 const root=panel.querySelector('[data-summary-api-presets]');if(!root)return;
 const select=root.querySelector('[data-api-preset-select]'),name=root.querySelector('[data-api-preset-name]'),save=root.querySelector('[data-api-preset-save]'),load=root.querySelector('[data-api-preset-load]'),status=root.querySelector('[data-api-preset-status]');
 let items=[],busy=false;
 async function refresh(id=select.value){items=await app.listSummaryApiPresets();select.innerHTML='<option value="">选择已保存的连接预设</option>'+items.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+' · '+esc(x.model)+'</option>').join('');select.value=items.some(x=>x.id===id)?id:'';load.disabled=!select.value||busy;}
 const action=async fn=>{if(busy)return;busy=true;save.disabled=true;load.disabled=true;select.disabled=true;try{await fn();}finally{busy=false;save.disabled=false;select.disabled=false;load.disabled=!select.value;}};
 save.addEventListener('click',()=>void run(()=>action(async()=>{const key=panel.querySelector('[data-key="summary"]').value;const result=await app.saveSummaryApiPreset(name.value,readPatch(),key?{keyValue:key}:{});await refresh(result.id);status.textContent='连接预设已保存：'+result.name+'。同名保存会更新该预设。';}),{name:'save-api-preset',button:save}));
 select.addEventListener('change',()=>{const item=items.find(x=>x.id===select.value);if(item)name.value=item.name;load.disabled=!item||busy;});
 load.addEventListener('click',()=>void run(()=>action(async()=>{const result=await app.loadSummaryApiPreset(select.value);onLoaded(result.settings);status.textContent=result.message+'，后续总结使用此连接。';}),{name:'load-api-preset',button:load}));
 void refresh().catch(()=>{status.textContent='连接预设读取失败，当前 API 保持不变。';});
 return {refresh};
}
