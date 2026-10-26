import { autoSummaryPlan, summaryProgress, hasNewerSavedCoverage } from '../src/product-auto-summary.js';
import { currentPersonaProfiles } from '../src/dynamic-persona.js';
import { recordTitle, sourceFloors } from '../src/product-narrative.js';

export const UI_PRODUCT_LABEL = 'Memo';

const validFloor = value => Number.isSafeInteger(value) && value >= 0;
const itemsOf = value => Array.isArray(value) ? value : [];
const isFailure = row => ['failed', 'interrupted'].includes(row?.status);
const isPending = row => ['queued', 'pending', 'running', 'staged'].includes(row?.status);
const unfinished = plan => ['running', 'paused', 'failed'].includes(plan?.status);
const phaseLabels = {
  preparing: '正在准备', queued: '正在等待接口', waiting: '等待模型答复',
  composing: '正在生成总结', validating: '正在检查与整理', saving: '正在保存', running: '正在进行',
};
const esc = text => String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const excerpt = (text, limit = 260) => {
  const value = typeof text === 'string' ? text.trim() : '';
  return value.length > limit ? value.slice(0, limit).trimEnd() + '…' : value;
};
const range = row => validFloor(row?.startIndex) && validFloor(row?.endIndex) && row.endIndex >= row.startIndex
  ? row.startIndex + '–' + row.endIndex + ' 楼' : '';
const countProgress = (done, total) => Number.isSafeInteger(done) && done >= 0 && Number.isSafeInteger(total) && total > 0 && done <= total
  ? { value: done, max: total, percent: Math.round(done / total * 100) } : null;

// Formal saved coverage is independent of the currently running task. A saved
// manual candidate must never extend the range of the applied dossier.
function savedProgress(rows, { startFloor, lastIndex, batchSize, keepRecent, advanceFromLatest=false }) {
  const saved = rows.filter(row => row.status !== 'deleted' && (row.status === 'saved' || row.savedOperationId));
  let observed = validFloor(lastIndex) ? lastIndex : 0;
  if (!validFloor(lastIndex)) for (const row of (advanceFromLatest?rows:saved)) if (validFloor(row.endIndex)) observed = Math.max(observed, row.endIndex);
  return summaryProgress(rows, {advanceFromLatest,
    startFloor: validFloor(startFloor) ? startFloor : 1,
    lastIndex: observed,
    batchSize: Number.isSafeInteger(batchSize) && batchSize > 0 ? batchSize : 10,
    keepRecent: validFloor(keepRecent) ? keepRecent : 0,
  });
}
function coverageText(progress, empty, prefix) {
  if (!progress.ranges.length) return empty;
  const first = progress.ranges[0];
  return progress.ranges.length === 1
    ? prefix + ' ' + first.startIndex + '–' + first.endIndex + ' 楼'
    : prefix + ' ' + progress.covered + ' 楼 · ' + progress.ranges.length + ' 段';
}
function candidatePlan(persona) {
  if (unfinished(persona.manualPlan)) return { plan: persona.manualPlan, kind: 'rebuild' };
  const review = persona.refinement?.manualPlan;
  if (unfinished(review) || review?.status === 'ready') return { plan: review, kind: 'refinement' };
  return null;
}
function candidateProjection(persona) {
  const candidate = candidatePlan(persona);
  if (!candidate) return null;
  const items = itemsOf(candidate.plan.items).filter(row => row.status !== 'deleted');
  const saved = items.filter(row => row.status === 'saved');
  return {
    ...candidate, items, saved,
    progress: countProgress(saved.length, items.length),
    failures: items.filter(isFailure).length,
    current: items.find(row => row.status === 'running') ?? items.find(row => row.status !== 'saved'),
    text: (candidate.kind === 'refinement' ? '精修候选' : '重建候选') + ' ' + saved.length + '/' + items.length + ' 批已生成 · 尚未应用',
  };
}
function automaticMemoryText(settings, monitor) {
  if (!settings.autoSummaryEnabled) return '自动总结未开启';
  const reason = monitor?.automatic?.reason;
  if (reason === 'summary_hold') return '自动接续已暂停';
  if (reason === 'manual_plan') return '自动接续等待手动计划';
  if (['retry_exhausted', 'history_unavailable', 'api_unconfigured', 'focus_required'].includes(reason)) return '自动总结等待处理';
  return '自动总结已开启';
}
function channelHTML(kind, title) {
  return '<article class="memo-home-channel" data-home-workflow="' + kind + '" data-hybrid-workflow="' + kind + '">' +
    '<div class="memo-home-channel-heading"><h3>'+title+'</h3><button type="button" class="memo-home-sync" data-home-sync="'+kind+'">同步</button><button type="button" data-home-enable="'+kind+'" aria-pressed="false" class="memo-home-enable">启动</button></div><span class="memo-home-state" data-home-state="'+kind+'">尚未读取</span>' +
    '<div class="memo-home-channel-numbers"><strong data-home-range="' + kind + '">尚无当前批次</strong><span class="memo-home-percent" data-home-percent="' + kind + '">—</span></div>' +
    '<div class="memo-home-progress" data-home-progress="' + kind + '" role="progressbar" aria-label="' + title + '当前任务进度" aria-valuetext="尚无当前任务"><span class="memo-home-progress-fill"></span></div>' +
    '<div class="memo-home-channel-phase"><span data-home-progress-label="' + kind + '">本次生成进度</span><span data-home-phase="' + kind + '">尚未开始</span></div>' +
    '<p class="memo-home-coverage" data-home-coverage="' + kind + '">尚无正式结果</p>' +
    '<p class="memo-home-channel-note" data-home-note="' + kind + '"></p>' +
    '<div class="memo-home-channel-actions"><button type="button" data-home-batches="' + kind + '">批次管理</button><button type="button" data-home-automatic="' + kind + '">自动更新</button><button type="button" data-home-manual="' + kind + '">手动更新</button><button type="button" data-home-stop="' + kind + '" title="强制停止当前任务，保留已保存结果">强制停止</button></div><small class="memo-home-auto-note" data-home-auto="' + kind + '"></small>' +
    '</article>';
}

export function phoneHomeHTML() {
  return '<section data-view="home" class="memo-phone-home memo-home-workbench" aria-label="'+UI_PRODUCT_LABEL+'总览">'+
    '<p class="memo-home-chat-state" data-home-chat-state>打开聊天后查看当前工作台。</p>'+
    '<div class="memo-home-workspace"><section class="memo-home-channels" aria-label="当前任务">'+
    channelHTML('memory','记忆整理')+channelHTML('persona','动态人设')+'</section></div>'+
    '</section>';
}

// Only bounded recent rows supplied by the existing memory projection are read.
// The home never consumes cards/records, reads a worldbook or dispatches work.
export function paintPhoneHome(panel, s = {}) {
  const home = panel.querySelector('[data-view="home"]');
  if (!home) return;
  const find = selector => home.querySelector(selector);
  const write = (selector, value) => {
    const node = find(selector);
    if (node && node.textContent !== value) node.textContent = value;
  };
  const settings = s.settings ?? {}, persona = s.dynamicPersona ?? {}, monitor = s.taskMonitor ?? {};
  const allMemoryRows = itemsOf(s.batches);
  const memoryRows = allMemoryRows.filter(row => row && row.status !== 'deleted' && (row.status === 'saved' || !hasNewerSavedCoverage(row, allMemoryRows)));
  const personaRows = itemsOf(persona.batches).filter(row => row && row.status !== 'deleted');
  const memory = savedProgress(allMemoryRows, {advanceFromLatest:true, startFloor: s.autoStartFloor, lastIndex: s.autoLastIndex, batchSize: settings.autoSummaryEvery, keepRecent: settings.autoKeepRecent });
  const formal = savedProgress(personaRows, { startFloor: persona.startFloor, lastIndex: persona.lastIndex, batchSize: settings.dynamicPersonaEvery, keepRecent: settings.dynamicPersonaKeepRecent });
  const candidate = candidateProjection(persona);
  const memoryFailures = memoryRows.filter(isFailure).length;
  const personaFailures = personaRows.filter(isFailure).length + (candidate?.failures ?? 0);
  const memoryTask = monitor.current?.kind === 'summary' ? monitor.current : null;
  const personaTask = monitor.current?.kind === 'persona' ? monitor.current : null;
  const memoryBusy = Boolean(memoryTask || s.autoRunning);
  const personaBusy = Boolean(persona.busy || personaTask);
  const memoryRow = memoryRows.find(row => row.status === 'running') ?? memoryRows.find(row => isFailure(row) || isPending(row));
  let memoryRange = range(memoryTask) || range(memoryRow);
  // Use the application's source-validated plan when available. This is a
  // projection only: the scheduler still owns readiness and all dispatch gates.
  const nextMemory = s.automatic ?? autoSummaryPlan(allMemoryRows, {advanceFromLatest:true,
    startFloor: s.autoStartFloor ?? 1, lastIndex: s.autoLastIndex ?? null,
    batchSize: settings.autoSummaryEvery ?? 20, keepRecent: settings.autoKeepRecent ?? 0,
  });
  if(!memoryBusy&&memoryRow&&validFloor(nextMemory.nextStart)&&(nextMemory.nextStart<memoryRow.startIndex||nextMemory.nextStart>memoryRow.endIndex))memoryRange='';
  const waitingMemory = s.chatReady && !memoryBusy && !memoryRange && validFloor(nextMemory.lastIndex);
  const nextSize = nextMemory.nextEnd - nextMemory.nextStart + 1;
  const accumulated = Math.max(0, Math.min(nextSize, nextMemory.eligibleEnd - nextMemory.nextStart + 1));
  const remaining = Math.max(0, nextMemory.nextEnd + nextMemory.keepRecent - nextMemory.lastIndex);
  const personaRange = range(candidate?.current) || range(candidate?.plan) || (personaBusy ? range({ startIndex: persona.plan?.nextStart, endIndex: persona.plan?.nextEnd }) : '');
  const memoryProgress = memoryTask ? countProgress(memoryTask.completedBatches, memoryTask.totalBatches) : null;
  const personaProgress = candidate?.progress ?? null;
  const memoryState = memoryBusy ? '运行中' : memoryFailures ? memoryFailures + ' 批未完成' : memoryRows.some(isPending) ? '有待处理批次' : '当前空闲';
  const personaState = personaBusy ? '运行中' : personaFailures ? personaFailures + ' 批未完成' : candidate ? candidate.saved.length ? '候选尚未应用' : candidate.plan.status === 'paused' ? '计划已暂停' : '计划未完成' : persona.paused ? '已暂停' : '当前空闲';

  write('[data-home-chat-state]', s.chatReady ? '当前聊天 · 已连接' : '打开聊天后查看当前工作台。');
  const workflows = [
    {
      kind: 'memory', state: memoryState, busy: memoryBusy, failures: memoryFailures, progress: memoryProgress,
      range: memoryRange || (waitingMemory ? range({ startIndex: nextMemory.nextStart, endIndex: nextMemory.nextEnd }) : '尚无当前批次'),
      phase: memoryBusy ? phaseLabels[memoryTask?.phase] ?? '正在整理' : waitingMemory ? remaining ? '还差 ' + remaining + ' 楼凑满一批' : '已凑满一批' : memoryFailures ? '可到任务中重试或处理' : '等待下一批任务',
      coverage: coverageText(memory, '尚无已处理批次', '已处理'),
      note: memoryBusy ? '当前批次保存后，才会计入已保存范围。' : memoryFailures ? '已保存记忆保留，未完成批次单独处理。' : waitingMemory ? '下一批 ' + nextMemory.nextStart + '–' + nextMemory.nextEnd + ' 楼 · 已凑 ' + accumulated + '/' + nextSize + ' 楼 · 最近 ' + nextMemory.keepRecent + ' 楼保留原文' : '',
      automatic: automaticMemoryText(settings, monitor), progressLabel: waitingMemory ? '下一批 · 已凑 ' + accumulated + '/' + nextSize + ' 楼' : '本次生成进度',
    },
    {
      kind: 'persona', state: personaState, busy: personaBusy, failures: personaFailures, progress: personaProgress,
      range: personaRange || '尚无当前批次',
      phase: candidate ? candidate.text : personaBusy ? phaseLabels[personaTask?.phase] ?? '正在更新档案' : personaFailures ? '原档案保留，可查看未完成批次' : '等待下一批任务',
      coverage: coverageText(formal, '尚无已应用人物批次', '已应用'),
      note: candidate?.saved.length ? '本次候选尚未应用，当前继续使用正式档案。' : personaBusy ? '正常更新完成后自动保存；正式档案与候选分别显示。' : '',
      automatic: !settings.dynamicPersonaEnabled ? '自动人设未开启' : persona.paused ? '自动接续已暂停' : '自动人设已开启',
      progressLabel: candidate ? '本次候选生成进度' : '本次生成进度',
    },
  ];
  for (const item of workflows) {
    const kind = item.kind;
    for (const [field, value] of Object.entries({ state: item.state, range: item.range, phase: item.phase, coverage: item.coverage, note: item.note, auto: item.automatic, 'progress-label': item.progressLabel })) write('[data-home-' + field + '="' + kind + '"]', value);
    write('[data-home-percent="' + kind + '"]', item.progress ? item.progress.percent + '%' : item.busy ? '进行中' : '—');
    const bar = find('[data-home-progress="' + kind + '"]');
    if (bar) {
      bar.dataset.indeterminate = String(item.busy && !item.progress);
      bar.dataset.progressState = item.progress ? 'measured' : item.busy ? 'running' : 'idle';
      bar.style?.setProperty('--progress', item.progress ? item.progress.percent + '%' : '0%');
      if (item.progress) {
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', String(item.progress.max));
        bar.setAttribute('aria-valuenow', String(item.progress.value));
        bar.setAttribute('aria-valuetext', item.progress.value + '/' + item.progress.max + ' 批已保存' + (kind === 'persona' && candidate ? '，候选尚未应用' : ''));
      } else {
        for (const attr of ['aria-valuenow', 'aria-valuemin', 'aria-valuemax']) bar.removeAttribute?.(attr);
        bar.setAttribute('aria-valuetext', item.busy ? item.phase + '，暂无可计算的批次进度' : '当前没有可计算的任务进度');
      }
    }
    const enable=find('[data-home-enable="'+kind+'"]');if(enable){const enabled=Boolean(settings[kind==='memory'?'autoSummaryEnabled':'dynamicPersonaEnabled']);enable.textContent=enabled?'关闭':'启动';enable.setAttribute('aria-pressed',String(enabled));enable.dataset.enabled=String(enabled);}
    const sync=find('[data-home-sync="'+kind+'"]');if(sync)sync.disabled=!s.chatReady||item.busy;
    const automatic=find('[data-home-automatic="'+kind+'"]');if(automatic){automatic.textContent='自动更新';automatic.title=item.automatic+'；在设置中调整';automatic.disabled=false;}
    const channel = find('[data-home-workflow="' + kind + '"]');
    if (channel) { channel.dataset.attention = String(item.failures > 0); channel.dataset.busy = String(item.busy); }
  }


}
