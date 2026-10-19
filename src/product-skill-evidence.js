import { estimateUnits } from './utils.js';
import { tokenizeChinese } from './retrieval.js';
import { foldName } from './name-fold.js';
import { explicitSubjectNames, factSubject, factValue } from './product-person-profiles.js';

export const SKILL_RECORDING_RULE = '习得依据沿用人物属性与事件，不另建技能表：正文明确交代的技能、职业、师承、学习与练习经历，分别记入 entityFactChanges 的适当 field/to 和 events，并保留实际 sourceRefs；能关联时沿用 eventRef/eventRefs。保留初学、练习、已掌握、失败、计划及角色自称的区别与条件，不把“准备学习”“自称会”改成已掌握，不为补字段编造经历。新技能需要有学习过程，天才可以加快学习；卡面或已确立剧情中已有的能力不要求每次重新学习。明确的现代知识、超凡能力等遵从原设定，不以时代或术语关键词否定。';

export const SKILL_EVIDENCE_GUIDANCE = '[习得依据补充：只供本轮续写参照]\n先核对本次请求中的有效玩家卡面、当前正文与下列已有记录。明确已有的能力正常使用，不每次重练；新技能需有学习过程，天赋可加快观察、纠错与练习，不豁免学习；不同领域分别有依据，身体天赋不自动等于技艺，认知知识不统一套用身体技能的练习阶段。明确的现代知识或超凡设定从其设定。记录中涉及玩家只证明相关，不证明已经学会；计划、自称、尝试、失败与否定及其条件保持原意，由续写模型结合上下文判断，不输出审查或思考过程。本轮仅复用已有候选与已选人物属性，未提供完整依据；无命中或省略不等于不会，不据此判定从未习得。资料库的设定、NPC的技能与经历不能自动变成玩家已习得。';

const MAX_CANDIDATES = 48;
const MAX_RECORDS = 4;
const MAX_UNITS = 900;
const stopTopics = /^(?:什么|怎么|怎样|如何|是否|现在|这次|这项|那个|这个|一下|继续|然后|已经|使用|施展|掌握|学会|学过|可以|能否|有关|关于|以及|他们|她们|我们|你们|自己的|自己)$/u;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value) ? value : null;
const sourceBacked = record => Array.isArray(record.sourceRefs) && record.sourceRefs.length > 0 && record.sourceRefs.every(ref => typeof ref?.sourceId === 'string' && ref.sourceId.trim());
const visible = record => record.customInject !== false && record.disabled !== true && record.deleted !== true && !['retracted', 'superseded'].includes(record.lifecycleState);
const unwrap = item => item?.record ?? item;

function relevantText(record) {
  const values = record.category === 'entityFactChanges'
    ? [record.field, record.key, record.fieldLabel, factValue(record), record.description, record.recallSummary]
    : [record.title, record.description, record.recallSummary, record.action, record.object, record.content, record.text];
  return foldName(values.filter(value => value !== undefined && value !== null).map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n'));
}

function oversizedRenderInput(record, remainingUnits) {
  // A long field would otherwise be normalized and rendered before being
  // rejected. Ordinary descriptions already contain their typed fact value.
  // Bound this preflight's own normalization work for oversized DIY strings.
  const body = record.description ?? (record.category === 'entityFactChanges' ? factValue(record) : record.content ?? record.text);
  if (typeof body !== 'string') return false;
  return body.length > MAX_UNITS * 8 || estimateUnits(body) > remainingUnits;
}

/** A bounded projection over an existing ranked pool, never a second search.
 * aliases must already be unambiguous in the caller's current dictionary.
 * Ownership and topic overlap establish relevance, not learning or mastery.
 * The supplied renderer owns the existing provenance/condition presentation.
 */
export function skillEvidencePacket({ playerName = '', query = '', candidates = [], currentAttributes = [], aliases = [], render, budgetUnits = MAX_UNITS } = {}) {
  const requested = typeof budgetUnits === 'number' && Number.isFinite(budgetUnits) ? Math.floor(budgetUnits) : MAX_UNITS;
  const budget = Math.max(0, Math.min(MAX_UNITS, requested));
  const trace = { mode: 'existing_candidates', budgetUnits: budget, units: 0, candidatesExamined: 0, currentAttributesExamined: 0, selectedCount: 0, selectedIds: [], omittedBudget: 0, rejectedOwner: 0, rejectedSource: 0, rejectedTopic: 0, rejectedCategory: 0, rejectedVisibility: 0, renderFailed: 0, budgetInsufficient: false, extraModelCalls: 0, extraVectorCalls: 0, extraIndexQueries: 0 };
  const records = [];
  let text = '';
  if (estimateUnits(SKILL_EVIDENCE_GUIDANCE) > budget) {
    trace.budgetInsufficient = true;
    return { text, trace, records };
  }
  text = SKILL_EVIDENCE_GUIDANCE;
  const player = typeof playerName === 'string' ? foldName(playerName.trim()) : '';
  const names = player ? new Set([player, ...(Array.isArray(aliases) ? aliases : []).filter(alias => typeof alias === 'string' && alias.trim()).map(alias => foldName(alias.trim()))]) : new Set();
  let topicQuery = foldName(typeof query === 'string' ? query : '');
  for (const name of [...names].sort((a, b) => b.length - a.length)) topicQuery = topicQuery.split(name).join(' ');
  const topics = [...new Set(tokenizeChinese(topicQuery).filter(term => [...term].length >= 2 && !stopTopics.test(term)))];
  const seen = new Set();
  const tryRecord = item => {
    const record = unwrap(item);
    if (!record || typeof record !== 'object') { trace.rejectedCategory++; return; }
    if (!['events', 'entityFactChanges'].includes(record.category)) { trace.rejectedCategory++; return; }
    if (!visible(record)) { trace.rejectedVisibility++; return; }
    const owners = record.category === 'events'
      ? explicitSubjectNames(record.participants)
      : explicitSubjectNames(factSubject(record));
    if (!owners.some(owner => names.has(foldName(owner.trim())))) { trace.rejectedOwner++; return; }
    if (!sourceBacked(record)) { trace.rejectedSource++; return; }
    if (oversizedRenderInput(record, budget - estimateUnits(text))) { trace.omittedBudget++; return; }
    const topical = relevantText(record);
    if (!topics.some(topic => topical.includes(topic))) { trace.rejectedTopic++; return; }
    const key = typeof record.id === 'string' && record.id ? record.id : record;
    if (seen.has(key)) return;
    seen.add(key);
    let body;
    try { body = typeof render === 'function' ? render(record) : ''; }
    catch { trace.renderFailed++; return; }
    if (typeof body !== 'string' || !body.trim()) { trace.renderFailed++; return; }
    const trial = `${text}\n\n${body}`;
    if (estimateUnits(trial) > budget) { trace.omittedBudget++; return; }
    text = trial;
    records.push(record);
  };
  if (names.size && topics.length) {
    if (Array.isArray(currentAttributes)) for (let i = 0; i < Math.min(MAX_CANDIDATES, currentAttributes.length) && records.length < MAX_RECORDS; i++) {
      trace.currentAttributesExamined++;
      tryRecord(currentAttributes[i]);
    }
    if (Array.isArray(candidates)) for (let i = 0; i < Math.min(MAX_CANDIDATES, candidates.length) && records.length < MAX_RECORDS; i++) {
      trace.candidatesExamined++;
      tryRecord(candidates[i]);
    }
  }
  trace.units = estimateUnits(text);
  trace.selectedCount = records.length;
  trace.selectedIds = records.map(record => safeId(record.id)).filter(Boolean);
  return { text, trace, records };
}
