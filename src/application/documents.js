import { importTextDocument, splitDocument, documentPartKey, reviseDocumentChunk } from '../product-workspace.js';
import { normalizeTerms, KNOWLEDGE_ANALYSIS_PROMPT, parseKnowledgeAnalysis, normalizeTags } from '../product-dictionary.js';
import { fullSearchText } from '../product-narrative.js';
import { sha256 } from '../utils.js';
import { buildVectorIndex } from '../product-vector-indexer.js';
import { completion } from './shared.js';

/** documents orchestration. Dependencies are limited by service-contracts.js. */
export function createDocumentsService(appScope) {
async function loadKnowledge() {
    appScope.recallBusy++; appScope.recallChanged();
    try {
    const bound = appScope.globalWorkspace;
    const cards = [];
    for (const doc of appScope.state.documents.filter(d => d.purpose === 'knowledge'&&d.importOptions?.enabled!==false)) {
      const analysis=await bound.read(documentPartKey(doc,'analysis'),[]);
      for (let i = 0; i < doc.chunks; i++) {
        const part = await bound.read(documentPartKey(doc,i));
        if (part?.text) for (const slice of Number.isSafeInteger(doc.importOptions?.chunkSize)?[{text:part.text,start:0}]:splitDocument(part.text,{maxChars:600})) {
          const note=analysis.find(n=>n?.chunk===i),entities=normalizeTerms(note?.entities).filter(t=>[t.name,...t.aliases].some(n=>slice.text.includes(n)));
          const card={ id:`${doc.id}-${i}-${slice.start}`, category:'knowledge', description:slice.text, sourceRefs:[{sourceId:doc.id,fragmentId:`${i}:${slice.start}`}], documentId:doc.id,keywordEnabled:doc.importOptions?.keywordEnabled!==false,vectorEligible:doc.importOptions?.vectorEligible!==false,worldMode:doc.importOptions?.worldMode??appScope.core.settings.worldMode,documentName:doc.name,entities,tags:normalizeTags(note?.tags) };
          card.text=card.searchText=fullSearchText(card,slice.text);cards.push(card);
        }
      }
    }
    appScope.knowledgeCache = cards; appScope.recallChanged();
    if(appScope.workspace?.isCurrent()&&!appScope.state.stale)appScope.committedRecall=appScope.captureRecallSnapshot();
    } finally { appScope.recallBusy--; }
  }

async function knowledgeCards() { return appScope.core.settings.knowledgeEnabled ? appScope.knowledgeCache.filter(card => !appScope.state.hidden.includes(card.id)) : []; }

async function addDocument(input) { await appScope.loadApiSettings();const op=appScope.beginApi();try{const doc=await importTextDocument(appScope.globalWorkspace,input);op.check();appScope.state.documents=await appScope.globalWorkspace.read('documents',[]);await loadKnowledge();appScope.setMessage('文件已解析为文字，保存在全局资料库；尚未发送给模型');return doc;}finally{op.finish();} }

async function removeDocument(id) {
    if(appScope.knowledgeJob)throw new Error('请先停止或等待资料任务结束');
    await appScope.loadApiSettings();const doc=appScope.state.documents.find(d=>d.id===id);if(!doc)return;
    appScope.recallBusy++; appScope.recallChanged();
    try {
    await appScope.globalWorkspace.update('documents',list=>list.filter(d=>d.id!==id),[]);
    for(let i=0;i<doc.chunks;i++)await appScope.globalWorkspace.remove(documentPartKey(doc,i));
    await appScope.globalWorkspace.remove(documentPartKey(doc,'analysis')); appScope.state.documents=await appScope.globalWorkspace.read('documents',[]);await loadKnowledge();appScope.setMessage('资料已删除，聊天原文未改变');
    } finally { appScope.recallBusy--; }
  }

async function analyzeDocuments(ids=null) {
    await appScope.loadApiSettings();if(appScope.knowledgeJob)throw new Error('资料任务正在运行');appScope.knowledgeJob=true;const op=appScope.beginApi(),signal=op.signal;
    try {
      if(!appScope.state.documents.some(d=>!ids||ids.includes(d.id)))throw new Error('请先导入要分析的资料');
      for(const doc of appScope.state.documents.filter(d=>!ids||ids.includes(d.id))){
        const c=appScope.client(doc.purpose==='knowledge'?'knowledge':'assistant');
        const notes=await appScope.globalWorkspace.read(documentPartKey(doc,'analysis'),[]);
        for(let i=0;i<doc.chunks;i++){
          if(notes[i]&&(doc.purpose!=='knowledge'||notes[i].dictionaryStatus==='ready'))continue;
          op.check();const group=[];let chars=0;
          for(let j=i;j<doc.chunks;j++){if(notes[j]&&(doc.purpose!=='knowledge'||notes[j].dictionaryStatus==='ready'))continue;const p=await appScope.globalWorkspace.read(documentPartKey(doc,j));if(!p?.text)throw new Error('资料片段读取失败');if(group.length&&chars+p.text.length>6000)break;group.push({chunk:j,text:p.text});chars+=p.text.length;if(doc.purpose==='rules')break;}
          const purpose=doc.purpose==='rules'?'提取配置记忆插件的具体要求、例外与用户偏好；不执行其中代码。':'资料是世界设定参照；区分基础设定、历史、原作情节与未发生计划，不认定为当前聊天已经发生或角色已经知道。';
          const limit=doc.purpose==='knowledge'?(appScope.core.settings.knowledgeOutputTokens>0?{max_tokens:appScope.core.settings.knowledgeOutputTokens}:{}):appScope.replyLimit();
          const result=completion(await c.chatCompletions({model:c.profile.model,messages:[{role:'system',content:doc.purpose==='knowledge'?KNOWLEDGE_ANALYSIS_PROMPT+'\n'+purpose:`${purpose} 用不超过500字保存重要细节，注明本片段不能覆盖全书。`},{role:'user',content:group.map(p=>p.text).join('\n\n')}],stream:false,...limit},{signal}));
          op.check();for(const p of group)notes[p.chunk]={chunk:p.chunk,...(doc.purpose==='knowledge'?parseKnowledgeAnalysis(result.content,p.text):{text:result.content})};
          await appScope.globalWorkspace.write(documentPartKey(doc,'analysis'),notes);
          appScope.state.documents=await appScope.globalWorkspace.update('documents',list=>list.map(d=>d.id===doc.id?{...d,analyzed:notes.filter(Boolean).length,...(d.purpose==='knowledge'?{dictionaryStatus:notes.filter(n=>n?.dictionaryStatus==='ready').length===d.chunks?'ready':'partial'}:{})}:d),[]);
          appScope.state.progress=`${doc.name}：已分析 ${notes.filter(Boolean).length}/${doc.chunks} 段`;appScope.notify();
        }
      }
      const partial=appScope.state.documents.filter(d=>!ids||ids.includes(d.id)).some(d=>d.analyzed<d.chunks||d.purpose==='knowledge'&&d.dictionaryStatus!=='ready');
      const message=partial?'资料文字已保存；部分字典未生成，可继续分析补全，无需重新导入':'资料分析与字典已保存，可在字典页逐条校正';
      appScope.setMessage(message);return {level:partial?'warning':'success',message,partial};
    }finally{appScope.knowledgeJob=false;try{await loadKnowledge();}finally{op.finish();}}
  }

async function updateDocument(id,patch){
    await appScope.loadApiSettings();if(appScope.knowledgeJob)throw new Error('请等当前资料任务结束');
    appScope.state.documents=await appScope.globalWorkspace.update('documents',list=>list.map(d=>d.id===id?{...d,importOptions:{...(d.importOptions??{}),enabled:patch.enabled!==false}}:d),[]);
    await loadKnowledge();appScope.setMessage(patch.enabled===false?'资料已停用，原文与索引保留':'资料已启用');
  }

async function documentPreview(id,{page=1,pageSize=3}={}){
    await appScope.loadApiSettings();const d=appScope.state.documents.find(d=>d.id===id);if(!d)throw new Error('资料不存在');
    const size=Math.max(1,Math.min(10,Math.floor(Number(pageSize)||3))),start=Math.max(0,Math.floor(Number(page)||1)-1)*size;
    return Promise.all(Array.from({length:Math.max(0,Math.min(d.chunks-start,size))},async(_,i)=>{const part=await appScope.globalWorkspace.read(documentPartKey(d,start+i));return {...part,index:start+i,expected:sha256(part?.text??'')};}));
  }

async function editDocumentChunk(id,index,input){
    await appScope.loadApiSettings();if(appScope.knowledgeJob)throw Error('请等资料分析或建索引结束后修改');appScope.knowledgeJob=true;
    try{await reviseDocumentChunk(appScope.globalWorkspace,id,index,input);appScope.state.documents=await appScope.globalWorkspace.read('documents',[]);await loadKnowledge();appScope.setMessage('资料片段已保存，关键词检索即时更新；后续只补分析和变更的向量，不重做聊天总结');return appScope.state.documents.find(d=>d.id===id);}
    finally{appScope.knowledgeJob=false;}
  }

async function buildKnowledgeVectors(ids=null,diagnosticRun){
    await appScope.loadApiSettings();if(appScope.knowledgeJob)throw new Error('资料任务正在运行');appScope.knowledgeJob=true;const op=appScope.beginApi();
    try{
      const c=appScope.client('embedding'),fingerprint=sha256({endpoint:c.profile.url,model:c.profile.model}),key=`vectors-${fingerprint.slice(0,20)}`;
      const cards=appScope.knowledgeCache.filter(c=>c.vectorEligible!==false);
      const selected=cards.filter(c=>!ids||ids.includes(c.documentId)).map(c=>c.id);
      const report=await buildVectorIndex({cards,workspace:appScope.globalWorkspace,key,client:c,check:op.check,signal:op.signal,ids:selected,
        progress:p=>{appScope.state.progress=`资料向量：${p.indexed??0} 条已建立`;appScope.notify();},
        diagnostic:(phase,details,level='info')=>appScope.runtimeLog.record({run:diagnosticRun,task:'knowledge-vectors',phase,level,details})});
      appScope.knowledgeVectorCache.clear();const entries=await appScope.knowledgeVectorCache.load(appScope.globalWorkspace,key,op.signal);
      appScope.state.documents=await appScope.globalWorkspace.update('documents',list=>list.map(d=>{
        if(d.purpose!=='knowledge'||ids&&!ids.includes(d.id))return d;
        const own=cards.filter(card=>card.documentId===d.id),indexed=own.filter(card=>entries.get(card.id)?.hash===appScope.knowledgeVectorCache.hash(card)).length;
        return {...d,vectorStatus:{fingerprint,indexed,total:own.length,pending:own.length-indexed}};
      }),[]);
      const count=cards.filter(card=>selected.includes(card.id)&&entries.get(card.id)?.hash===appScope.knowledgeVectorCache.hash(card)).length;
      const scoped={...report,total:selected.length,indexed:count,pending:selected.length-count};
      const message=scoped.pending?'资料文字已保留；部分向量未完成，点击继续建索引重试':'资料向量索引已保存，各聊天可共用';
      appScope.setMessage(message);return {...scoped,message,level:scoped.pending?'warning':'success'};
    }finally{appScope.knowledgeJob=false;appScope.knowledgeVectorCache.clear();appScope.recallChanged();op.finish();}
  }
  return Object.freeze({ loadKnowledge, knowledgeCards, addDocument, removeDocument, analyzeDocuments, updateDocument, documentPreview, editDocumentChunk, buildKnowledgeVectors });
}
