// Main-memory progress can explicitly advance across skipped history; persona
// keeps the legacy cumulative contract unless its caller opts in.
export function summaryFrontier(batches=[],startFloor=1){
 return batches.filter(b=>!b.replacedBy&&!b.splitInto?.length&&b.retiredReason!=='sync_incomplete_tail'&&(!b.replacement||b.status==='saved')&&['saved','failed','skipped','deleted'].includes(b.status)&&Number.isSafeInteger(b.startIndex)&&Number.isSafeInteger(b.endIndex)&&b.endIndex>=b.startIndex).reduce((next,b)=>Math.max(next,b.endIndex+1),startFloor);
}
export function autoSummaryPlan(batches=[],options={}){
 const legacy=legacyAutoSummaryPlan(batches,options);if(!options.advanceFromLatest)return legacy;
 const next=summaryFrontier(batches,legacy.startFloor),end=next+legacy.batchSize-1,coverage=summaryCoverage(batches,{...options,advanceFromLatest:true});
 return {...legacy,coveredThrough:next-1,nextStart:next,nextEnd:end,ready:legacy.lastIndex!==null&&end<=legacy.eligibleEnd,completedBatches:batches.filter(b=>b.status==='saved'&&b.endIndex<next).length,pendingBatches:legacy.lastIndex===null?null:coverage.missingRanges.reduce((n,r)=>n+Math.floor((r.endIndex-r.startIndex+1)/legacy.batchSize),0),coverage};
}
// Absolute host floors, not turns or batchNumber * the current batch size.
export function hasNewerSavedCoverage(batch,batches){
  return !batch.replacement&&Number.isFinite(batch.updatedAt)&&batches.some(saved=>saved.id!==batch.id&&saved.status==='saved'&&saved.updatedAt>batch.updatedAt&&saved.startIndex<=batch.startIndex&&saved.endIndex>=batch.endIndex);
}
function legacyAutoSummaryPlan(batches=[],{startFloor=1,batchSize=10,keepRecent=2,lastIndex=null}={}){
  if(!Number.isSafeInteger(startFloor)||startFloor<0||!Number.isSafeInteger(batchSize)||batchSize<1||!Number.isSafeInteger(keepRecent)||keepRecent<0)throw new Error('自动总结的起点、每批楼数和保留楼数无效');
  // Ordering contract: the cursor only advances over SAVED batches, and the
  // first unsaved batch (failed/interrupted/queued/staged) blocks everything
  // after it. Cumulative batches build on their predecessors, so a middle
  // failure must be retried in place — skipping it and continuing later
  // produced out-of-order commits and revision conflicts.
  const rows=batches.filter(b=>b.status!=='deleted'&&Number.isSafeInteger(b.startIndex)&&Number.isSafeInteger(b.endIndex)&&b.endIndex>=startFloor&&(b.status==='saved'||!hasNewerSavedCoverage(b,batches))).sort((a,b)=>a.startIndex-b.startIndex||a.endIndex-b.endIndex);
  const ranges=rows.filter(b=>b.status==='saved');
  let next=startFloor;
  for(const b of rows){
    if(b.startIndex>next)break;
    if(b.status!=='saved'){next=Math.max(startFloor,Math.min(next,b.startIndex));break;}
    if(b.endIndex>=next)next=b.endIndex+1;
  }
  const following=ranges.find(b=>b.startIndex>next),end=Math.min(next+batchSize-1,following?following.startIndex-1:Infinity),known=Number.isSafeInteger(lastIndex),eligibleEnd=known?lastIndex-keepRecent:null;
  const coverage=summaryCoverage(batches,{startFloor,lastIndex,keepRecent,batchSize});
  return {startFloor,coveredThrough:next-1,nextStart:next,nextEnd:end,batchSize,keepRecent,lastIndex:known?lastIndex:null,
    completedBatches:ranges.filter(b=>b.endIndex>=startFloor&&b.endIndex<next).length,
    eligibleEnd,ready:known&&end<=eligibleEnd,pendingBatches:known?coverage.missingRanges.reduce((n,r)=>n+Math.floor((r.endIndex-r.startIndex+1)/batchSize),0):null,coverage};
}
/** Interval subtraction, not a per-floor scan: later saved batches do not hide gaps. */
export function summaryCoverage(batches=[],{startFloor=1,lastIndex=null,keepRecent=2,batchSize=10,advanceFromLatest=false}={}){  if(!Number.isSafeInteger(startFloor)||startFloor<0||!Number.isSafeInteger(keepRecent)||keepRecent<0||!Number.isSafeInteger(batchSize)||batchSize<1)throw new Error('补采楼层设置无效');
  if(advanceFromLatest){
    const actual=summaryCoverage(batches,{startFloor,lastIndex,keepRecent,batchSize}),frontier=summaryFrontier(batches,startFloor),end=actual.eligibleEnd;
    if(end===null||end<startFloor)return actual;
    const through=Math.min(end,frontier-1),coveredFloors=Math.max(0,through-startFloor+1),missingFloors=Math.max(0,end-Math.max(startFloor,frontier)+1);
    return {...actual,recordedFloors:actual.coveredFloors,skippedFloors:Math.max(0,coveredFloors-actual.coveredFloors),coveredRanges:coveredFloors?[{startIndex:startFloor,endIndex:through}]:[],coveredFloors,missingRanges:missingFloors?[{startIndex:Math.max(startFloor,frontier),endIndex:end}]:[],missingFloors,catchUpBatches:Math.ceil(missingFloors/batchSize)};
  }
  const eligibleEnd=Number.isSafeInteger(lastIndex)?lastIndex-keepRecent:null,coveredRanges=[],missingRanges=[];
  if(eligibleEnd!==null&&eligibleEnd>=startFloor){
    const sorted=batches.filter(b=>b.status!=='deleted'&&(b.status==='saved'||b.savedOperationId)&&Number.isSafeInteger(b.startIndex)&&Number.isSafeInteger(b.endIndex)&&b.endIndex>=b.startIndex).map(b=>({startIndex:Math.max(startFloor,b.startIndex),endIndex:Math.min(eligibleEnd,b.endIndex)})).filter(b=>b.startIndex<=b.endIndex).sort((a,b)=>a.startIndex-b.startIndex);
    for(const r of sorted){const last=coveredRanges.at(-1);if(last&&r.startIndex<=last.endIndex+1)last.endIndex=Math.max(last.endIndex,r.endIndex);else coveredRanges.push({...r});}
    let cursor=startFloor;for(const r of coveredRanges){if(cursor<r.startIndex)missingRanges.push({startIndex:cursor,endIndex:r.startIndex-1});cursor=r.endIndex+1;}if(cursor<=eligibleEnd)missingRanges.push({startIndex:cursor,endIndex:eligibleEnd});
  }
  const floors=rs=>rs.reduce((n,r)=>n+r.endIndex-r.startIndex+1,0);
  return {eligibleEnd,coveredRanges,missingRanges,coveredFloors:floors(coveredRanges),missingFloors:floors(missingRanges),catchUpBatches:missingRanges.reduce((n,r)=>n+Math.ceil((r.endIndex-r.startIndex+1)/batchSize),0)};
}
/** 起算楼层只向前推进，并且只跨过「已保存批次真正覆盖」的连续楼层。
 * 补缺口保存后调用：下一次周期就不会再重复规划这些楼层，设置页显示的起算点
 * 也就是真实的记录进度。只返回新值，不改任何存储。 */
export function advancedStartFloor(coverage,startFloor=1){
  if(!Number.isSafeInteger(startFloor)||startFloor<0)throw new Error('起算楼层无效');
  const next=(coverage?.coveredRanges??[]).reduce((value,range)=>range.startIndex<=value?Math.max(value,range.endIndex+1):value,startFloor);
  return next>startFloor?next:null;
}
export function missingSummaryRanges(coverage,batchSize,{fullBatchesOnly=false}={}){
  if(!Number.isSafeInteger(batchSize)||batchSize<1)throw new Error('每批楼数无效');
  return coverage.missingRanges.flatMap(r=>Array.from({length:(fullBatchesOnly?Math.floor:Math.ceil)((r.endIndex-r.startIndex+1)/batchSize)},(_,i)=>({startIndex:r.startIndex+i*batchSize,endIndex:Math.min(r.endIndex,r.startIndex+(i+1)*batchSize-1)})));
}
// Old sync plans included a short final row. Retire only unstarted empty work;
// replies, attempted work and explicit replacement plans keep their identity.
export function retireIncompleteSyncTails(rows,coverage,batchSize){
  const tails=coverage.missingRanges.flatMap(range=>{
    const startIndex=range.startIndex+Math.floor((range.endIndex-range.startIndex+1)/batchSize)*batchSize;
    return startIndex<=range.endIndex?[{startIndex,endIndex:range.endIndex}]:[];
  });
  return rows.map(row=>row.status==='queued'&&row.freshStart&&!row.operationId&&!row.previousOperation&&!row.savedOperationId&&!row.replacement&&!row.attempts?.length&&
    tails.some(t=>row.startIndex>=t.startIndex&&row.endIndex<=t.endIndex)
    ?{...row,status:'deleted',retiredReason:'sync_incomplete_tail'}:row);
}
// Display history independently from the moving automatic cursor. Saved floors
// within keepRecent still count once; reserved unsaved floors are not failures.
export function summaryProgress(batches=[],options={}){
  const saved=batches.filter(b=>Number.isSafeInteger(b.startIndex)&&(options.advanceFromLatest?summaryFrontier([b],0)>0:b.status!=='deleted'&&(b.status==='saved'||b.savedOperationId)));
  const startFloor=Math.min(options.startFloor??1,...saved.map(b=>b.startIndex));
  const all=summaryCoverage(batches,{...options,startFloor,keepRecent:0});
  const eligible=summaryCoverage(batches,{...options,startFloor});
  const total=Number.isSafeInteger(options.lastIndex)?Math.max(0,options.lastIndex-startFloor+1):0;
  const covered=all.coveredFloors,missing=eligible.missingFloors,skipped=Math.max(0,total-covered-missing);
  return {covered,missing,skipped,pending:0,total,percent:Math.round(covered/Math.max(1,total)*100),ranges:all.coveredRanges};
}
export function summaryCoverageText(plan){
  if(plan.lastIndex===null)return '尚未读取最新楼层。检查进度不调用模型；补采会按已保存的自动设置处理缺口。';
  const c=plan.coverage,format=rows=>rows.slice(0,12).map(r=>r.startIndex===r.endIndex?'#'+r.startIndex:'#'+r.startIndex+'–'+r.endIndex).join('、')+(rows.length>12?' 等 '+rows.length+' 段':'');
  return `已处理 ${c.coveredFloors} 楼：${format(c.coveredRanges)||'暂无'}\n未记录 ${c.missingFloors} 楼：${format(c.missingRanges)||'无缺口'}\n最新 #${plan.lastIndex}；保留最近 ${plan.keepRecent} 楼。本次补采 ${c.catchUpBatches} 批，每批最多 ${plan.batchSize} 楼，末批可不足一批。`;
}
export function autoSummaryText(plan){
  return [`起算楼层：#${plan.startFloor}`,plan.coveredThrough>=plan.startFloor?`已处理进度：#${plan.startFloor}–${plan.coveredThrough} · ${plan.completedBatches} 批`:'起点之后尚无已处理批次',`下一批：#${plan.nextStart}–${plan.nextEnd}`,`最近 ${plan.keepRecent} 楼暂不总结`,plan.lastIndex===null?'点击检查进度，读取当前聊天楼数。':`聊天最新：#${plan.lastIndex} · 满足条件的待总结批次：${plan.pendingBatches}`].join('\n');
}
