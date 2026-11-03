/** Portable chat memory. Comparison and activation remain separate UI actions. */
export function mountMemoryArchive({panel,app,run,download}){
 const section=panel.ownerDocument.createElement('details');section.className='memo-person-category memo-settings-category';section.dataset.memoryArchive='';section.dataset.settingsCategory='archives';
 section.innerHTML='<summary><span>记忆档案与聊天分支</span></summary><div class="memo-person-category-body"><p class="memo-help">在旧聊天导出档案，在新的聊天或分支比较并导入。相同原文的已完成批次直接继承，原聊天成果保留。档案含私人记忆与恢复资料，请自行保管。</p><div class="memo-actions memo-archive-actions"><button type="button" data-archive-export>导出记忆档案</button><button type="button" data-archive-select>选择档案</button><input type="file" accept="application/json,.json" data-archive-file hidden></div><p class="memo-help" data-archive-status role="status">导出与导入只做本地读写，不调用模型。</p><button type="button" data-archive-apply hidden>继承到当前聊天</button></div>';
 panel.querySelector('.memo-settings-directory').append(section);
 const q=s=>section.querySelector(s),status=q('[data-archive-status]'),apply=q('[data-archive-apply]');let archive=null,plan=null,revision=0,busy=false;
 const task=fn=>run(async()=>{if(busy)return;busy=true;try{await fn();}catch(error){status.textContent=error.message;throw error;}finally{busy=false;}});
 q('[data-archive-export]').onclick=()=>task(async()=>{status.textContent='正在导出当前聊天的记忆档案…';await download(await app.exportMemoryArchive(),'Memo-记忆档案.json');status.textContent='导出已处理，文件保存状态见提示。';});
 const select=q('[data-archive-select]'),input=q('[data-archive-file]');
 select.onclick=()=>{if(!busy){input.value='';input.click();}};
 q('[data-archive-file]').onchange=()=>{const file=q('[data-archive-file]').files?.[0],current=++revision;archive=null;plan=null;apply.hidden=true;if(!file)return;void task(async()=>{
  if(file.size>256*1024*1024)throw new Error('档案超过 256 MB，请使用较小的聊天档案');status.textContent='正在本地比较原文…';
  const input=JSON.parse(await file.text()),preview=await app.previewMemoryArchive(input);if(current!==revision)return;archive=input;plan=preview;
  status.textContent=preview.matchedThrough<0?'没有可继承的相同前缀。':`可继承 0–${preview.matchedThrough} 楼以内的 ${preview.summaryBatches} 个总结批次、${preview.personaBatches} 个人设批次；主总结从 ${preview.nextSummaryFloor} 楼继续。模型请求：0 次。导入后自动任务暂停，可手动继续。`;
  apply.hidden=preview.matchedThrough<0;
 });};
 apply.onclick=()=>task(async()=>{if(!archive||!plan)return;apply.disabled=true;try{status.textContent='正在保存独立档案分支…';const result=await app.importMemoryArchive(archive,{previewHash:plan.previewHash});status.textContent=`档案已保存；继承 ${result.summaryBatches} 个总结批次、${result.personaBatches} 个人设批次。可关闭后重开，或从 ${result.nextSummaryFloor} 楼继续整理。`;archive=null;plan=null;apply.hidden=true;}finally{apply.disabled=false;}});
 return {dispose(){revision++;select.onclick=null;q('[data-archive-export]').onclick=null;q('[data-archive-file]').onchange=null;apply.onclick=null;}};
}
