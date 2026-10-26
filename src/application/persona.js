

/** persona orchestration. Dependencies are limited by service-contracts.js. */
export function createPersonaService(appScope) {
function assertNoRetrospective(){if(appScope.retrospectiveOperation)throw new Error('请先停止复盘，再处理人物批次');}

function reservePersonaCommand(task){
    assertNoRetrospective();if(appScope.personaLaunch)throw new Error('人设任务正在准备，请稍后再试');
    appScope.personaLaunch=Promise.resolve().then(task).finally(()=>{appScope.personaLaunch=null;appScope.dynamicPersona.wake();appScope.notify();});return appScope.personaLaunch;
  }

function queueDynamicPersona({catchUp=false}={}){
    assertNoRetrospective();
    if(appScope.personaLaunch)return appScope.personaLaunch;
    const token=appScope.epoch,command=appScope.personaCommandVersion;
    const guard=()=>{appScope.assertCurrent(token);if(command!==appScope.personaCommandVersion||!appScope.enabled)throw Object.assign(new Error('人设启动已取消'),{code:'CANCELED'});};
    const work=appScope.logged('persona',async()=>{
      if(!appScope.enabled)throw new Error('插件已暂停，请先启用插件，再更新人设');
      guard();await appScope.dynamicPersona.load();guard();
      if(appScope.dynamicPersona.state.busy)return {message:'人设任务正在运行，无需重复启动',level:'info'};
      const unfinished=['running','paused','failed'].includes(appScope.dynamicPersona.state.manualPlan?.status);
      if(!unfinished){
        const plan=await appScope.dynamicPersona.inspect();guard();
        if(catchUp?plan.nextStart>plan.eligibleEnd:!plan.ready)return {message:'尚未凑齐可处理的人设批次；保留楼层不读取，回复结束后自动检查。',level:'info'};
        await appScope.dynamicPersona.createManual({startIndex:plan.nextStart,endIndex:catchUp?plan.eligibleEnd:plan.nextEnd,batchSize:appScope.core.settings.dynamicPersonaEvery,handoff:true});guard();
      }
      // Creating first preserves whether automatic continuation was enabled.
      if(!appScope.core.settings.dynamicPersonaEnabled)await appScope.saveSettings({dynamicPersonaEnabled:true});guard();
      return appScope.dynamicPersona.resumeManual();
    });
    appScope.personaLaunch=work.finally(()=>{appScope.personaLaunch=null;appScope.dynamicPersona.wake();appScope.notify();});
    return appScope.personaLaunch;
  }

function retryDynamicPersonaManualBatch(options){
    assertNoRetrospective();
    if(appScope.personaLaunch)return appScope.personaLaunch;
    const token=appScope.epoch,command=appScope.personaCommandVersion;
    const guard=()=>{appScope.assertCurrent(token);if(command!==appScope.personaCommandVersion||!appScope.enabled)throw Object.assign(new Error('人设单批重试已取消'),{code:'CANCELED'});};
    const work=appScope.logged('persona',async()=>{
      guard();await appScope.dynamicPersona.load();guard();
      if(!appScope.core.settings.dynamicPersonaEnabled)await appScope.saveSettings({dynamicPersonaEnabled:true});guard();
      return appScope.dynamicPersona.resumeManualBatch(options);
    });
    appScope.personaLaunch=work.finally(()=>{appScope.personaLaunch=null;appScope.dynamicPersona.wake();appScope.notify();});
    return appScope.personaLaunch;
  }

async function manageDynamicPersonaCandidate(action,options){
    assertNoRetrospective();
    appScope.assertCurrent();if(appScope.personaLaunch)throw new Error('人设任务正在准备，请先暂停后管理批次');
    const token=appScope.epoch,command=appScope.personaCommandVersion;
    await appScope.dynamicPersona.load();appScope.assertCurrent(token);
    if(command!==appScope.personaCommandVersion)throw Object.assign(new Error('人设批次操作已取消'),{code:'CANCELED'});
    return appScope.dynamicPersona[action](options);
  }
  return Object.freeze({ assertNoRetrospective, reservePersonaCommand, queueDynamicPersona, retryDynamicPersonaManualBatch, manageDynamicPersonaCandidate });
}
