import { readViewState } from '../src/product-view-scheduling.js';
import { esc,field } from '../src/product-settings-ui.js';
import { CATEGORY_LABELS,recordDescription,readable,renderMemoryCard,memoryCards } from '../src/product-memory.js';
import { MEMORY_CATEGORIES,pageSummaryBatches } from '../src/product-batches.js';
import { hasNewerSavedCoverage } from '../src/product-auto-summary.js';
import { parseModuleField } from '../src/product-custom-modules.js';

// Display-only forecast: reserve persisted tasks verbatim, then partition only
// the remaining intervals. Opening the list never persists or dispatches work.
export function plannedBatchPreview(rows=[],{startFloor=1,lastIndex=null,batchSize=20,keepRecent=5}={}){
  if(!Number.isSafeInteger(lastIndex)||!Number.isSafeInteger(startFloor)||startFloor<0||!Number.isSafeInteger(batchSize)||batchSize<1||!Number.isSafeInteger(keepRecent)||keepRecent<0)return {known:false,items:[],waiting:[],retained:null};
  const end=lastIndex-keepRecent,items=[],waiting=[];
  const reserved=rows.filter(r=>r.status!=='deleted'&&Number.isSafeInteger(r.startIndex)&&Number.isSafeInteger(r.endIndex)&&r.endIndex>=r.startIndex).map(r=>({start:Math.max(startFloor,r.startIndex),end:Math.min(end,r.endIndex)})).filter(r=>r.start<=r.end).sort((a,b)=>a.start-b.start||a.end-b.end);
  const gaps=[];let cursor=startFloor;
  for(const row of reserved){if(row.start>cursor)gaps.push({start:cursor,end:row.start-1,bounded:true});cursor=Math.max(cursor,row.end+1);}
  if(cursor<=end)gaps.push({start:cursor,end,bounded:false});
  for(const gap of gaps){let next=gap.start;while(next+batchSize-1<=gap.end){items.push({startIndex:next,endIndex:next+batchSize-1});next+=batchSize;}if(next<=gap.end)(gap.bounded?items:waiting).push({startIndex:next,endIndex:gap.end});}
  return {known:true,items,waiting,retained:keepRecent&&lastIndex>=startFloor?{startIndex:Math.max(startFloor,end+1),endIndex:lastIndex}:null,batchSize,keepRecent};
}
export function paintPlannedBatchPreview(node,state,kind='memory'){
  if(!node)return;
  const persona=state.dynamicPersona??{},settings=state.settings??{},isPersona=kind==='persona';
  const formal=isPersona?persona.batches??[]:state.batches??[];
  const candidate=isPersona&&['running','paused','failed'].includes(persona.manualPlan?.status)?persona.manualPlan.items??[]:[];
  const forecast=plannedBatchPreview([...formal,...candidate],{startFloor:(isPersona?persona.startFloor:state.autoStartFloor)??1,lastIndex:isPersona?persona.lastIndex:state.autoLastIndex,batchSize:(isPersona?settings.dynamicPersonaEvery:settings.autoSummaryEvery)??20,keepRecent:(isPersona?settings.dynamicPersonaKeepRecent:settings.autoKeepRecent)??0});
  // Main summaries show durable tasks only. Future source ranges belong to
  // the next-batch indicator, not undeletable cards in the management list.
  if(!isPersona){forecast.items=[];forecast.waiting=[];}
  const count=node.closest?.('[data-summary-memory-batches],[data-summary-persona-batches]')?.querySelector('[data-summary-batch-count],[data-persona-batch-count]');
  if(count&&forecast.known){const active=formal.filter(r=>r.status!=='deleted'),pending=forecast.items.length+[...active,...candidate].filter(r=>['queued','pending','running','failed','interrupted','staged'].includes(r.status)).length,unapplied=candidate.filter(r=>r.status==='saved').length;count.textContent=[`${active.length+candidate.length+forecast.items.length} 批`,pending?`${pending} 批待处理`:null,unapplied?`${unapplied} 批候选待应用`:null].filter(Boolean).join(' · ');}
  const stamp=JSON.stringify([forecast,formal.map(r=>[r.startIndex,r.endIndex,r.status]),candidate.map(r=>[r.startIndex,r.endIndex,r.status])]);if(node.dataset.forecastStamp===stamp)return;node.dataset.forecastStamp=stamp;
  if(!isPersona){node.innerHTML='';return;}
  const label=r=>`${r.startIndex}–${r.endIndex} 楼`;
  node.innerHTML=!forecast.known?'':`<header class="memo-forecast-heading"><b>待处理 ${forecast.items.length} 批</b><span>每批 ${forecast.batchSize} 楼 · 保留 ${forecast.keepRecent} 楼</span></header><div class="memo-forecast-grid">${forecast.items.map((r,i)=>`<details class="memo-compact-batch" data-planned-range="${r.startIndex}-${r.endIndex}" data-compact-start="${r.startIndex}"><summary aria-label="${label(r)} · 待处理"><span data-compact-number>${String(i+1).padStart(2,'0')}</span><span class="memo-compact-dot" data-state="planned" title="待处理"></span></summary><div class="memo-compact-detail"><b>${label(r)}</b><p>待处理</p></div></details>`).join('')}</div>${forecast.waiting.length?`<p class="memo-help">已累计 ${forecast.waiting.at(-1).endIndex-forecast.waiting.at(-1).startIndex+1}/${forecast.batchSize} 楼</p>`:''}`;
}

export function batchManagementHTML(){return `<details class="memo-compact-management"><summary>管理</summary><p data-batch-plan class="memo-help"></p>
  <div class="memo-batch-filters">${field('查找批次','<input data-batch-search placeholder="楼层、批号或侧重点">')}${field('状态','<select data-batch-status><option value="active">当前批次</option><option value="saved">已完成</option><option value="failed">失败 / 中断</option><option value="pending">待处理 / 待应用</option><option value="deleted">已删除 / 可恢复</option></select>')}</div>
  <div class="memo-top memo-batch-browse"><p data-batch-total class="memo-help" role="status"></p><button type="button" data-batch-select-toggle aria-pressed="false" aria-expanded="false">多选</button></div>
  <div class="memo-batch-selection-toolbar" data-batch-selection-toolbar role="group" aria-label="所选总结批次操作" hidden><p data-selected-count class="memo-help" role="status" aria-live="polite"></p><details class="memo-batch-more memo-context-more" data-batch-selection-more><summary>更多</summary><div class="memo-context-actions"><button type="button" data-batch-details>查看详情</button><button type="button" data-bulk="retry">重试所选</button><button type="button" data-bulk="delete">删除所选</button><button type="button" data-bulk="restore" hidden>恢复所选</button><button type="button" data-bulk="regenerate">重新生成</button><button type="button" data-batch-split-selected>拆小所选</button><button type="button" data-batch-apply-prefix>应用已完成部分</button><button type="button" data-select-page>选择本页</button><button type="button" data-select-filter>选择全部筛选结果</button><button type="button" data-clear-selection>清空选择</button></div></details></div>
  <div class="memo-card" data-batch-selection-detail hidden></div><div data-batches></div><div class="memo-batch-pagination" data-batch-pagination><button type="button" data-batch-prev>上一页</button><span data-batch-page></span><button type="button" data-batch-next>下一页</button></div>
  <details class="memo-batch-options"><summary>显示与索引维护</summary>${field('每页','<select data-batch-size-list><option>10</option><option>20</option><option selected>50</option></select>')}<label class="memo-field memo-page-jump"><span>跳到第几页</span><input type="number" min="1" data-batch-jump value="1"><button type="button" data-batch-go>跳转</button></label><details class="memo-advanced" data-vector-maintenance><summary>补建未完成索引</summary><p class="memo-help">只补索引，不重做总结。</p><button type="button" data-retry-batch-vectors-all>立即补建全部未完成索引</button></details></details></details>`;}
const statusNames={queued:'待处理',running:'处理中',saved:'已保存',failed:'失败，可重试',interrupted:'中断，可重试',deleted:'已删除'};
export const batchStateText=b=>b.status==='saved'&&b.partialSummary?.missingFloors?.length?'部分已保存':statusNames[b.status]??esc(b.status);
const partialSummaryHTML=b=>!b.partialSummary?.missingFloors?.length?'':`<p class="memo-batch-error" data-partial-summary>已保存 ${b.partialSummary.savedFloors.length}/${b.partialSummary.savedFloors.length+b.partialSummary.missingFloors.length} 楼摘要及有效明细。未保存楼层：${b.partialSummary.missingFloors.join('、')}。可在手动更新中选择这些楼层补建；本次未自动追加模型请求。</p>`;
export function batchVectorStatusText(v){return !v?'索引待检查':v.mixed?'索引维度不一致，请在召回页重建':!v.total?'无可索引记录':!v.pending?`索引完成 ${v.indexed}/${v.total}`:`索引${v.status==='updating'?'建立中':v.status==='error'?'未完成':'待补建'} ${v.indexed}/${v.total}，待建 ${v.pending}${v.failed?`（失败 ${v.failed}）`:''}`;}
export function batchRecordDescription(r,modules=[]){const tag=parseModuleField(r.field??r.key),m=modules.find(m=>m.id===tag?.moduleId),f=m?.fields.find(f=>f.id===tag?.fieldId);return f?`${m.name} · ${r.entity??m.subject} · ${f.label}：${readable(r.to??r.value??r.newValue)}`:recordDescription(r);}
export function mountBatchList({panel,app,run,host}){
  const $=s=>panel.querySelector?.(s);let currentPage=1,lastPaint='',lastScope='',batchRevision=null,batchSnapshot=[],jumpDirty=false,selecting=false;const selected=new Set();
  const pageOptions=()=>({query:$('[data-batch-search]').value,status:$('[data-batch-status]').value,page:currentPage,pageSize:Number($('[data-batch-size-list]').value)});
  function selectionState(s){
    const rows=(s.batches??[]).filter(b=>selected.has(b.id)),single=rows.length===1?rows[0]:null;
    $('[data-batch-selection-toolbar]').hidden=!selecting||!rows.length;
    if(!rows.length)$('[data-batch-selection-more]').open=false;
    const toggle=$('[data-batch-select-toggle]');toggle.textContent=selecting?'取消多选':'多选删除';toggle.setAttribute('aria-pressed',String(selecting));toggle.setAttribute('aria-expanded',String(selecting));
    for(const label of panel.querySelectorAll('[data-batch-check]'))label.hidden=!selecting;
    for(const button of panel.querySelectorAll('[data-retry-batch-vectors-all]'))button.disabled=s.busy;
    $('[data-selected-count]').textContent=`已选 ${selected.size} 批（跨页保留）${rows.some(b=>b.replacement&&!b.savedOperationId)?'；成功候选尚未应用，可在此应用连续已完成前段。':''}`;
    for(const button of panel.querySelectorAll('[data-bulk]'))button.disabled=s.busy||!selected.size;
    $('[data-batch-details]').disabled=selected.size!==1;
    $('[data-batch-split-selected]').disabled=s.busy||!rows.length||rows.some(b=>!['queued','failed','interrupted'].includes(b.status)||b.replacementReady||b.endIndex<=b.startIndex);
    $('[data-batch-apply-prefix]').disabled=s.busy||!single?.replacement||Boolean(single.savedOperationId)||single.status==='deleted';
    for(const button of panel.querySelectorAll('[data-select-page],[data-select-filter]'))button.disabled=false;
    if(selected.size!==1)$('[data-batch-selection-detail]').hidden=true;
  }
  $('[data-batch-select-toggle]')?.addEventListener('click',()=>{selecting=!selecting;if(!selecting)selected.clear();paint(readViewState(app));});
  $('[data-retry-incomplete]')?.addEventListener('click',event=>run(()=>app.retryIncompleteBatches(),{name:'focus-summary',button:event.currentTarget}));
  $('[data-retry-batch-vectors-all]')?.addEventListener('click',event=>run(()=>app.retryVectors(),{name:'vectors',button:event.currentTarget}));
  $('[data-select-page]')?.addEventListener('click',()=>{for(const b of pageSummaryBatches(readViewState(app).batches,pageOptions()).items)selected.add(b.id);paint(readViewState(app));});
  $('[data-select-filter]')?.addEventListener('click',()=>{const options={...pageOptions(),pageSize:50};const first=pageSummaryBatches(readViewState(app).batches,options);for(let page=1;page<=first.pages;page++)for(const b of pageSummaryBatches(readViewState(app).batches,{...options,page}).items)selected.add(b.id);paint(readViewState(app));});
  $('[data-clear-selection]')?.addEventListener('click',()=>{selected.clear();paint(readViewState(app));});
  $('[data-batch-details]')?.addEventListener('click',()=>{const s=readViewState(app),id=[...selected][0],b=s.batches.find(b=>b.id===id),node=$('[data-batch-selection-detail]');if(!b||!node)return;node.innerHTML=`<b>批次 · ${b.startIndex}–${b.endIndex} 楼</b><p class="memo-help">${b.replacementReady&&b.replacement&&!['saved','deleted'].includes(b.status)?'已生成，待应用':batchStateText(b)}</p><div data-batch-body></div>`;fill(node,b,s);node.hidden=false;node.scrollIntoView?.({block:'nearest'});});
  for(const button of panel.querySelectorAll('[data-bulk]'))button.addEventListener('click',()=>run(async()=>{const ids=[...selected],action=button.dataset.bulk,label={retry:'重试',regenerate:'重新生成',delete:'删除',restore:'恢复'}[action],scope=JSON.stringify(readViewState(app).core?.scope);if(!await host.confirm?.(`${label}所选 ${ids.length} 批？${action==='delete'?'仅删除所选批次，未应用候选不会改变旧正式记忆。可在设置中的回收站恢复，聊天原文不变。':action==='regenerate'?'将按楼层顺序调用总结模型，新结果成功后替换旧结果。':'只处理所选批次，已成功结果保留。'}`))return;checkScope(scope);await app.manageBatches(ids,action);selected.clear();paint(readViewState(app));},{name:button.dataset.bulk==='regenerate'?'focus-summary':'batch-management',button}));
  const checkScope=scope=>{if(JSON.stringify(readViewState(app).core?.scope)!==scope)throw new Error('聊天已切换，请重新选择批次');};
  $('[data-batch-split-selected]')?.addEventListener('click',event=>run(async()=>{
    const s=readViewState(app),scope=JSON.stringify(s.core?.scope),rows=s.batches.filter(b=>selected.has(b.id));
    if(!rows.length||rows.some(b=>!['queued','failed','interrupted'].includes(b.status)||b.replacementReady||b.endIndex<=b.startIndex))throw new Error('请选择可拆分的未完成批次');
    if(!await host.confirm?.(`拆小所选 ${rows.length} 批？每批楼数减半，仅调整待处理任务，不调用模型；已有成功结果保留。`))return;
    checkScope(scope);for(const b of rows){checkScope(scope);await app.splitSummaryBatch(b.id,{batchSize:Math.min(200,Math.ceil((b.endIndex-b.startIndex+1)/2))});}selected.clear();paint(readViewState(app));
  },{name:'batch-management',button:event.currentTarget}));
  $('[data-batch-apply-prefix]')?.addEventListener('click',event=>run(async()=>{
    const scope=JSON.stringify(readViewState(app).core?.scope),id=[...selected][0];if(selected.size!==1)throw new Error('请单选本次覆盖计划的一批');
    const preview=await app.previewApplySummaryPrefix(id);checkScope(scope);
    const tail=preview.discardedTail?`旧 ${preview.discardedTail.startIndex}–${preview.discardedTail.endIndex} 楼总结将撤下归档。`:'';
    if(!await host.confirm?.(`应用已完成的 ${preview.startIndex}–${preview.endIndex} 楼（${preview.readyBatches} 批）？${tail}本计划剩余 ${preview.pendingBatches} 批取消并归档，自动接续暂停；不调用模型，聊天原文保留。`))return;
    checkScope(scope);await app.applySummaryPrefix(id,{previewHash:preview.previewHash});selected.clear();paint(readViewState(app));
  },{name:'batch-management',button:event.currentTarget}));
  $('[data-batch-jump]')?.addEventListener('input',()=>{jumpDirty=true;});
  function move(page){jumpDirty=false;currentPage=page;paint(readViewState(app));$('[data-batch-total]').scrollIntoView({block:'nearest'});}
  $('[data-batch-prev]')?.addEventListener('click',()=>move(currentPage-1));$('[data-batch-next]')?.addEventListener('click',()=>move(currentPage+1));$('[data-batch-go]')?.addEventListener('click',()=>move(Number($('[data-batch-jump]').value)));
  for(const name of ['data-batch-search','data-batch-status','data-batch-size-list'])$(`[${name}]`)?.addEventListener(name==='data-batch-search'?'input':'change',()=>{currentPage=1;selected.clear();paint(readViewState(app));});
  for(const [selector,status]of [['[data-batch-current]','active'],['[data-batch-recycle]','deleted']])$(selector)?.addEventListener('click',()=>{currentPage=1;selected.clear();$('[data-batch-search]').value='';$('[data-batch-status]').value=status;paint(readViewState(app));});
  function fill(node,b,s){
    const capturedScope=JSON.stringify(s.core?.scope);
    const linked=new Map(memoryCards(b.records??{},{includeAwareness:true}).map(c=>[c.id,c])),deleted=b.status==='deleted',busy=Boolean(s.busy),disable=busy?' disabled':'';
    const retry=['queued','failed','interrupted'].includes(b.status),content=MEMORY_CATEGORIES.filter(key=>(b.records?.[key]?.length??b.counts?.[key]??0)>0);
    const body=node.querySelector('[data-batch-body]');body.innerHTML=`<b class="memo-compact-range">${Number.isInteger(b.startIndex)?`${b.startIndex}–${b.endIndex} 楼`:'旧版未保存楼层号'}</b><p class="memo-help">${b.replacementReady&&b.replacement&&!b.savedOperationId?'已生成，待应用':batchStateText(b)}</p>${partialSummaryHTML(b)}${b.error?`<p class="memo-batch-error">${esc(b.error)}</p>`:''}<p class="memo-help">${b.previousOperation&&b.status!=='saved'?'上次成功结果仍保留。':''}${Number.isInteger(b.requests)?`最近一次处理：${b.requests} 次模型请求。`:''}</p><div class="memo-actions memo-batch-direct-actions">${deleted?`<button type="button" data-restore-batch${disable}>恢复本批</button>`:`${retry?`<button type="button" data-retry-batch${disable}>重试本批</button>`:''}<button type="button" data-regenerate-batch${disable}>重新生成</button><button type="button" data-delete-batch${disable}>删除本批</button>`}</div><p class="memo-help">${esc(batchVectorStatusText(s.batchVectors?.[b.id]))}</p>${!deleted&&s.batchVectors?.[b.id]?.pending?`<button type="button" data-retry-batch-vectors${disable}>补建本批索引</button>`:''}${content.map(key=>`<details><summary>${CATEGORY_LABELS[key]} · ${b.counts?.[key]??b.records?.[key]?.length??0} 条</summary>${(b.records?.[key]??[]).map(r=>`<p>${Number.isInteger(r.floorIndex)?`${r.floorIndex} 楼 · `:''}${esc(batchRecordDescription(r,s.modules))}</p>${r.keyDialogues?.length||r.viewpoints?.length?`<div class="memo-packet memo-help">${esc(renderMemoryCard(linked.get(r.id)??r,s.settings,{metadataOnly:true,detail:true}))}</div>`:''}`).join('')||'<p class="memo-help">本批未生成此类记录。</p>'}</details>`).join('')||'<p class="memo-help">本批还没有已保存内容。</p>'}`;
    body.querySelector('[data-retry-batch]')?.addEventListener('click',event=>run(()=>app.retryBatch(b.id),{name:'focus-summary',button:event.currentTarget}));
    body.querySelector('[data-retry-batch-vectors]')?.addEventListener('click',event=>run(()=>app.retryBatchVectors(b.id),{name:'vectors',button:event.currentTarget}));
    body.querySelector('[data-regenerate-batch]')?.addEventListener('click',event=>run(()=>app.regenerateBatch(b.id),{name:'focus-summary',button:event.currentTarget}));
    body.querySelector('[data-delete-batch]')?.addEventListener('click',()=>run(async()=>{if(!await host.confirm?.(b.replacement&&!b.savedOperationId?'删除该批候选？仅移除本批，旧正式记忆和其它候选保留；可在设置中的回收站恢复。':'删除该批生成的记忆？聊天原文不变，可恢复或重生。'))return;checkScope(capturedScope);await app.deleteBatch(b.id);}));
    body.querySelector('[data-restore-batch]')?.addEventListener('click',()=>run(()=>app.restoreBatch(b.id)));
  }
  function paint(view){
    if(view.batchRevision===undefined||view.batchRevision!==batchRevision){batchRevision=view.batchRevision;batchSnapshot=view.batches??[];}
    const s=Object.create(view);Object.defineProperty(s,'batches',{value:batchSnapshot});
    const scope=JSON.stringify(s.core?.scope);if(scope!==lastScope){lastScope=scope;currentPage=1;lastPaint='';selected.clear();selecting=false;$('[data-batch-selection-detail]').hidden=true;if($('[data-batch-search]'))$('[data-batch-search]').value='';if($('[data-batch-status]'))$('[data-batch-status]').value='active';}
    const p=pageSummaryBatches(s.batches??[],{query:$('[data-batch-search]')?.value??'',status:$('[data-batch-status]')?.value??'active',page:currentPage,pageSize:Number($('[data-batch-size-list]')?.value??20)});if($('[data-batches]').dataset.unifiedAll==='true'){const options={query:$('[data-batch-search]')?.value??'',status:$('[data-batch-status]')?.value??'active',pageSize:50};const first=pageSummaryBatches(s.batches??[],options);p.items=Array.from({length:first.pages},(_,i)=>pageSummaryBatches(s.batches??[],{...options,page:i+1}).items).flat();p.page=1;p.pages=1;}currentPage=p.page;
    $('[data-batch-pagination]').hidden=p.pages<=1;
    for(const id of selected)if(!s.batches.some(b=>b.id===id))selected.delete(id);selectionState(s);
    const recycled=$('[data-batch-status]')?.value==='deleted';if($('[data-batch-recycle]'))$('[data-batch-recycle]').textContent=`回收站（${p.deletedTotal}）`;
    const pending=(s.batches??[]).filter(b=>['queued','running','failed','interrupted'].includes(b.status)),latest=[...(s.batches??[])].sort((a,b)=>(b.updatedAt??b.createdAt??0)-(a.updatedAt??a.createdAt??0)).find(b=>b.plan)?.plan;
    if($('[data-batch-plan]'))$('[data-batch-plan]').textContent=`未完成或待应用总结 ${pending.length} 批${latest?`；最近计划 ${latest.startIndex}–${latest.endIndex} 楼，每 ${latest.batchSize} 楼一批`:''}。`;
    for(const button of panel.querySelectorAll('[data-bulk]'))button.hidden=recycled?button.dataset.bulk!=='restore':button.dataset.bulk==='restore';
    const signature=JSON.stringify([batchRevision??p,p.items.map(b=>b.id),p.page,p.total,s.busy,s.modules,p.items.map(b=>s.batchVectors?.[b.id]),selecting,[...selected]]);if(signature===lastPaint)return;lastPaint=signature;
    const opened=new Set([...panel.querySelectorAll('[data-batch-id][open]')].map(n=>n.dataset.batchId));
    $('[data-batch-total]').textContent=`当前 ${p.currentTotal} 批 · 回收站 ${p.deletedTotal} 批 · 筛选出 ${p.total} 批`;$('[data-batch-page]').textContent=`${p.page} / ${p.pages} 页`;$('[data-batch-jump]').max=String(p.pages);if(!jumpDirty)$('[data-batch-jump]').value=String(p.page);$('[data-batch-prev]').disabled=p.page===1;$('[data-batch-next]').disabled=p.page===p.pages;
    $('[data-batches]').innerHTML=p.items.map(b=>{const pendingApplication=Boolean(b.replacementReady&&b.replacement&&!['saved','deleted'].includes(b.status)),vector=s.batchVectors?.[b.id],indexAttention=b.status==='saved'&&(vector?.mixed||vector?.pending||vector?.status==='error');return `<details class="memo-card memo-batch-row" data-batch-id="${esc(b.id)}" data-compact-start="${b.startIndex}" ${opened.has(b.id)?'open':''}><summary><label class="memo-batch-check" data-batch-check ${selecting?'':'hidden'}><input type="checkbox" data-select-batch="${esc(b.id)}" aria-label="选择第 ${b.displayNumber} 批" ${selected.has(b.id)?'checked':''}><span class="memo-sr-only">选择第 ${b.displayNumber} 批</span></label><span class="memo-batch-title" data-compact-number aria-label="第 ${b.displayNumber} 批 · ${Number.isInteger(b.startIndex)?`${b.startIndex}–${b.endIndex} 楼`:'旧版未保存楼层号'}">${String(b.displayNumber).padStart(2,'0')}</span><span class="memo-batch-status" data-state="${esc(pendingApplication?'queued':b.partialSummary?.missingFloors?.length?'failed':b.status)}">${pendingApplication?'已生成，待应用':batchStateText(b)}${indexAttention?` · ${esc(batchVectorStatusText(vector))}`:''}</span></summary><div data-batch-body></div></details>`;}).join('')||'<p class="memo-empty">没有符合条件的批次。</p>';
    for(const label of panel.querySelectorAll('[data-batch-check]'))label.addEventListener('click',e=>e.stopPropagation());
    for(const input of panel.querySelectorAll('[data-select-batch]')){input.addEventListener('click',e=>e.stopPropagation());input.addEventListener('change',()=>{input.checked?selected.add(input.dataset.selectBatch):selected.delete(input.dataset.selectBatch);selectionState(readViewState(app));lastPaint='';});}
    for(const node of panel.querySelectorAll('[data-batch-id]')){const b=p.items.find(b=>b.id===node.dataset.batchId);if(node.open)fill(node,b,s);node.addEventListener('toggle',()=>{if(node.open&&!node.querySelector('[data-batch-body]').hasChildNodes())fill(node,b,readViewState(app));});}
  }
  function revealBatch(id){
    const s=readViewState(app),batch=(s.batches??[]).find(row=>row.id===id&&row.status!=='deleted');
    if(!batch)return null;
    paint(s); // Hydrate the current chat before setting its local browse state.
    $('[data-batch-search]').value='';$('[data-batch-status]').value='active';
    const options={...pageOptions(),query:'',status:'active',page:1},first=pageSummaryBatches(s.batches,options);
    currentPage=1;
    for(let page=1;page<=first.pages;page++)if(pageSummaryBatches(s.batches,{...options,page}).items.some(row=>row.id===id)){currentPage=page;break;}
    lastPaint='';paint(s);
    const node=[...panel.querySelectorAll('[data-batch-id]')].find(row=>row.dataset.batchId===id);
    if(node){node.open=true;fill(node,batch,s);}
    return node??null;
  }
  return {paint,revealBatch};
}
