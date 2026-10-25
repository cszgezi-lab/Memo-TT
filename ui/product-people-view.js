import { foldName, personaIdentity } from '../src/persona-identity.js';
import { currentPersonaProfiles } from '../src/dynamic-persona.js';
import { recordImportance, recordDescription } from '../src/product-memory.js';
import { characterKeepsakes } from '../src/character-journal.js';
import { characterRecordSubjects, explicitSubjectNames, factKey } from '../src/product-person-profiles.js';
import { sourceLabel, recordTitle, epistemicLabel } from '../src/product-narrative.js';
import { esc } from '../src/product-settings-ui.js';
import {PERSONA_GENDERS,PERSONA_ROLES,personaCasting,personaCastingLabel,personaAttentionWeight,applyPersonaCasting} from '../src/persona-casting.js';
import {markMemoryStates} from '../src/memory-current-state.js';
import {sha256,makeId} from '../src/utils.js';
import { createPersonAvatarStore } from './product-person-avatars.js';

const PAGE_SIZE = 6;
const nameKey = name => foldName(name).trim();
const namesOf = value => explicitSubjectNames(value).filter(n => !/^(我|你|他|她|它|我们|你们|他们|她们|i|you|he|she|they)$/i.test(n));
const preview = (value, limit = 280) => {
  const text = String(value ?? '');
  return esc(text.length > limit ? `${text.slice(0, limit)}…` : text);
};
/** Newest first, using the same floor evidence the rest of the page reports. */
const newestFirst = rows => [...rows].sort((a, b) => floorOf(b) - floorOf(a));
const floorOf = record => Math.max(-1, ...(record?.sourceFloors ?? []).filter(Number.isInteger), Number.isInteger(record?.floorIndex) ? record.floorIndex : -1);

/** Relationship records are evidence-bearing stages, not nineteen simultaneous
 * current relationships. Group only for reading; every source row stays stored,
 * editable and recoverable inside the collapsed history. */
export function relationshipThreads(rows = [], resolve = nameKey) {
  const groups = new Map();
  for (const row of newestFirst(rows)) {
    const endpoints = [row.from ?? row.subject, row.to ?? row.object].filter(v => typeof v === 'string' && v.trim()).map(resolve).filter(Boolean).sort();
    const key = endpoints.length === 2 ? endpoints.join('\u0000') : `record:${row.id}`;
    if (!groups.has(key)) groups.set(key, { key, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].map(group => ({ ...group, latest: group.rows[0] }));
}

/** A disposable reading projection. No writes, identity merges or new records. */
export function peopleGroups(snapshot = {}) {
  const cards = (snapshot.cards ?? []).filter(c => !['retracted', 'superseded'].includes(c.lifecycleState));
  const profiles = (snapshot.dynamicPersona?.profiles ?? []).filter(p => !p.deleted);
  const dictionary = snapshot.dictionary ?? { entries: [] };
  const settings = snapshot.settings ?? {};
  const keepsakes = characterKeepsakes(cards.flatMap(c => c.mergedParts?.length ? c.mergedParts : [c]), { withExpected: false });
  const terms = [...(dictionary.entries ?? []), ...cards.flatMap(c => c.entities ?? [])];
  const nonPeople = new Set(terms.filter(t => ['地点', '组织', '物品'].includes(t?.kind)).map(t => nameKey(t.name)));
  const definitePeople = new Set([
    ...profiles.map(p => p.name),
    ...terms.filter(t => t?.kind === '人物').map(t => t.name),
    ...cards.filter(c => c.category !== 'entityFactChanges').flatMap(characterRecordSubjects),
    ...keepsakes.diaries.flatMap(r => namesOf(r.subject)),
    ...keepsakes.dialogues.flatMap(r => [...namesOf(r.subject), ...namesOf(r.target)]),
  ].map(nameKey));
  const person = name => !nonPeople.has(nameKey(name)) || definitePeople.has(nameKey(name));
  const recordNames = card => characterRecordSubjects(card).filter(person);
  /** A promise names its participants in one field, and that list is a display
   * grouping only: keeping it out of characterRecordSubjects leaves the recall
   * dossier budget and the open-plan schedule lane exactly as published. */
  const commitmentNames = card => card.category === 'commitmentChanges'
    ? namesOf(card.participants ?? card.subject).filter(person) : [];
  const seedDictionary = { ...dictionary, entries: (dictionary.entries ?? []).filter(t => person(t.name)) };
  const base = personaIdentity({ previous: profiles, dictionary: seedDictionary, aliases: settings.aliases ?? '' });
  // Do not promote a shared nickname to a new canonical identity during seeding.
  const claimed = new Set(base.people.flatMap(p => [p.name, ...p.aliases]).map(nameKey));
  const rawNames = [...new Set([
    ...cards.flatMap(recordNames),
    ...cards.flatMap(commitmentNames),
    ...keepsakes.diaries.flatMap(r => namesOf(r.subject)),
    ...keepsakes.dialogues.flatMap(r => [...namesOf(r.subject), ...namesOf(r.target)]),
  ])];
  const identity = personaIdentity({
    previous: [...profiles, ...rawNames.filter(n => !claimed.has(nameKey(n))).map(name => ({ name, aliases: [], aliasPolicy: 'manual' }))],
    dictionary: seedDictionary, aliases: settings.aliases ?? '',
  });
  const owners = new Map();
  for (const p of identity.people) for (const n of [p.name, ...p.aliases]) {
    const key = nameKey(n);
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key).add(p.key);
  }
  const groups = new Map();
  const groupFor = name => {
    const resolved = identity.resolve(name), folded = nameKey(name);
    const ambiguous = !resolved && (owners.get(folded)?.size ?? 0) > 1;
    const key = resolved?.key ?? `unresolved:${folded}`;
    if (!groups.has(key)) groups.set(key, {
      key, name: resolved?.name ?? name, ambiguous,
      aliases: [...(resolved?.visibleAliases ?? [])].filter(a => identity.resolve(a)?.key === resolved.key),
      profiles: [], diaries: [], dialogues: [], facts: [], records: [],
      relationships: [], commitments: [], personaChanges: [],
    });
    return groups.get(key);
  };
  const attach = (names, field, row) => {
    for (const group of new Set(names.map(groupFor))) if (!group[field].includes(row)) group[field].push(row);
  };
  for (const p of profiles) attach(namesOf(p.name), 'profiles', p);
  for (const card of cards) {
    const names = [...new Set([...recordNames(card), ...commitmentNames(card)])];
    attach(names, 'records', card);
    if (card.customModuleId) continue;
    if (card.category === 'entityFactChanges') attach(names, 'facts', card);
    else if (card.category === 'relationshipChanges') attach(names, 'relationships', card);
    else if (card.category === 'commitmentChanges') attach(names, 'commitments', card);
    else if (card.category === 'personaChanges') attach(names, 'personaChanges', card);
  }
  for (const row of keepsakes.diaries) {
    const names = namesOf(row.subject); // An inner-life target does not own this private account.
    attach(names, 'diaries', row);
    attach(names, 'records', row.record);
  }
  for (const row of keepsakes.dialogues) {
    const names = [...namesOf(row.subject), ...namesOf(row.target)];
    attach(names, 'dialogues', row);
    attach(names, 'records', row.record);
  }
  return [...groups.values()].map(group => ({
    ...group,
    casting:applyPersonaCasting({name:group.name,casting:group.profiles[0]?.casting},snapshot.dynamicPersona?.castingOverrides).casting,
    userDirectives:Object.hasOwn(snapshot.dynamicPersona?.directiveOverrides??{},nameKey(group.name))?snapshot.dynamicPersona.directiveOverrides[nameKey(group.name)]:group.profiles[0]?.userDirectives??[],
    indexWords:(dictionary.entries??[]).find(e=>nameKey(e.name)===nameKey(group.name))?.indexWords??[],
    profileSources: group.profiles,
    profiles: currentPersonaProfiles(group.profiles, settings.dynamicPersonaMvuMode),
    fieldCount: new Set(group.facts.map(factKey).filter(k => k != null)).size,
    relationships: newestFirst(group.relationships),
    relationshipThreads: relationshipThreads(group.relationships, name => identity.resolve(name)?.key ?? nameKey(name)),
    commitments: newestFirst(markMemoryStates(group.commitments,{dictionary})),
    personaChanges: newestFirst(group.personaChanges),
  })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

export function peopleHTML() {
  return `<section data-view="people" hidden class="memo-people">
    <div class="memo-top"><h3>人物</h3><span data-people-count class="memo-help" role="status"></span></div>
    <div class="memo-people-wrap">
      <div class="memo-people-catalog" data-people-catalog><div class="memo-person-directory" data-people-strip role="region" aria-label="人物卡片">
        <div class="memo-people-toolbar"><input type="search" data-people-search placeholder="搜角色" aria-label="查找人物" autocomplete="off"><button type="button" data-people-add="person">新角色</button></div><div class="memo-person-grid" data-people-grid></div>
      </div></div>
      <section class="memo-card memo-people-compose" data-people-compose hidden aria-label="人物编辑"><h4 data-people-compose-title></h4><label data-people-compose-name-label>姓名<input data-people-compose-name maxlength="32"></label><label data-people-compose-field-label><span data-people-compose-field-caption>属性名称</span><input data-people-compose-field maxlength="80"></label><label data-people-compose-text-label>内容<textarea data-people-compose-text rows="4" maxlength="12000"></textarea></label><div class="memo-actions"><button type="button" data-people-compose-save>保存</button><button type="button" data-people-compose-cancel>取消</button></div></section>
      <article data-people-detail class="memo-people-reading" aria-label="人物阅读区" hidden></article>
    </div>
  </section>`;
}

/** Avatar prose never becomes a source record or model context. Only the local
 * avatar store's bounded raster data URL is eligible to occupy this slot. */
export function personAvatarHTML(group, src = '') {
  const initial = [...String(group?.name ?? '').trim()][0] || '人';
  const safe = typeof src === 'string' && src.length <= 500000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(src);
  return `<span class="memo-person-avatar" aria-hidden="true"><span${safe ? ' hidden' : ''}>${esc(initial)}</span>${safe ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">` : ''}</span>`;
}

export function personCardHTML(group, avatar = '') {
  const casting = personaCasting(group.casting ?? group.profiles?.[0]?.casting);
  const stats = `${group.fieldCount ?? 0} 项属性 · ${group.profiles?.length ?? 0} 份档案`;
  return `<button type="button" class="memo-person-card" data-people-key="${esc(group.key)}" aria-label="查看${esc(group.name)}的人物档案">
    ${personAvatarHTML(group, avatar)}<span class="memo-person-card-content"><strong class="memo-person-card-title">${esc(group.name)}</strong><span class="memo-person-card-role">${esc(group.ambiguous ? '称呼待归属' : personaCastingLabel(casting))}</span><span class="memo-person-card-meta">${esc(stats)}</span></span><span class="memo-person-card-caret" aria-hidden="true">›</span>
  </button>`;
}

const personCategory = (key, title, caption, content) => `<details class="memo-person-category" data-person-category="${key}"><summary><span>${esc(title)}</span><small>${esc(caption)}</small></summary><div class="memo-person-category-body">${content}</div></details>`;

/** A dossier route is only safe once the name belongs to exactly one person. */
const openButton = (group, kind, label, profileId = '') => {
  const disabled = Boolean(group?.ambiguous) && !profileId;
  return `<button type="button" data-people-open="${kind}" data-people-profile="${esc(profileId)}"${disabled ? ' disabled' : ''}>${label}</button>`;
};
const sourceText = record => record.sourceRefs?.length || record.sourceFloors?.length || Number.isInteger(record.floorIndex) || record.documentName
  ? sourceLabel(record) : '来源未注明';
const phase = row => row.data.disabled ? '不再注入' : row.record.innerLifeHistorical || row.data.status === 'historical'
  ? '过去阶段' : row.kind === 'dialogue' ? '仍重要' : '按记录情境适用';

const peopleMergeHTML = (profiles, group) => {
  const source=group?.profiles?.[0];
  if(!source||group.ambiguous)return '';
  const targets=profiles.filter(p=>p.id!==source.id);
  if(!targets.length)return '';
  return `<div class="memo-people-merge" data-people-merge data-merge-source="${esc(source.id)}"><button type="button" data-people-merge-toggle aria-expanded="false">合并档案</button><section data-people-merge-form hidden><label>合并到<select data-people-merge-target-select aria-label="合并到哪位人物">${targets.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><p class="memo-help">将${esc(group.name)}并入所选人物，合并后只显示目标人物。原档案可恢复。</p><button type="button" data-people-merge-commit>确认合并</button></section></div>`;
};

const personaBindHTML = (group, profiles, people=[]) => {
  if (!group || !group.ambiguous && group.profiles.length) return '';
  const memoryPeople=people.filter(p=>!p.ambiguous&&!p.profiles.length&&p.key!==group.key);
  if(!profiles.length&&!memoryPeople.length)return '';
  const ordered = [...profiles]
    .sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name, 'zh-CN'))
  const foldedName = nameKey(group.name);
  const likely = ordered.filter(p => nameKey(p.name).includes(foldedName));
  const options = ordered
    .map(p => `<option value="${esc(p.id)}"${likely.length === 1 && likely[0].id === p.id ? ' selected' : ''}>${esc(p.name)}${p.bindings?.length ? ' · 已关联原书' : ''}</option>`)
    .join('')+memoryPeople.map(p=>`<option value="person:${esc(p.key)}">${esc(p.name)} · 记忆人物</option>`).join('');
  return `<details class="memo-people-persona-bind" data-people-persona-bind>
    <summary>把“${esc(group.name)}”归入已有${memoryPeople.length?'人物':'动态人设'}</summary>
    <p class="memo-help">${group.ambiguous?'这个称呼目前对应多人，系统不会擅自猜测归属。':'这个名字来自记忆记录，尚未关联动态档案；若是已有角色的简称，可在这里确认归属。'}选择正确的人物后，若称呼已有正式档案会直接合并；否则保存为目标档案的手工别称。当前称呼下已有的心迹、台词、属性会随身份归属统一显示。不调用模型、不改原文、不改原世界书；合并仍保留可恢复版本。</p>
    <label>归入档案<select data-people-persona-bind-target aria-label="把称呼归入人物档案">${options}</select></label>
    <button type="button" data-people-persona-bind-commit>确认归入所选人物</button>
  </details>`;
};

const peopleStars = (record, category) => {
  if (!record) return '';
  const n = recordImportance({ ...record, category: record.category ?? category });
  return `<span class="memo-stars memo-lv${n}" aria-label="重要度 ${n}/5">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span> `;
};
const keepField = (key, label, value = '', multi = false, placeholder = '') => `<label class="memo-field"><span>${esc(label)}</span>${multi
  ? `<textarea rows="4" data-keep-field="${key}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
  : `<input data-keep-field="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}">`}</label>`;
/** Inline editors, one per record kind, so a person entry is edited where it is
 * read. Diary and dialogue text live inside innerLife/keyDialogues, so they go
 * through the keepsake writer instead of overwriting the whole record body. */
export function personEntryEditor(row, kind) {
  if (kind === 'diary') {
    const d = row.data;
    return `<section class="memo-card memo-person-entry-editor" data-person-editor="${esc(row.id)}" data-editor-kind="diary">
      ${keepField('stage', '阶段名称', d.stage ?? '', false, '例如：初识 / 争执后')}
      ${keepField('text', '角色心迹（角色视角）', d.text ?? '', true, '用角色的语气写这一阶段的内心，例如：我还是不敢直接问。')}
      ${keepField('cause', '变化缘由（可留空）', d.cause ?? '', true, '哪件事促成的，例如：他在雨里把外套给了我。')}
      <p class="memo-help">只改这一条心迹，不动事件和其它记录。</p>
      <div class="memo-actions"><button type="button" class="memo-primary" data-person-keep-save="${esc(row.id)}">保存心迹</button><button type="button" data-person-editor-close>取消</button></div>
    </section>`;
  }
  if (kind === 'dialogue') {
    const d = row.data;
    return `<section class="memo-card memo-person-entry-editor" data-person-editor="${esc(row.id)}" data-editor-kind="dialogue">
      ${keepField('speaker', '说话人', d.speaker ?? '', false, '例如：陈宁')}
      ${keepField('to', '对谁说（可留空）', d.to ?? '', false, '例如：林晓')}
      ${keepField('text', '台词原话', d.text ?? '', true, '逐字照抄原文，不要改写。')}
      ${keepField('context', '当时语境与对方回应（可留空）', d.context ?? '', true, '什么时候、因为什么说的，对方怎么回。')}
      ${keepField('meaning', '重要之处（可留空）', d.meaning ?? '', true, '例如：第一次明确说出边界。')}
      <div class="memo-actions"><button type="button" class="memo-primary" data-person-keep-save="${esc(row.id)}">保存台词</button><button type="button" data-person-editor-close>取消</button></div>
    </section>`;
  }
  return '';
}
/** One field row: the whole line opens it, the content opens the editor. */
export function personFieldRow({ label, value, source, category, id, clamp = 1 }) {
  const text = String(value ?? '');
  return `<div class="memo-field-row" data-field-row data-clamp="${clamp}" data-field-category="${esc(category)}" data-field-id="${esc(id ?? '')}">
    <div class="memo-field-sum" data-people-edit="${esc(id ?? '')}"><span>${esc(label)}</span><span class="memo-field-value">${preview(text, 600)}</span><span class="memo-field-caret">›</span></div>
    <div class="memo-field-open" hidden>
      <div class="memo-field-body" role="button" tabindex="0"><div class="memo-field-full">${preview(text, 4000)}</div></div>
      <p class="memo-field-src">${esc(source || '来源未注明')}</p>
      <div class="memo-field-bar"><button type="button" data-field-edit>修改</button><button type="button" class="memo-row-remove" data-field-remove>删除</button></div>
    </div>
  </div>`;
}
const fieldGroup = (title, count, rows, empty, { category = '', add = '' } = {}) => `<section class="memo-field-group" data-people-module="${esc(category)}">
  <header><span>${esc(title)} <small>${count}</small></span>${add ? `<button type="button" data-people-add="${esc(add)}">新增</button>` : ''}</header>
  ${rows || `<p class="memo-help">${esc(empty)}</p>`}
</section>`;
export function peopleDetailHTML(group, allProfiles = group?.profiles ?? [], editing = '',allPeople=[], avatar = '', modules=[], cards=[]) {
  if (!group) return '<p class="memo-person-empty">还没有人物。整理一段聊天后会自动出现，也可以直接新建一个角色。</p>';
  const profileId = group.profiles[0]?.id ?? '';
  const profile=group.profiles[0];
  const personaUnapplied=Boolean(profile?.composition?.pendingRevision||profile?.composition?.pendingOnly||profile?.composition?.pendingEdits?.length||profile?.composition?.changeCheck?.issues?.length);
  const reviewRows=(profile?.reviewSuggestions??[]).map(s=>`<div class="memo-card"><div class="memo-packet">${esc(profile.composition?.parts?.find(p=>p.key===s.key)?.text??'片段已变化')}</div><p>${esc(s.reason)}</p><p class="memo-help">第${esc(s.evidence.floor)}楼依据：${esc(s.evidence.quote)}</p><button type="button" data-persona-history="${esc(s.key)}" data-profile="${esc(profile.id)}" data-history-value="true">确认移入历史（不删除）</button></div>`).join('');
  const archived=(profile?.composition?.parts??[]).filter(p=>p.status==='historical').map(p=>`<div class="memo-card"><div class="memo-packet">${esc(p.text)}</div><button type="button" data-persona-history="${esc(p.key)}" data-profile="${esc(profile.id)}" data-history-value="false">恢复当前设定</button></div>`).join('');
  const casting=personaCasting(group.casting??group.profiles[0]?.casting);
  const emphasis=group.userDirectives??profile?.userDirectives??[];
  const emphasisHTML=!group.ambiguous?`<section data-people-emphasis="${esc(profileId)}" data-emphasis-name="${esc(group.name)}"><p class="memo-help">单独保存，不会被自动总结改掉。动态人设开启时，提到此人物就会注入。一行一句，删掉某一行就是删除这条。</p><label>强调内容<textarea rows="4" data-emphasis-lines>${esc(emphasis.join('\n'))}</textarea></label><label>或者用大白话告诉模型要记住、修改或删掉什么<textarea rows="3" data-emphasis-ask placeholder="例如：对某个人现在按你写的方式相处。已有的句子会保留，除非你说明要改或删。"></textarea></label><div class="memo-actions"><button type="button" data-emphasis-draft>让模型整理</button><button type="button" data-emphasis-save>保存强调</button></div><p class="memo-help">「让模型整理」会用人设接口调用一次模型，结果只填进上面的框，保存后才生效。</p></section>`:'';
  const options=(values,current)=>Object.entries(values).map(([value,label])=>`<option value="${value}"${value===current?' selected':''}>${label}</option>`).join('');
  const profileRows = group.profiles.slice(0, 2).map(p => personFieldRow({
    label: p.locked ? '整份档案 · 已锁定' : `整份档案 · ${Number.isInteger(p.through) ? `依据至 #${p.through}` : '已保存'}`,
    value: p.text, source: `${sourceText(p)}${[...new Map((p.bindings ?? []).map(b => [JSON.stringify([b.book, b.uid]), b])).values()].slice(0, 4).map(b => `${b.book} · ${b.originalName ?? b.name}（原书只读）`).join(' · ')}`, category: 'dynamic-persona', id: p.id, clamp: 3,
  })).join('') || `<p class="memo-help">还没有动态人设档案。${openButton(group, 'dynamic-persona', '补建档案', profileId)}</p>`;  const factRows = group.facts.map(record => personFieldRow({
    label: `${factKey(record) ?? '属性'}`, value: recordDescription(record).replace(/^[^：]*：/, ''),
    source: sourceText(record), category: 'entityFactChanges', id: record.id, clamp: 1,
  })).join('');
  const personRows = (rows, category) => rows.map(record => personFieldRow({
    label: recordTitle(record), value: recordDescription(record), source: sourceText(record), category, id: record.id, clamp: 3,
  })).join('');
  const relationThreads = group.relationshipThreads ?? relationshipThreads(group.relationships ?? []);
  const currentCommitments=(group.commitments??[]).filter(r=>!r.stateHistorical&&!['completed','canceled','declined'].includes(r.state));
  const closedCommitments=(group.commitments??[]).filter(r=>!r.stateHistorical&&['completed','canceled','declined'].includes(r.state));
  const commitmentRow=r=>`${personRows([r],'commitmentChanges')}${r.stateHistoryIds?.length?`<details class="memo-state-history"><summary>前序状态与重复依据 ${r.stateHistoryIds.length} 条</summary>${personRows(group.commitments.filter(p=>r.stateHistoryIds.includes(p.id)),'commitmentChanges')}</details>`:''}`;
  const commitmentRows=currentCommitments.map(commitmentRow).join('')+(closedCommitments.length?`<details class="memo-closed-commitments"><summary>已完成／取消／拒绝 ${closedCommitments.length} 项</summary>${closedCommitments.map(commitmentRow).join('')}</details>`:'');
  const relationshipRows = relationThreads.map(thread => {
    const current = [...thread.rows.slice(0,3)].reverse().map(r=>`<p class="memo-help">${esc(sourceText(r))}</p>${personRows([r], 'relationshipChanges')}`).join('');
    const older = thread.rows.slice(3);
    return `${current}${older.length ? `<details class="memo-relationship-history"><summary>过往 ${older.length} 条关系变化（保留来源，可逐条修改）</summary>${personRows(older, 'relationshipChanges')}</details>` : ''}`;
  }).join('');
  const diaryRows = group.diaries.slice(0, 3).map(r => `${personFieldRow({
    label: `${r.data.stage ?? '未注明阶段'} · ${r.record.innerLifeHistorical || r.data.status === 'historical' ? '过去阶段' : '按记录情境适用'}`,
    value: r.data.text,
    source: `${sourceText(r.record)} · ${epistemicLabel(r.data.basis) ?? '依据未注明'}${r.data.disabled ? ' · 不再注入' : ''}`, category: 'diary', id: r.id, clamp: 3,
  })}${editing === r.id ? personEntryEditor(r, 'diary') : ''}`).join('');
  const dialogueRows = group.dialogues.slice(0, 3).map(r => `${personFieldRow({
    label: `${r.subject}${r.target ? ` → ${r.target}` : ''} · ${phase(r)}`,
    value: r.data.text,
    source: `${sourceText(r.record)}${r.data.provenance === 'user_authored' ? ' · 用户编写，非核对原话' : ''}`, category: 'dialogue', id: r.id, clamp: 3,
  })}${editing === r.id ? personEntryEditor(r, 'dialogue') : ''}`).join('');
  const stats = `${group.fieldCount} 项属性 · 关系 ${relationThreads.length} 组${(group.relationships?.length ?? 0) > relationThreads.length ? `（${group.relationships.length} 条历程）` : ''} · 约定 ${currentCommitments.length} 项 · 人设变化 ${group.personaChanges?.length ?? 0} · 心迹 ${group.diaries.length} · 台词 ${group.dialogues.length}`;
  const castingHTML = !group.ambiguous ? `<details data-people-casting="${esc(profileId||group.name)}"><summary><span class="memo-casting-badge memo-casting-${casting.role}">${esc(personaCastingLabel(casting))}</span> · 调整定位</summary><div class="memo-grid"><label>性别<select data-casting-gender>${options(PERSONA_GENDERS,casting.gender)}</select></label><label>剧情定位<select data-casting-role>${options(PERSONA_ROLES,casting.role)}</select></label></div><label><input type="checkbox" data-casting-player${casting.playerControlled?' checked':''}>由玩家扮演（降低补充材料份额）</label><p class="memo-help">当前记录关注权重 ${personaAttentionWeight(casting)}：主角4、重要配角3、配角2、客串1；玩家角色1。影响主更新检查顺序与补充材料份额，不漏掉低权重人物的重大变化；性别不影响权重。</p><button type="button" data-casting-save>保存定位</button></details>` : '';
  const avatarHTML = `<div class="memo-person-photo-controls"><input type="file" data-people-avatar-file accept="image/png,image/jpeg,image/webp" hidden${group.ambiguous ? ' disabled' : ''}><button type="button" data-people-avatar-upload${group.ambiguous ? ' disabled' : ''}>${avatar ? '更换头像' : '上传头像'}</button>${avatar ? '<button type="button" data-people-avatar-remove>移除头像</button>' : ''}<p class="memo-help">头像仅保存在本设备，不发送给模型。未上传时显示名字首字。</p></div>`;
  const basic = `<label>姓名<input data-people-name maxlength="120" value="${esc(group.name)}"${group.ambiguous?' disabled':''}></label><button type="button" data-people-save-name${group.ambiguous?' disabled':''}>保存姓名</button>${avatarHTML}${group.aliases.length ? `<p class="memo-help">别称：${esc(group.aliases.join('、'))}</p>` : ''}${castingHTML}`;
  const persona = `<div class="memo-persona-block" data-people-persona-block>${profile?.composition?.changeCheck ? `<p class="memo-help" data-persona-change-check>${esc(personaUnapplied ? '保留原有可用内容；未应用的历史改动可在档案来源中展开查看。正常更新会自动保存，无需逐条批准。' : '人设已自动更新并保存'+(profile.composition.changeCheck.status==='uncertain'?'；部分解释仍有不确定性。':'。'))}</p>` : ''}${fieldGroup('动态人设', group.profiles.length, profileRows, '还没有动态人设档案。', { category: 'dynamic-persona' })}${fieldGroup('人设变化', group.personaChanges?.length ?? 0, personRows(group.personaChanges ?? [], 'personaChanges'), '还没有人设变化。', { category: 'personaChanges', add: 'persona' })}${reviewRows||archived ? `<details class="memo-card"><summary>人设整理建议与历史</summary>${reviewRows}${archived ? `<details><summary>已移入历史</summary>${archived}</details>` : ''}</details>` : ''}<div class="memo-actions">${openButton(group, 'dynamic-persona', '全部档案', profileId)}</div></div>`;
  const relations = `${fieldGroup('关系', relationThreads.length, relationshipRows, '还没有关系记录。', { category: 'relationshipChanges', add: 'relationship' })}${fieldGroup('约定', currentCommitments.length, commitmentRows, '还没有约定。', { category: 'commitmentChanges', add: 'commitment' })}`;
  const experiences = (group.records ?? []).filter(r => r.category === 'events');
  const awareness = (group.records ?? []).filter(r => r.category === 'awarenessChanges');
  const experience = `${fieldGroup('相关经历', experiences.length, personRows(experiences, 'events'), '还没有归属此人物的经历记录。', { category: 'events' })}${fieldGroup('知情记录', awareness.length, personRows(awareness, 'awarenessChanges'), '还没有知情记录。', { category: 'awarenessChanges' })}`;
  const voice = `${fieldGroup('角色心迹', group.diaries.length, diaryRows, '还没有心迹。', { category: 'diary' })}${fieldGroup('关键台词', group.dialogues.length, dialogueRows, '还没有关键台词。', { category: 'dialogue' })}<div class="memo-actions">${openButton(group, 'diary', '全部心迹', profileId)}${openButton(group, 'dialogue', '全部台词', profileId)}</div>`;
  const management = `${group.ambiguous ? '<p class="memo-help" role="status">此称呼对应多人，暂不归入任何人的档案。请从全部记录核对姓名或在召回字典中确认别称。</p>' : ''}${personaBindHTML(group, allProfiles,allPeople)}${peopleMergeHTML(allProfiles,group)}<div class="memo-actions memo-person-bar"><button type="button" class="danger" data-people-remove>删除人物记录</button></div>`;
  const ownedModules=modules.filter(m=>!m.archived&&[group.name,...group.aliases].some(n=>nameKey(n)===nameKey(m.subject)));
  const custom=ownedModules.map(m=>personCategory('custom-'+esc(m.id),m.name,`${m.fields.length} 个字段`,m.fields.map(f=>{
    const rows=cards.filter(c=>c.customModuleId===m.id&&c.fieldId===f.id&&[group.name,...group.aliases].some(n=>nameKey(n)===nameKey(c.entity??c.entityId??m.subject)));
    return `<section class="memo-field-group"><header><span>${esc(f.label)}</span>${m.mode==='manual'?`<button type="button" data-people-module-value="${esc(m.id)}" data-module-field="${esc(f.id)}">新增</button>`:''}</header>${rows.map(c=>`<p>${esc(recordDescription(c))}</p>`).join('')||'<p class="memo-help">暂无记录。</p>'}</section>`;
  }).join(''))).join('');
  return `<div class="memo-person-detail-head"><button type="button" data-people-back>返回人物</button><div class="memo-person-identity">${personAvatarHTML(group, avatar)}<div><h4 data-people-title tabindex="-1">${esc(group.name)}</h4><p class="memo-help">${esc(personaCastingLabel(casting))}</p></div></div><p class="memo-person-detail-stats memo-help">${esc(stats)}</p></div><div class="memo-person-categories">
    ${personCategory('basic', '基本资料', '姓名、头像与定位', basic)}
    ${personCategory('emphasis', '强调', emphasis.length?`${emphasis.length} 条`:'未设置', emphasisHTML||'<p class="memo-help">请先确认此称呼对应的人物。</p>')}
    ${personCategory('attributes', '人物属性', `${group.fieldCount} 项属性`, fieldGroup('属性',group.fieldCount,factRows,'还没有属性记录。',{category:'entityFactChanges',add:'attribute'}))}
    ${personCategory('persona', '动态人设', `${group.profiles.length} 份档案`, persona)}
    ${personCategory('relations', '关系与约定', `${relationThreads.length} 组关系 · ${currentCommitments.length} 项约定`, relations)}
    ${personCategory('experience', '经历与知情', `${experiences.length} 段经历 · ${awareness.length} 条知情`, experience)}
    ${personCategory('voice', '心迹与台词', `${group.diaries.length} 条心迹 · ${group.dialogues.length} 句台词`, voice)}
    ${custom}<button type="button" data-people-add="module">新增模块</button>
    ${personCategory('management', '管理', '归属、合并与删除', management)}
  </div>`;
}

/** onSelect owns filtered navigation; an empty name clears that page's filter. */
export function mountPeopleView({ panel, app, run, host, setPage, onSelect, avatarStore = createPersonAvatarStore() }) {
  const root = panel.querySelector?.('[data-view="people"]');
  if (!root) return { paint(){}, focus(){}, select(){} };
  const $ = selector => root.querySelector?.(selector);
  const composeNode=$('[data-people-compose]');
  let scope, avatarScope, stamp = '', rendered = '', renderedPerson='', groups = [], selected = '', editing = '', stripStamp = '', query = '', composing = false, sourceCards = [], avatarRevision = avatarStore.revision, draft=null, sourceModules=[];
  const origins = row => (row.origins?.length ? row.origins : [row]).map(origin => {
    const record=sourceCards.flatMap(c=>c.mergedParts?.length?c.mergedParts:[c]).find(c=>c.id===origin.recordId);
    if(!record)throw new Error('来源记忆已变化，请刷新人物页');
    return {...origin,expected:sha256(record)};
  });
  const filter = () => {
    const needle = nameKey(query);
    return groups.filter(g => [g.name, ...g.aliases].some(n => nameKey(n).includes(needle)));
  };
  // Device decoration must not turn a completed business mutation into an
  // apparent failed rename, merge or deletion when localStorage is full.
  function maintainAvatar(actionScope, group, action, savedLabel) {
    if (!avatarStore.read(actionScope, group)) return null;
    try { action(); avatarRevision = avatarStore.revision; return null; }
    catch (error) { return { message: `${savedLabel}；本机头像未调整：${error?.message || '保存失败'}。`, level: 'warning' }; }
  }
  function draw(rebuildStrip = true) {
    if (composing) return;
    const visible = filter();
    if(draft&&(draft.scope!==scope||(draft.kind==='person'?Boolean(selected):draft.key!==selected)))closeCompose();
    if (!visible.some(g => g.key === selected)) selected = '';
    const group = visible.find(g => g.key === selected);
    $('[data-people-count]').textContent = `${groups.length} 位人物`;
    const strip = $('[data-people-strip]');
    const searchMarkup = `<div class="memo-people-toolbar"><input type="search" data-people-search placeholder="搜角色" aria-label="查找人物" autocomplete="off" value="${esc(query)}"><button type="button" data-people-add="person">新角色</button></div>`;
    const cardsMarkup = visible.map(g => personCardHTML(g, avatarStore.read(avatarScope, g))).join('')
      || `<p class="memo-person-empty">${groups.length ? '没有匹配的角色，试试其他姓名或别称。' : '还没有人物。整理一段聊天后会自动出现，也可以直接新建一个角色。'}</p>`;
    const stripMarkup = searchMarkup + `<div class="memo-person-grid" data-people-grid>${cardsMarkup}</div>`;
    if (strip && rebuildStrip && stripStamp !== stripMarkup) {
      const left=strip.scrollLeft??0;
      stripStamp = stripMarkup;
      if (typeof strip.querySelector === 'function') {
        // Keep the browser's input node, selection and IME session intact.
        const search = $('[data-people-search]');
        if (search) { if (search.value !== query) search.value = query; }
        const grid = strip.querySelector('[data-people-grid]');
        if (grid) grid.innerHTML = cardsMarkup;
      } else strip.innerHTML = stripMarkup;
      strip.scrollLeft=left;
    }
    const allProfiles = groups.flatMap(g => g.profiles);
    const catalog = $('[data-people-catalog]');
    if (catalog) catalog.hidden = Boolean(group);
    const detailNode = $('[data-people-detail]');
    if (detailNode) detailNode.hidden = !group;
    const detail = group ? peopleDetailHTML(group, allProfiles, editing,groups,avatarStore.read(avatarScope, group),sourceModules,sourceCards) : '';
    if (detail !== rendered) {
      const node=$('[data-people-detail]'),samePerson=renderedPerson===selected;
      const opened=samePerson?[...(node.querySelectorAll?.('details')??[])].map((d,i)=>d.open?i:-1).filter(i=>i>=0):[];
      const scroll=[];
      if(samePerson)for(let parent=node;parent;parent=parent.parentElement)scroll.push([parent,parent.scrollTop??0,parent.scrollLeft??0]);
      const drafts=samePerson?[...(node.querySelectorAll?.('[data-people-dirty]')??[])].filter(n=>n.type!=='file').map(n=>({attr:[...n.attributes].find(a=>a.name.startsWith('data-')&&a.name!=='data-people-dirty')?.name,value:n.value,checked:n.checked,active:n===node.ownerDocument?.activeElement,start:n.selectionStart,end:n.selectionEnd})):[];
      const mergeOpen=samePerson&&Boolean(node.querySelector?.('[data-people-merge-form]')&&!node.querySelector('[data-people-merge-form]').hidden);
      const composeFocus=composeNode.contains?.(node.ownerDocument?.activeElement)?node.ownerDocument.activeElement:null;
      if(node.contains?.(composeNode))root.append?.(composeNode);
      node.innerHTML = detail;
      if(mergeOpen){const form=node.querySelector('[data-people-merge-form]');if(form)form.hidden=false;node.querySelector('[data-people-merge-toggle]')?.setAttribute('aria-expanded','true');}
      positionCompose();if(composeFocus?.isConnected)composeFocus.focus({preventScroll:true});
      for(const item of drafts){const n=item.attr?node.querySelector('['+item.attr+']'):null;if(!n)continue;n.value=item.value;if(n.type==='checkbox')n.checked=item.checked;n.dataset.peopleDirty='true';if(item.active){n.focus({preventScroll:true});if(typeof item.start==='number')n.setSelectionRange?.(item.start,item.end);}}
      for(const [i,d] of [...(node.querySelectorAll?.('details')??[])].entries())if(opened.includes(i))d.open=true;
      for(const [parent,top,left] of scroll){parent.scrollTop=top;parent.scrollLeft=left;}
      rendered = detail;renderedPerson=selected;
    }
  }
  function closeCompose(){draft=null;composeNode.hidden=true;root.append?.(composeNode);}
  function positionCompose(){
    if(!draft||composeNode.hidden)return;
    let anchor;
    if(draft.kind==='person')anchor=$('[data-people-catalog] .memo-people-toolbar');
    else if(draft.record?.id)anchor=[...(root.querySelectorAll?.('[data-field-row]')??[])].find(n=>n.dataset.fieldId===draft.record.id);
    else if(draft.kind==='module-value')anchor=[...(root.querySelectorAll?.('[data-people-module-value]')??[])].find(n=>n.dataset.peopleModuleValue===draft.moduleId&&n.dataset.moduleField===draft.fieldId)?.closest?.('header');
    else {const button=$('[data-people-add="'+draft.kind+'"]');anchor=draft.kind==='module'?button:button?.closest?.('.memo-field-group')?.querySelector('header');}
    if(anchor?.after)anchor.after(composeNode);
  }
  function compose(kind,record=null,extra={}){
    const group=groups.find(g=>g.key===selected);if(kind!=='person'&&(!group||group.ambiguous))return;
    const body=root.closest?.('.memo-body'),top=body?.scrollTop;
    draft={kind,record,scope,key:group?.key,name:group?.name,token:makeId('draft'),...extra};
    $('[data-people-compose-title]').textContent=({person:'新角色',module:'新增模块','module-value':'新增记录'})[kind]??(record?'修改记录':'新增记录');
    $('[data-people-compose-name-label]').hidden=kind!=='person';
    $('[data-people-compose-name]').value=kind==='person'?'':group?.name??'';$('[data-people-compose-name]').disabled=kind!=='person';
    $('[data-people-compose-field-label]').hidden=!['attribute','module'].includes(kind);$('[data-people-compose-field-caption]').textContent=kind==='module'?'模块名称':'属性名称';
    $('[data-people-compose-field]').value=record?factKey(record)??'':'';
    $('[data-people-compose-text-label]').hidden=kind==='person';
    $('[data-people-compose-text]').value=record?String(record.to??record.value??record.newValue??recordDescription(record)):'';
    composeNode.hidden=false;positionCompose();
    $(kind==='person'?'[data-people-compose-name]':['attribute','module'].includes(kind)?'[data-people-compose-field]':'[data-people-compose-text]')?.focus({preventScroll:true});
    if(body&&top!==undefined)body.scrollTop=top;
  }
  function addFor(kind){compose(kind);}
  function paint(snapshot) {    if (root.hidden) return;
    const nextAvatarScope = snapshot.scope ?? snapshot.core?.scope ?? app?.core?.state?.scope ?? null;
    const nextScope = JSON.stringify(nextAvatarScope);
    if (scope !== nextScope) {
      scope = nextScope; closeCompose(); selected = ''; stamp = ''; rendered = ''; renderedPerson='';editing = ''; stripStamp = ''; query = ''; composing = false;
    }
    const revision = snapshot.peopleRevision;
    const nextStamp = revision != null ? `revision:${revision}:${sha256(snapshot.modules??[])}`
      : `legacy:${JSON.stringify([snapshot.cardRevision ?? snapshot.cards, snapshot.dynamicPersona?.profiles, snapshot.dynamicPersona?.directiveOverrides, snapshot.dictionary, snapshot.modules, snapshot.settings?.aliases, snapshot.settings?.dynamicPersonaMvuMode])}`;
    avatarScope = nextAvatarScope;
    if (stamp === nextStamp) {
      if (avatarRevision !== avatarStore.revision) { avatarRevision = avatarStore.revision; draw(); }
      return;
    }
    sourceCards = snapshot.cards ?? []; sourceModules=snapshot.modules??[]; groups = peopleGroups(snapshot); stamp = nextStamp; avatarRevision = avatarStore.revision; draw();
  }
  /** 第一次点这一行：展开全文。展开之后点这一行的文字：进编辑。 */
  function openFieldEditor(row) {
    const id = row?.dataset.fieldId ?? '';
    const category = row?.dataset.fieldCategory ?? '';
    if (!id) return;
    if (category === 'diary' || category === 'dialogue') { editing = id; rendered = ''; draw(); return; }
    if(category==='dynamic-persona'){const group=groups.find(g=>g.key===selected);const profile=group?.profiles.find(p=>p.id===id);if(profile)compose('profile',{id:profile.id,value:profile.text});return;}
    const record=sourceCards.find(c=>c.id===id);if(record)compose(category==='entityFactChanges'?'attribute':category,record);
  }
  root.addEventListener('click', event => {
    if (event.target.closest?.('button')) return;
    const summary = event.target.closest?.('.memo-field-sum');
    if (!summary) return;
    const row = summary.closest('[data-field-row]');
    const open = row?.querySelector('.memo-field-open');
    if (!row || !open) return;
    if (row.dataset.open !== '1') { row.dataset.open = '1'; open.hidden = false; return; }
    openFieldEditor(row);
  });
  root.addEventListener('compositionstart', event => {
    if (event.target.closest?.('[data-people-search]')||event.target.matches?.('input,textarea')) composing = true;
  });
  root.addEventListener('compositionend', event => {
    if (!event.target.closest?.('[data-people-search]')&&!event.target.matches?.('input,textarea')) return;
    composing = false;if(!event.target.closest?.('[data-people-search]')){draw();return;}
    query = String(event.target.value ?? '');
    draw();
  });
  // Filter after IME commits; never replace or refocus the composing input.
  root.addEventListener('input', event => {
    if(event.target.closest?.('[data-people-detail]')&&event.target.matches?.('input,textarea,select'))event.target.dataset.peopleDirty='true';
    if (!event.target.closest?.('[data-people-search]')) return;
    if (composing || event.isComposing) return;
    query = String(event.target.value ?? '');
    draw(true);
  });
  root.addEventListener('change', event => {
    const fileInput = event.target.closest?.('[data-people-avatar-file]');
    if (fileInput) {
      const group = groups.find(g => g.key === selected), file = fileInput.files?.[0], pickedScope = avatarScope, scopeAtPick = scope;
      fileInput.value = '';
      if (!file || !group || group.ambiguous) return;
      const button = $('[data-people-avatar-upload]');
      void run(async () => {
        await avatarStore.set(pickedScope, group, file);
        if (scope === scopeAtPick) { avatarRevision = avatarStore.revision; draw(); }
        return { message: '头像已保存在本设备。', level: 'success' };
      }, { name: 'save-person-avatar', button });
      return;
    }
    const select = event.target.closest('[data-people-merge-source-select]');
    if (!select) return;
    const target = root.querySelector('[data-people-merge-target-select]');
    if (!target) return;
    const allProfiles = groups.flatMap(g => g.profiles);
    target.innerHTML = allProfiles.filter(p => p.id !== select.value).sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name, 'zh-CN')).map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.bindings?.length ? ' · 已关联原书' : ''}</option>`).join('');
  });
  root.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if(button.hasAttribute('data-people-compose-cancel')){closeCompose();return;}
    if(button.hasAttribute('data-people-compose-save')){
      if(!draft)return;const action={...draft},name=$('[data-people-compose-name]').value.trim(),field=$('[data-people-compose-field]').value.trim(),text=$('[data-people-compose-text]').value.trim();
      void run(async()=>{
        if(scope!==action.scope||JSON.stringify(app.state.scope??app.state.core?.scope??null)!==action.scope)throw Error('聊天已切换，请重新编辑');
        if(action.kind==='person'?!name:action.kind==='module'?!field:!text||action.kind==='attribute'&&!field)throw Error(action.kind==='person'?'请填写姓名':'请填写名称和内容');
        if(action.kind==='person'){await app.addDynamicPersona(name);query='';}
        else if(action.kind==='profile')await app.editDynamicPersona(action.record.id,{text});
        else if(action.kind==='module'){const id=makeId('module');await app.saveModule({id,name:field,subject:action.name,description:'',mode:'manual',fields:[{id:'value',label:field,type:'text'}],enabled:true,inject:false,archived:false},{expected:null});if(text)await app.rememberModule(id,'value',text);}
        else if(action.kind==='module-value'){let value=text;if(action.type==='number')value=Number(text);if(action.type==='boolean'){if(!['true','false'].includes(text))throw Error('开关请填写 true 或 false');value=text==='true';}await app.rememberModule(action.moduleId,action.fieldId,value);}
        else if(action.record)await app.editRecord(action.record.id,text,action.kind==='attribute'?{entity:action.name,field}:{});
        else await app.remember(text,action.name,{category:({attribute:'entityFactChanges',relationship:'relationshipChanges',commitment:'commitmentChanges',persona:'personaChanges'})[action.kind]??action.kind,subject:action.name,field});
        if(scope===action.scope&&draft?.token===action.token){closeCompose();stamp='';paint(app.state);}
      },{name:'journal-write',button});return;
    }
    if(button.hasAttribute('data-people-module-value')){const m=sourceModules.find(m=>m.id===button.dataset.peopleModuleValue),f=m?.fields.find(f=>f.id===button.dataset.moduleField),group=groups.find(g=>g.key===selected);if(!m||!f||!group||![group.name,...group.aliases].some(n=>nameKey(n)===nameKey(m.subject)))return;compose('module-value',null,{moduleId:m.id,fieldId:f.id,type:f.type});return;}
    if(button.hasAttribute('data-people-merge-toggle')){const form=$('[data-people-merge-form]');if(form){form.hidden=!form.hidden;button.setAttribute('aria-expanded',String(!form.hidden));}return;}
    if (button.hasAttribute('data-people-back')) {
      closeCompose();selected = ''; editing = ''; renderedPerson = ''; draw(false);
      $('[data-people-search]')?.focus({ preventScroll: true });
      return;
    }
    if (button.hasAttribute('data-people-avatar-upload')) {
      $('[data-people-avatar-file]')?.click();
      return;
    }
    if (button.hasAttribute('data-people-avatar-remove')) {
      const group = groups.find(g => g.key === selected);
      if (group && !group.ambiguous) void run(async () => {
        avatarStore.remove(avatarScope, group); avatarRevision = avatarStore.revision; draw();
        return { message: '头像已移除，恢复显示名字首字。', level: 'success' };
      }, { name: 'save-person-avatar', button });
      return;
    }
    if(button.hasAttribute('data-persona-history')){void run(()=>app.setDynamicPersonaPartHistorical(button.dataset.profile,button.dataset.personaHistory,button.dataset.historyValue==='true'),{name:'dynamic-persona',button});return;}
    if(button.hasAttribute('data-emphasis-save')||button.hasAttribute('data-emphasis-draft')){
      const box=button.closest('[data-people-emphasis]');if(!box)return;
      const name=box.dataset.emphasisName,lines=box.querySelector('[data-emphasis-lines]');
      if(button.hasAttribute('data-emphasis-save'))void run(()=>app.setPersonDirectives(name,lines.value.split(/\n/u)),{name:'dynamic-persona',button});
      else void run(async()=>{const result=await app.draftPersonDirectives(name,box.querySelector('[data-emphasis-ask]').value);lines.value=result.directives.join('\n');},{name:'dynamic-persona',button});
      return;
    }
    if(button.hasAttribute('data-casting-save')){
      const box=button.closest('[data-people-casting]');
      const group=groups.find(g=>g.key===selected);
      if(box&&group&&!group.ambiguous)void run(()=>app.setPersonCasting(group.name,{gender:box.querySelector('[data-casting-gender]').value,role:box.querySelector('[data-casting-role]').value,playerControlled:box.querySelector('[data-casting-player]').checked}),{name:'dynamic-persona',button});
      return;
    }
    if (button.hasAttribute('data-people-key')) {
      closeCompose();selected = button.dataset.peopleKey; draw();
      const title = $('[data-people-title]');
      title?.focus({ preventScroll: true });
      // The theatre navigation is sticky. Scrolling the title into view can
      // tuck the avatar and return button behind it on a tablet.
      const body = root.closest?.('.memo-body');
      if (body) body.scrollTop = 0;
      return;
    }
    // 字段行：第一次点整行展开，展开后点内容或「修改」才进编辑。
    if (button.dataset.peopleAdd) { addFor(button.dataset.peopleAdd, button); return; }
    if (button.hasAttribute('data-people-merge-open')) {
      const group=groups.find(g=>g.key===selected);
      const box = root.querySelector(!group?.profiles.length?'[data-people-persona-bind]':'[data-people-merge]');
      if (box) { box.open = !box.open; box.scrollIntoView({ block: 'nearest' }); }
      return;
    }
    if (button.hasAttribute('data-people-remove')) {
      const group = groups.find(g => g.key === selected);
      if (!group) return;
      const avatarScopeAtStart = avatarScope;
      void run(async () => {
        const ids = [...new Set([...group.facts, ...group.relationships, ...group.commitments, ...group.personaChanges].map(r=>r.id))];
        const keepsakes=[...group.diaries,...group.dialogues].flatMap(row=>origins(row).filter(o=>!ids.includes(o.recordId)).map(o=>({...o,kind:row.kind})));
        // Freeze the original indices and revisions BEFORE awaiting confirmation.
        // Repainting while the dialog is open must not bless old indices with new hashes.
        const deletion={scopeKey:scope,records:ids.map(id=>({id,expected:sha256(sourceCards.find(c=>c.id===id))})),keepsakes,
          profiles:(group.profileSources??group.profiles).map(p=>({id:p.id,expected:sha256(p)}))};
        if (await host.confirm?.(`删除“${group.name}”显示的关联记录与动态档案？记忆可从回收站恢复，动态档案保留旧版；心迹和台词仅移除对应字段，不删除整篇共享事件。聊天原文与原世界书不改。`) !== true) return {message:'已取消删除，人物记录保留。',level:'info'};
        const result=await app.deletePerson(deletion);
        const avatarNotice = maintainAvatar(avatarScopeAtStart, group, () => avatarStore.remove(avatarScopeAtStart, group), '人物记录已删除');
        stamp='';rendered='';
        return avatarNotice ?? result;
      }, { name: 'deletePerson', button });
      return;
    }
    if (button.dataset.peopleEdit) {
      // Read from the cached projection: the reading view never rescans cards.
      const id = button.dataset.peopleEdit;
      const all = groups.flatMap(g => [...g.relationships, ...g.commitments, ...g.personaChanges, ...g.facts]);
      const record = all.find(r => r.id === id);
      const diary = groups.flatMap(g => g.diaries).find(r => r.id === id);
      const dialogue = groups.flatMap(g => g.dialogues).find(r => r.id === id);
      if (!record && !diary && !dialogue) return;
      // Diary and dialogue text lives in innerLife/keyDialogues, so those two
      // open an inline editor; everything else opens the one record editor.
      if (diary || dialogue) { editing = editing === id ? '' : id; rendered = ''; draw(); return; }
      compose(record.category==='entityFactChanges'?'attribute':record.category,record);
      return;
    }
    // 一次点击展开，展开后点内容或「修改」进编辑；「删除」把这条移入回收站。
    if (button.hasAttribute('data-field-remove')) {
      const field = button.closest('[data-field-row]'),id=field?.dataset.fieldId??'',category=field?.dataset.fieldCategory;
      if(id)void run(async()=>{
        if(category==='dynamic-persona')return app.editDynamicPersona(id,{deleted:true});
        if(category==='diary'||category==='dialogue'){
          const row=groups.flatMap(g=>category==='diary'?g.diaries:g.dialogues).find(r=>r.id===id);
          if(!row)throw new Error('角色记录已变化，请刷新后重试');
          return app.saveCharacterKeepsake({kind:category,origins:origins(row),remove:true});
        }
        return app.deleteRecords([id]);
      }, { name: 'deleteRecord', button });
      return;
    }
    if (button.hasAttribute('data-field-edit')) {
      const row = button.closest('[data-field-row]');
      const id = row?.dataset.fieldId ?? '';
      const category = row?.dataset.fieldCategory ?? '';
      if (!id) return;
      if (category === 'diary' || category === 'dialogue') { editing = id; rendered = ''; draw(); return; }
      openFieldEditor(row);
      return;
    }
    if (button.hasAttribute('data-person-editor-close')) { editing = ''; rendered = ''; draw(); return; }
    if (button.dataset.personKeepSave) {
      const id = button.dataset.personKeepSave;
      const diary = groups.flatMap(g => g.diaries).find(r => r.id === id);
      const dialogue = groups.flatMap(g => g.dialogues).find(r => r.id === id);
      const row = diary ?? dialogue;
      const box = root.querySelector(`[data-person-editor="${id}"]`);
      if (!row || !box) return;
      const data = { ...row.data };
      for (const field of box.querySelectorAll('[data-keep-field]')) data[field.dataset.keepField] = field.value;
      void run(() => app.saveCharacterKeepsake({ kind: diary ? 'diary' : 'dialogue', origins: origins(row), data }), { name: 'journal-write', button })
        .then(() => { editing = ''; rendered = ''; });
      return;
    }
    if (button.hasAttribute('data-people-rename')||button.hasAttribute('data-people-save-name')) {
      const group = groups.find(g => g.key === selected);
      if (!group || group.ambiguous) return;
      const avatarScopeAtStart = avatarScope;
      const scopeAtStart = scope;
      void run(async () => {
        const next = button.hasAttribute('data-people-save-name')?$('[data-people-name]').value:await host.prompt?.('改成什么名字？旧名会保留为别称，已有记录仍归到这个角色。', group.name);
        const name = String(next ?? '').trim();
        if (!name || name === group.name) return;
        const profile = group.profiles[0];
        if (profile?.id) await app.editDynamicPersona?.(profile.id, { name, aliases: [...new Set([...(profile.aliases ?? []), group.name])] });
        await app.saveDictionaryEntry?.({ name, aliases: [group.name], indexWords: [] });
        const saved = app.state;
        if (JSON.stringify(saved.scope ?? saved.core?.scope ?? null) !== scopeAtStart) throw new Error('聊天已切换，未调整另一个聊天的人物头像');
        const savedGroup = peopleGroups(saved).find(person => person.name === name && (!profile?.id || person.profileSources.some(p => p.id === profile.id)));
        if (!savedGroup) throw new Error('保存后的人物姓名尚未更新，原头像保留，请刷新人物页后重试');
        const avatarNotice = maintainAvatar(avatarScopeAtStart, group, () => avatarStore.rename(avatarScopeAtStart, group, name), '人物名称已保存');
        const nameInput=$('[data-people-name]');if(nameInput?.value===name)delete nameInput.dataset.peopleDirty;
        selected = savedGroup.key; stamp = ''; rendered = ''; paint(saved);
        return avatarNotice ?? undefined;
      }, { name: 'save-dictionary-entry', button });
      return;
    }
    if (button.dataset.peoplePageLink) { setPage?.(button.dataset.peoplePageLink); return; }
    if (button.dataset.peopleAll) { onSelect?.({ name: '', profileId: null, kind: button.dataset.peopleAll }); return; }
    if (button.hasAttribute('data-people-persona-bind-commit')) {
      const group = groups.find(g => g.key === selected);
      const targetId = root.querySelector('[data-people-persona-bind-target]')?.value;
      const profiles = groups.flatMap(g => g.profiles);
      const memoryTarget=String(targetId??'').startsWith('person:')?groups.find(g=>g.key===targetId.slice(7)&&!g.ambiguous&&!g.profiles.length):null;
      const target = profiles.find(p => p.id === targetId)??memoryTarget;
      if (!group || !group.ambiguous && group.profiles.length || !group.name || !target) return;
      void run(async () => {
        if (await host.confirm?.(`将称呼“${group.name}”归入“${target.name}”？若已有同名正式档案会一并合并；原文、原世界书和来源记录不改。`) !== true) return;
        if(memoryTarget)return app.saveDictionaryEntry({name:target.name,aliases:[...new Set([...target.aliases,group.name,...group.aliases])],indexWords:target.indexWords});
        return app.bindDynamicPersona?.(group.name, target.id)
          ?? app.editDynamicPersona(target.id, { aliases: [...(target.aliases ?? []), group.name] });
      }, { name: 'dynamic-persona', button });
      return;
    }
    if (button.hasAttribute('data-people-merge-commit')) {
      const source = groups.find(g=>g.key===selected)?.profiles[0]?.id;
      const target = root.querySelector('[data-people-merge-target-select]')?.value;
      const profiles = groups.flatMap(g => g.profiles), sourceProfile = profiles.find(p => p.id === source), targetProfile = profiles.find(p => p.id === target);
      if (!sourceProfile || !targetProfile || source === target) return;
      const avatarScopeAtStart = avatarScope;
      const mergeScope = scope;
      void run(async () => {
        if (await host.confirm?.(`将“${sourceProfile.name}”并入“${targetProfile.name}”？原档案会保留在可恢复版本中。`) !== true) return;
        if(scope!==mergeScope)throw new Error('聊天已切换，请重新选择合并人物');
        selected = groups.find(g => g.profiles.some(p => p.id === target))?.key ?? selected;
        const sourceGroup = groups.find(g => g.profiles.some(p => p.id === source));
        const targetGroup = groups.find(g => g.profiles.some(p => p.id === target));
        const result = await app.mergeDynamicPersona(source, target);
        if(scope!==mergeScope)throw new Error('聊天已切换，未改动另一个聊天的姓名关系');
        await app.saveDictionaryEntry?.({originalName:sourceProfile.name,name:targetProfile.name,aliases:[...new Set([...(targetGroup?.aliases??[]),...(targetProfile.aliases??[]),sourceProfile.name,...(sourceGroup?.aliases??[]),...(sourceProfile.aliases??[])])],indexWords:[]});
        const avatarNotice = sourceGroup && targetGroup ? maintainAvatar(avatarScopeAtStart, sourceGroup, () => avatarStore.merge(avatarScopeAtStart, sourceGroup, targetGroup), '人物档案已合并') : null;
        return avatarNotice ?? result;
      }, { name: 'dynamic-persona', button });
      return;
    }
    if (button.dataset.peopleOpen) {
      const group = groups.find(g => g.key === selected);
      // A profile-specific link is safe even when another unresolved record
      // shares its nickname; only broad record navigation stays disabled.
      if (group && (!group.ambiguous || button.dataset.peopleProfile)) onSelect?.({ name: group.name, profileId: button.dataset.peopleProfile || null, kind: button.dataset.peopleOpen });
    }
  });
  root.addEventListener('error', event => {
    const image = event.target;
    if (image?.tagName !== 'IMG' || !image.closest?.('.memo-person-avatar')) return;
    image.hidden = true;
    const initial = image.parentElement?.querySelector('span');
    if (initial) initial.hidden = false;
  }, true);
  return { paint, dispose: () => avatarStore.dispose?.() };
}
