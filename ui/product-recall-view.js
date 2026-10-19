import { readViewState } from '../src/product-view-scheduling.js';
import { esc,button,settingsSection } from '../src/product-settings-ui.js';
import { dictionaryHTML } from './product-management.js';
import { dictionaryQuery } from '../src/product-dictionary.js';
import { injectionLogHTML, mountInjectionLog } from './product-injection-log.js';
import { CATEGORY_LABELS, recordDescription } from '../src/product-memory.js';
import { recordTitle } from '../src/product-narrative.js';
import {failureText} from '../src/product-feedback.js';

const tabs=[['recall','概览'],['dictionary','字典'],['vectors','向量'],['retrieval','策略'],['injection','注入'],['current','本轮']];
export const RECALL_PAGES=tabs.map(([page])=>page);
export function recallSectionsHTML(){return `
  <section data-view="recall" class="memo-page-template" hidden><header class="memo-template-heading"><div><h3>召回</h3></div><span class="memo-template-badge" hidden data-recall-template-state>尚无记录</span></header><div class="memo-template-stats"><div><span>选中记忆</span><strong data-recall-template-count>—</strong></div><div><span>召回耗时</span><strong data-recall-template-time>—</strong></div></div><details class="memo-person-category memo-current-recall" data-current-recall><summary><span>本次召回内容</span></summary><div class="memo-person-category-body" data-current-recall-body></div></details><details class="memo-person-category memo-recall-module" data-recall-module="dictionary"><summary><span>字典</span><small>名称、别称与标签</small></summary><div class="memo-person-category-body" data-recall-module-body="dictionary"></div></details><details class="memo-person-category memo-recall-module" data-recall-module="vectors"><summary><span>向量</span><small>向量召回与重排</small></summary><div class="memo-person-category-body" data-recall-module-body="vectors"></div></details><details class="memo-person-category memo-recall-module" data-recall-module="retrieval"><summary><span>策略</span><small>候选、分类与筛选</small></summary><div class="memo-person-category-body" data-recall-module-body="retrieval"></div></details><details class="memo-person-category memo-recall-module" data-recall-module="injection"><summary><span>注入</span><small>带入内容、位置与预算</small></summary><div class="memo-person-category-body" data-recall-module-body="injection"></div></details><div data-recall-overview hidden></div></section>
  <section data-view="dictionary" hidden><h3 hidden>字典与标签</h3><details hidden class="memo-card memo-option-group"><summary>试试一句话会命中什么</summary><input data-dictionary-query aria-label="字典匹配测试" placeholder="输入人物别称或剧情关键词"><div data-dictionary-match class="memo-help" role="status"></div><p class="memo-help">本地匹配，不调用 API；命中人物不代表该人物在场或知情。</p></details>${dictionaryHTML()}<details hidden class="memo-card memo-option-group"><summary>字典设置与高级文本</summary>${settingsSection('dictionary')}${button('save-settings','保存字典设置',true)}</details></section>
  <section data-view="vectors" hidden><h3 hidden>向量索引</h3><div data-recall-switches></div><div data-vector-overview></div><div class="memo-recall-setting-buttons"><button type="button" data-recall-settings="embedding" aria-expanded="false">向量设置</button><button type="button" data-recall-settings="rerank" aria-expanded="false">重排设置</button></div><div data-recall-settings-slot="embedding" class="memo-recall-settings-slot" hidden><h4>向量设置</h4><div data-recall-api-slot="embedding"></div><div data-recall-parameters="embedding"></div><button type="button" data-recall-save="embedding">保存向量参数</button></div><div data-recall-settings-slot="rerank" class="memo-recall-settings-slot" hidden><h4>重排设置</h4><div data-recall-api-slot="rerank"></div><div data-recall-parameters="rerank"></div><button type="button" data-recall-save="rerank">保存重排参数</button></div><div hidden data-vector-switch-source>${settingsSection('vectors')}</div></section>`;}

const recallModuleOrder=Object.keys(CATEGORY_LABELS);
/** Read-only record presentation: stable module order, original recall rank within each module. */
export function recallContentHTML(actual){
 const cards=Array.isArray(actual?.cards)?actual.cards:[];
 if(!cards.length)return actual?.text?'<section class="memo-recalled-group" data-recalled-group="other"><h4>其他</h4><div class="memo-recalled-body">'+esc(actual.text)+'</div></section>':'<p class="memo-empty">暂无召回内容</p>';
 const groups=new Map();
 for(const [rank,card]of cards.entries()){const key=recallModuleOrder.includes(card.category)?card.category:'other';if(!groups.has(key))groups.set(key,[]);groups.get(key).push({card,rank});}
 return [...recallModuleOrder,'other'].filter(key=>groups.has(key)).map(key=>'<section class="memo-recalled-group" data-recalled-group="'+key+'"><h4>'+esc(CATEGORY_LABELS[key]??'其他')+'<small>'+groups.get(key).length+'</small></h4><ol>'+groups.get(key).map(({card,rank},index)=>{const title=recordTitle(card),body=recordDescription(card);return '<li data-recalled-rank="'+rank+'"><span class="memo-recalled-number">'+String(index+1).padStart(2,'0')+'</span><div><h5>'+esc(title)+'</h5>'+(body!==title?'<div class="memo-recalled-body">'+esc(body)+'</div>':'')+'</div></li>';}).join('')+'</ol></section>').join('');
}
const stageLabel=status=>({passed:'已完成',disabled:'未执行',fallback:'回退本地结果',skipped:'已跳过',pending:'处理中'})[status]??'尚无记录';
const metricCount=stage=>Number.isInteger(stage?.count)?stage.count+' 条':'—';
const metricTime=(trace,key)=>trace?.[key]?.status&&trace[key].status!=='disabled'&&Number.isFinite(trace?.timings?.[key+'Ms'])?Math.round(trace.timings[key+'Ms'])+' ms':'—';
const indexLabels={no_chat:'请先打开聊天',not_checked:'待检查',unavailable:'暂不可用',empty:'没有可索引的记忆',pending:'待补建',ready:'索引完整',updating:'后台更新中',error:'更新未完成',stopped:'已停止',mixed:'向量维度不一致'};
export function mountRecallView({panel,app,run,setPage,download,host=globalThis}){
  const $=s=>panel.querySelector?.(s);
  $('[data-view="current"]').insertAdjacentHTML('beforeend',injectionLogHTML());
  const injectionView=mountInjectionLog({panel,app,run,host,download});
  for(const page of RECALL_PAGES){const section=$(`[data-view="${page}"]`);if(!section)continue;const nav=panel.ownerDocument.createElement('nav');nav.className='memo-subnav';nav.setAttribute('aria-label','召回导航');nav.innerHTML=tabs.map(([id,label])=>`<button type="button" data-recall-page="${id}" ${id===page?'class="active" aria-current="page"':''}>${label}</button>`).join('');section.prepend(nav);for(const b of nav.querySelectorAll('button'))b.addEventListener('click',()=>setPage(b.dataset.recallPage));}
  for(const b of panel.querySelectorAll('[data-recall-jump]'))b.addEventListener('click',()=>setPage(b.dataset.recallJump));
  $('[data-vector-rebuild]')?.addEventListener('click',event=>void run(async()=>{if(await host.confirm?.('重建当前聊天全部向量索引？会调用已配置的向量 API，记忆正文保留。'))await app.buildVectors({rebuild:true});},{name:'vectors',button:event.currentTarget}));
  let rowVersion=0,rowPage=1,indexStamp='',lastState=null;
  const currentRecall=$('[data-current-recall]');
  function paintCurrentRecall(){if(currentRecall.open)$('[data-current-recall-body]').innerHTML=recallContentHTML(lastState?.actual);else $('[data-current-recall-body]').replaceChildren();}
  currentRecall.addEventListener('toggle',paintCurrentRecall);
  function match(){const query=$('[data-dictionary-query]')?.value??'',dict=readViewState(app).dictionary??{};if(!$('[data-dictionary-match]'))return;const found=dictionaryQuery(query,dict);$('[data-dictionary-match]').textContent=query?[...found.terms.map(t=>`${t.matched.join('、')} → ${t.name}`),...found.ambiguities.map(a=>`${a.name} 有歧义：${a.owners.join('、')}`),found.tags.length?`标签：${found.tags.join('、')}`:''].filter(Boolean).join('\n')||'没有命中词条；仍可通过普通关键词或向量检索。':'输入后立即查看匹配结果。';}
  $('[data-dictionary-query]')?.addEventListener('input',match);
  function paint(s){
    lastState=s;
    if(!$('[data-view="current"]').hidden)injectionView.paint(s);
    if(!$('[data-view="dictionary"]').hidden&&$('[data-recall-manager]')?.open&&$('[data-recall-module="dictionary"]')?.open)match();
    const overview=!$('[data-view="recall"]').hidden;if(!overview)return;
    const metric=(label,value)=>'<div><span>'+label+'</span><strong>'+esc(value)+'</strong></div>';
    for(const kind of ['embedding','rerank']){const slot=$('[data-recall-settings-slot="'+kind+'"]');if(!slot||slot.hidden)continue;const trace=s.actual?.trace;const count=kind==='embedding'?metricCount(trace?.vector):Array.isArray(trace?.rerank?.scores)?trace.rerank.scores.length+' 条':'—';slot.querySelector('[data-recall-stage-metrics]').innerHTML=metric('本次条数',count)+metric('响应时间',metricTime(trace,kind==='embedding'?'vector':'rerank'));}
    if(overview){
      const actual=s.actual,cards=Array.isArray(actual?.cards)?actual.cards:[],duration=actual?.trace?.timings?.recallMs;
      $('[data-recall-template-state]').textContent=actual?'已准备':'尚无记录';$('[data-recall-template-count]').textContent=actual?cards.length+' 条':'—';$('[data-recall-template-time]').textContent=actual&&Number.isFinite(duration)?Math.round(duration)+' ms':'—';
      paintCurrentRecall();
    }
  }
  return {paint};
}
