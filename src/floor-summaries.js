import { SummaryResponseError } from './errors.js';
import { coverageState } from './contracts.js';
import { clone,sha256 } from './utils.js';
import { isolateDraftIds } from './summary-stages.js';

// The engine stamps actual repaired rows after binding and validating them.
// Reconcile only missing coverage backed by that exact operation/row receipt,
// including an old cached repaired bundle. Explicit statuses remain untouched.
export function reconcileRepairedFloorCoverage(bundle,messages,{operationId,scope}) {
  requireIndependentFloorSummaries(bundle,messages);
  const expected=messages.map(m=>({sourceId:m.id,version:m.version,hash:m.hash,contentHash:m.contentHash,fragmentId:m.fragmentId}));
  const missing=coverageState(bundle.coverage,expected).missing;
  let added=0;
  for(const row of bundle.summaryView){
    const id=`repair-floor-${sha256([operationId,row.sourceRefs]).slice(0,24)}`;
    // A resumed application runs the cached rows through its existing ID
    // isolation adapter; recognize that adapter's exact receipt spelling too.
    const isolated=scope?isolateDraftIds({summaryView:[{id}]},scope,operationId).summaryView[0].id:id;
    if(row.id!==id&&row.id!==isolated)continue;
    const ref=row.sourceRefs[0];
    if(!missing.some(m=>m.sourceId===ref.sourceId&&(m.fragmentId??null)===(ref.fragmentId??null)))continue;
    bundle.coverage.processed.push(clone(ref));added++;
  }
  return added;
}

/** Input rows have already passed the shared source-reference binding. */
export function requireIndependentFloorSummaries(bundle,messages) {
  const rows=Array.isArray(bundle.summaryView)?bundle.summaryView:[];
  const detail={expected:messages.length,received:rows.length,covered:0,invalidRows:0,duplicateCount:0,missingFloors:[],duplicateFloors:[],emptyFloors:[]};
  const matched=new Set();
  for(const message of messages){
    const candidates=rows.filter(row=>row.sourceRefs?.length===1&&row.sourceRefs[0].sourceId===message.id&&row.sourceRefs[0].fragmentId===message.fragmentId);
    for(const row of candidates)matched.add(row);
    if(!candidates.length){detail.missingFloors.push(message.index);continue;}
    if(candidates.length!==1){detail.duplicateFloors.push(message.index);detail.duplicateCount+=candidates.length-1;continue;}
    const row=candidates[0];
    if(!['text','description','summary','content'].some(key=>typeof row[key]==='string'&&row[key].trim())){detail.emptyFloors.push(message.index);continue;}
    // The verified source reference determines the absolute host floor, not
    // row position or a model-generated floor number.
    row.floorIndex=message.index;detail.covered++;
  }
  detail.invalidRows=rows.length-matched.size;
  if(detail.covered!==detail.expected||detail.received!==detail.expected){
    const error=new SummaryResponseError('independent floor summaries failed coverage checks',detail);
    error.code='FLOOR_SUMMARY_MISSING';throw error;
  }
  return detail;
}
