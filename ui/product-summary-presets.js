import {defaultSummaryArmor,summaryArmorPreview} from '../src/summary-armor.js';
import { defaultSummaryPreset, readSummaryPresets, validateSummaryPreset, summaryPresetPreview, SUMMARY_MODULE_NAMES } from '../src/summary-presets.js';
import { clone } from '../src/utils.js';
import { esc } from '../src/product-settings-ui.js';

const groups=[
  ['shared','共同规则',['extractionWorkflow','narrativeRules.language','narrativeRules.facts','narrativeRules.completeness','timeRules','sceneTimeRules','temporalShape','stateTransitionRules','currentStateRules','detailRules']],
  ['events','事件',['narrativeRules.eventBody','narrativeRules.eventMetadata','narrativeRules.brief','consolidationRules']],
  ['awarenessChanges','知情',['knowledgeRules','evidenceBoundaryRules']],
  ['entityFactChanges','人物与事实',['profileRules','archiveRules']],
  ['relationshipChanges','关系',['relationshipEndpointRules','dialogueSourceRules']],
  ['personaChanges','人设变化',['interpretationRules','journalCoverageRules']],
  ['commitmentChanges','约定',['commitmentRules','planStateRules','schedulePrecisionRules','promiseBoundaryRules']],
  ['performanceHints','演绎参考',[]],
  ['summaryView','楼层摘要',['floorContentRules','floorMetadataRules','floorKnowledgeRules']],
  ['conflicts','冲突与疑点',[]],
];
const addedLabels={sceneTimeRules:'正文日期与场景时间',dialogueSourceRules:'关键台词的原文来源',evidenceBoundaryRules:'知情证据边界',promiseBoundaryRules:'承诺与预测的区别',journalCoverageRules:'角色心迹的依据与范围',currentStateRules:'关系与约定的当前状态'};
const labels={extractionWorkflow:'整理顺序','narrativeRules.language':'输出语言','narrativeRules.facts':'事实与推测','narrativeRules.completeness':'记录范围',timeRules:'时间与有效期',temporalShape:'时间填写方式',stateTransitionRules:'动态变化',detailRules:'字典、标签、关键台词与观念','narrativeRules.eventBody':'完整事件纪要','narrativeRules.eventMetadata':'人物、地点与时间','narrativeRules.brief':'召回速览',consolidationRules:'同一事件的合并',knowledgeRules:'具体知情与事件关联',profileRules:'动态属性填写',archiveRules:'主体归档',relationshipEndpointRules:'关系双方与互动',interpretationRules:'态度、演绎与疑点的共同边界',commitmentRules:'承诺与兑现',planStateRules:'计划状态',schedulePrecisionRules:'不同日程的时间',floorContentRules:'每楼经过',floorMetadataRules:'每楼人物与时间',floorKnowledgeRules:'楼层与知情关联'};
Object.assign(labels,addedLabels);
// Illustrative, not hidden instructions. IDs must be replaced with input IDs.
const examples={
  events:{id:'event-key',sourceRefs:[{sourceId:'来源编号'}],perspective:'third_person',title:'乙为避雨将钥匙交给丙保管',description:'6月4日18点，乙因临时去避雨，不方便继续携带工作室钥匙，在车站把钥匙交给丙，并约定雨停后取回。丙答应代管，将钥匙收进蓝色背包；甲在旁亲眼看见交接。原文没有写雨停后是否已归还。',recallSummary:'乙在车站把工作室钥匙交丙代管，约定雨停后取回；甲目睹交接，尚无归还记录。',participants:['乙','丙','甲'],location:'车站',temporal:{occurredAt:'2021-06-04 18:00'},state:'completed',epistemicStatus:'observed',tags:['钥匙交接','代为保管']},
  awarenessChanges:{sourceId:'来源编号',person:'甲',knowledge:'乙把工作室钥匙交给丙暂时保管，丙把它放进蓝色背包。甲不知道钥匙对应的是哪间工作室。',status:'known',via:'witnessed',learnedAt:'2021-06-04 18:00',eventRef:'event-key'},
  entityFactChanges:{sourceId:'来源编号',entity:'乙',field:'魔力等级',from:2,to:3,validFrom:'2021-06-04',epistemicStatus:'observed'},
  relationshipChanges:{sourceId:'来源编号',from:'乙',to:'丙',description:'乙愿意请丙代管钥匙，丙同意帮忙；这是一次明确的托付，不等于乙已把所有秘密告诉丙。',evidenceKind:'shared_experience',epistemicStatus:'observed'},
  personaChanges:{sourceId:'来源编号',subject:'乙',aspect:'求助态度',description:'乙此前不愿麻烦丙，这次开始愿意向丙请求具体帮助。',object:'丙',context:'临时托管钥匙',scope:'对丙的具体求助',expiresAt:null,epistemicStatus:'observed'},
  commitmentChanges:{sourceId:'来源编号',participants:['乙','丙'],content:'丙答应代管钥匙，等雨停后由乙取回。',state:'accepted',temporal:{plannedFor:'雨停后'},epistemicStatus:'observed'},
  performanceHints:{sourceId:'来源编号',subject:'乙',description:'乙求人帮忙前会先说明原因，并确认不会妨碍对方；以后求助可沿用这种表达习惯，不必复读原话。',context:'请求他人帮忙'},
  summaryView:{sourceId:'来源编号',text:'乙为临时避雨将工作室钥匙交给丙，丙同意代管并收进蓝色背包；甲看见交接，但不知道具体是哪间工作室。乙与丙约定雨停后取回，本楼没有发生归还。',participants:['乙','丙','甲'],location:'车站',temporal:{occurredAt:'2021-06-04 18:00'},eventRefs:['event-key']},
  conflicts:{sourceId:'来源编号',description:'甲以为钥匙已经归还，但丙明确表示仍放在蓝色背包里；甲的推测被否认，不能作为已归还的事实。'},
};
// Separate unknown propositions instead of combining a secret with known facts.
examples.relationshipChanges.keyDialogues=[{speaker:'乙',to:'丙',text:'等雨停了，我会回来取。',context:'托付钥匙时的约定；丙答应代管',meaning:'乙承诺回来取回，不是已经取回',status:'active'}];
examples.personaChanges.innerLife={stage:'开始愿意求助',text:'我开始愿意请丙帮忙，但这次托付不代表我愿意分享所有秘密。',cause:'丙明确答应代管钥匙',basis:'inferred',status:'current'};
examples.awarenessChanges.knowledge='乙把工作室钥匙交给丙暂时保管，丙把它放进蓝色背包。';

export function summaryPresetsHTML(){return `<div data-preset-root><p data-preset-active hidden role="status"></p><div class="memo-preset-toolbar"><label class="memo-field"><span>预设</span><select data-preset-select></select></label><div class="memo-actions"><button type="button" data-preset-action="copy">复制</button><button type="button" data-preset-action="rename" aria-expanded="false">重命名</button><button type="button" data-preset-action="delete">删除</button></div></div><div data-preset-editor></div><div class="memo-actions"><button type="button" data-preset-action="save">保存并启用</button><button type="button" data-preset-action="reset">恢复默认</button><button type="button" data-preset-action="revert">放弃修改</button><button type="button" data-preset-tab="transfer" aria-expanded="false">导入 / 导出</button><button type="button" data-preset-tab="preview" aria-expanded="false">发送预览</button></div><p data-preset-status role="status"></p><section data-preset-panel="transfer" hidden><input type="file" accept=".json,application/json" data-preset-file aria-label="导入预设 JSON"><div class="memo-actions"><button type="button" data-preset-action="import">导入</button><button type="button" data-preset-action="export">导出</button></div></section><section data-preset-panel="preview" hidden><button type="button" data-preset-action="preview">刷新预览</button><pre class="memo-packet" data-preset-preview></pre></section></div>`;}

export function mountSummaryPresets({panel,app,run,host,download}){
  const root=panel.querySelector?.('[data-preset-root]'),$=selector=>root?.querySelector?.(selector);
  if(!root)return {paint(){}};
  let library=readSummaryPresets(),selected='default',raw=null,dirty=false,drafts=new Map(),armorEdited=new Set();
  const status=text=>{$('[data-preset-status]').textContent=text;};
  function current({includeArmor=false}={}){
    const preset=clone(drafts.get(selected)??library.items.find(p=>p.id===selected));
    preset.name=$('[data-preset-name]').value;preset.instructions=$('[data-preset-instructions]').value;
    if(preset.armor||includeArmor||armorEdited.has(selected))preset.armor={...defaultSummaryArmor(),...Object.fromEntries([...root.querySelectorAll('[data-preset-armor-toggle]')].map(n=>[n.dataset.presetArmorToggle,n.getAttribute('aria-pressed')==='true'])),words:$('[data-preset-armor-words]').value};
    if(preset.armor&&(preset.armor.headerPadding||preset.armor.userPadding))preset.armor.paddingOptIn=true;
    for(const field of root.querySelectorAll('[data-preset-rule]'))preset.rules[field.dataset.presetRule]=field.value;
    return preset;
  }
  function draw(){
    const preset=drafts.get(selected)??library.items.find(p=>p.id===selected);
    $('[data-preset-select]').innerHTML=library.items.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}${p.id===library.activeId?' · 已启用':''}</option>`).join('');$('[data-preset-select]').value=selected;
    $('[data-preset-active]').textContent=`当前启用：${library.items.find(p=>p.id===library.activeId).name}`;
    const armor=summaryArmorPreview(preset.armor??defaultSummaryArmor({fillWords:true}));
    $('[data-preset-editor]').innerHTML=`<label class="memo-field" data-preset-rename hidden><span>新名称</span><input data-preset-name maxlength="80" value="${esc(preset.name)}"></label><div class="memo-preset-tabs" role="group" aria-label="预设内容"><button type="button" data-preset-tab="instructions" aria-expanded="false">总提示词</button><button type="button" data-preset-tab="armor" aria-expanded="false">破甲区</button>${groups.map(([key,title])=>`<button type="button" data-preset-tab="${key}" aria-expanded="false">${title}</button>`).join('')}</div><section data-preset-panel="instructions" hidden><h4 class="memo-preset-heading">总提示词</h4><textarea rows="9" aria-label="总提示词" data-preset-instructions maxlength="24000">${esc(preset.instructions)}</textarea></section>`+`<section class="memo-preset-armor" data-preset-panel="armor" hidden><h4 class="memo-preset-heading">破甲区</h4><div class="memo-actions memo-preset-switches">${[['antiTruncation','反截断'],['headerPadding','头部填充'],['userPadding','用户输入填充']].map(([key,label])=>`<button type="button" data-preset-armor-toggle="${key}" aria-pressed="${armor[key]}">${label}</button>`).join('')}</div><label class="memo-field"><span>破甲词</span><textarea rows="7" maxlength="16000" data-preset-armor-words>${esc(armor.words)}</textarea></label><p class="memo-help">与动态人设共用，保存后生效。两项长填充全开约增加2.2万字符/次。</p></section>`+groups.map(([key,title,fields])=>`<section data-preset-panel="${key}" hidden><h4 class="memo-preset-heading">${esc(title)}</h4>${[...fields,...(SUMMARY_MODULE_NAMES[key]?[`moduleNotes.${key}`]:[])].map(path=>`<label class="memo-field"><span>${esc(labels[path]??'本模块追加要求（可留空）')}</span><textarea rows="5" data-preset-rule="${path}" maxlength="16000">${esc(preset.rules[path])}</textarea></label>`).join('')}${examples[key]?`<button type="button" data-preset-example="${key}" aria-expanded="false">填写示例</button><pre class="memo-packet" data-preset-example-body="${key}" hidden>${esc(JSON.stringify(examples[key],null,2))}</pre>`:''}</section>`).join('');
    $('[data-preset-action="rename"]').setAttribute('aria-expanded','false');
    for(const n of root.querySelectorAll('[data-preset-panel]'))n.hidden=true;
    for(const n of root.querySelectorAll('[data-preset-tab]'))n.setAttribute('aria-expanded','false');
    $('[data-preset-preview]').textContent='点击刷新预览，查看当前编辑稿。';
  }
  function paint(state){
    const next=state.settings.summaryPresets??'';
    if(next===raw)return;
    if(dirty){status('检测到外部配置变化，编辑稿已保留；请先导出编辑稿或放弃修改后加载最新配置。');return;}
    library=readSummaryPresets(next);raw=next;drafts.clear();armorEdited.clear();if(!library.items.some(p=>p.id===selected))selected=library.activeId;draw();
  }
  root.addEventListener('input',event=>{if(event.target.closest('[data-preset-editor]')){if(event.target.matches('[data-preset-armor-words]'))armorEdited.add(selected);dirty=true;status('有未保存修改；尚未用于总结。');}});
  $('[data-preset-select]')?.addEventListener('change',()=>{drafts.set(selected,current());selected=$('[data-preset-select]').value;draw();});
  const freshId=()=>`preset-${globalThis.crypto.randomUUID()}`;
  async function persist(next){
    await app.loadApiSettings?.();
    const live=app.readViewState?.().settings??app.state.settings;
    if((live.summaryPresets??'')!==raw)throw new Error('预设已被其他设置操作修改；请先导出编辑稿，再放弃修改加载最新版本');
    const text=JSON.stringify(readSummaryPresets(JSON.stringify(next)));
    await app.saveSettings({summaryPresets:text});library=next;raw=text;dirty=false;drafts.clear();armorEdited.clear();draw();
  }
  const actions={
    rename:()=>{const field=$('[data-preset-rename]');field.hidden=!field.hidden;$('[data-preset-action="rename"]').setAttribute('aria-expanded',String(!field.hidden));if(!field.hidden)$('[data-preset-name]').focus();},
    copy:()=>{const preset=current();validateSummaryPreset(preset);if(library.items.length>=12)throw new Error('最多保存 12 份预设');drafts.set(selected,preset);const copy={...preset,id:freshId(),name:`${preset.name.slice(0,70)} · 副本`};library.items.push(copy);selected=copy.id;dirty=true;draw();status('新副本尚未保存，修改后点“保存并启用”。');},
    save:async()=>{const preset=validateSummaryPreset(current({includeArmor:true})),next=clone(library);drafts.set(selected,preset);next.items=next.items.map(p=>validateSummaryPreset(drafts.get(p.id)??p));next.activeId=selected;await persist(next);armorEdited.clear();status('预设已全局保存并启用；下一次手动或自动总结生效。');},
    reset:async()=>{if(!await host.confirm?.('把当前编辑稿恢复为推荐内容？保存后才生效，其他预设不变。'))return;const preset={...defaultSummaryPreset(),id:selected,name:current().name};drafts.set(selected,preset);armorEdited.delete(selected);dirty=true;draw();status('已填回推荐内容；保存并启用后生效。');},
    revert:async()=>{if(dirty&&!await host.confirm?.('放弃当前预设库中所有未保存修改？'))return;dirty=false;raw=null;paint(app.readViewState?.()??app.state);status('已重新加载保存的预设。');},
    delete:async()=>{if(library.items.length===1)throw new Error('至少保留一份预设');if(!await host.confirm?.('删除选中预设？不会删除记忆。请先保存其他编辑稿。'))return;const next=clone(library);next.items=next.items.filter(p=>p.id!==selected);if(next.activeId===selected)next.activeId=next.items[0].id;const previous=selected;selected=next.activeId;try{await persist(next);}catch(e){selected=previous;throw e;}status('预设已删除；其他已保存预设与记忆保留。');},
    export:()=>download({version:1,activeId:selected,items:[validateSummaryPreset(current({includeArmor:true}))]},'拾忆-总结预设.json'),
    import:async()=>{const file=$('[data-preset-file]').files?.[0];if(!file)throw new Error('先选择预设 JSON');if(file.size>2400000)throw new Error('文件过大');const incoming=readSummaryPresets(await file.text());if(library.items.length+incoming.items.length>12)throw new Error('导入后超过 12 份，请先删除不用的预设');drafts.set(selected,current());const imported=incoming.items.map(p=>({...p,id:freshId()}));library.items.push(...imported);selected=imported[0].id;dirty=true;draw();status('已载入编辑稿，尚未启用；检查后点“保存并启用”。');},
    preview:()=>{$('[data-preset-preview]').textContent=JSON.stringify(summaryPresetPreview(current({includeArmor:true})),null,2);},
  };
  root.addEventListener('click',event=>{const armor=event.target.closest('[data-preset-armor-toggle]');if(armor){armorEdited.add(selected);armor.setAttribute('aria-pressed',String(armor.getAttribute('aria-pressed')!=='true'));dirty=true;status('有未保存修改；尚未用于总结。');return;}const tab=event.target.closest('[data-preset-tab]');if(tab){const target=$('[data-preset-panel="'+tab.dataset.presetTab+'"]'),opening=target.hidden;for(const n of root.querySelectorAll('[data-preset-panel]'))n.hidden=true;for(const n of root.querySelectorAll('[data-preset-tab]'))n.setAttribute('aria-expanded','false');target.hidden=!opening;tab.setAttribute('aria-expanded',String(opening));return;}const example=event.target.closest('[data-preset-example]');if(example){const target=$('[data-preset-example-body="'+example.dataset.presetExample+'"]');target.hidden=!target.hidden;example.setAttribute('aria-expanded',String(!target.hidden));return;}const button=event.target.closest('[data-preset-action]');if(button){const action=actions[button.dataset.presetAction];if(action)void run(async()=>{button.disabled=true;try{await action();}finally{button.disabled=false;}},{name:'summary-preset'});}});
  return {paint};
}
