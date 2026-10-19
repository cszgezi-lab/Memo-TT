import { frameScheduler } from './product-view-scheduling.js';
import { hostTaskStatus } from './product-task-monitor.js';
const STORAGE_KEY = 'memo-tt-floating-ui-v1';
const PHONE_STORAGE_KEY = 'memo-tt-phone-ui-v1';
const THEATRE_STORAGE_KEY = 'memo-tt-theatre-ui-v1';
const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
const ratio = value => Number.isFinite(value) ? clamp(value, 0, 1) : null;

// Presentation-only, device-local preferences: never store chat content or keys.
export function floatingPreferences(value) {
  const point = (p, fallback) => ({ x: ratio(p?.x) ?? fallback.x, y: ratio(p?.y) ?? fallback.y });
  return { version: 1, bubble: point(value?.bubble, { x: 1, y: .65 }), window: point(value?.window, { x: .5, y: .3 }), showLauncher: value?.showLauncher !== false };
}

export function floatingBounds({ width, height, layoutHeight = height, left = 0, top = 0, insets = {}, bottomInset = 0 }) {
  const safe = value => Number.isFinite(value) ? Math.max(0, value) : 0;
  const x = left + safe(insets.left) + 8, y = top + safe(insets.top) + 8;
  // VisualViewport can already exclude the keyboard. Do not subtract it twice.
  const right = left + width - safe(insets.right) - 8;
  const bottom = Math.min(top + height - safe(insets.bottom), layoutHeight - Math.max(safe(bottomInset), safe(insets.bottom))) - 8;
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

export function floatingPosition(point, size, frame) {
  return { x: frame.x + (ratio(point.x) ?? 0) * Math.max(0, frame.width - size.width), y: frame.y + (ratio(point.y) ?? 0) * Math.max(0, frame.height - size.height) };
}

/** One persistent non-modal window. Closing only hides UI, not the application. */
export function mountFloatingProduct({ panel, documentRef, host, version, displayName = '拾忆', presentation = 'workbench', onSettings = () => {}, onSearch = () => {}, onOpen = () => {}, onClose = () => {}, onStop = () => {}, onLogs = () => {}, onHome = () => {}, onBack = () => {}, onTaskDetails = () => {} }) {
  const win = documentRef.defaultView ?? host;
  const phone = presentation === 'phone', theatre = presentation === 'theatre', storageKey = theatre ? THEATRE_STORAGE_KEY : phone ? PHONE_STORAGE_KEY : STORAGE_KEY;
  let preferences;
  try { preferences = floatingPreferences(JSON.parse(win.localStorage.getItem(storageKey))); }
  catch { preferences = floatingPreferences(); }
  const save = () => { try { win.localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* still usable without storage */ } };
  const layer = documentRef.createElement('div'); layer.id = 'memo-floating-layer';
  if(theatre)layer.setAttribute('data-presentation','theatre');
  layer.setAttribute('data-tt-mobile-surface', 'none');
  const launcher = documentRef.createElement('button'); launcher.id = 'memo-floating-launcher'; launcher.type = 'button';
  launcher.textContent = displayName; launcher.setAttribute('aria-label', `打开${displayName}`); launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-controls', 'memo-floating-window'); launcher.setAttribute('data-tt-mobile-surface', 'free-window');
  launcher.title = `打开${displayName} · 拖动可移动`;
  const windowEl = documentRef.createElement('section'); windowEl.id = 'memo-floating-window'; windowEl.className = 'memo-workbench';
  if (phone) { windowEl.className += ' memo-phone-window'; windowEl.setAttribute('data-presentation','phone'); windowEl.setAttribute('data-phone-at-home','true'); }
  if (theatre) windowEl.setAttribute('data-presentation','theatre');
  windowEl.hidden = true; windowEl.setAttribute('role', 'dialog'); windowEl.setAttribute('aria-modal', 'false');
  windowEl.setAttribute('aria-label', `${displayName}悬浮窗`); windowEl.setAttribute('data-tt-mobile-surface', 'free-window');
  const header = documentRef.createElement('header'); header.className = 'memo-workbench-header';
  if (phone) header.className += ' memo-phone-system-bar memo-phone-system';
  const grip = documentRef.createElement('button'); grip.type = 'button'; grip.className = 'memo-workbench-drag';
  grip.textContent = phone ? displayName : `⠿  ${displayName}  ${version}`; grip.setAttribute('aria-label', `移动${displayName}窗口`); grip.title = '拖动移动；方向键也可移动';
  if (phone) { grip.className += ' memo-phone-title'; grip.setAttribute('data-phone-title',''); }
  if (theatre) { const title=documentRef.createElement('span'), label=documentRef.createElement('b'), edition=documentRef.createElement('small'); title.className='memo-theatre-brand';label.textContent=displayName;edition.textContent=version;title.append(label,edition);grip.textContent='';grip.append(title); }
  const settingsButton=documentRef.createElement('button'), searchButton=documentRef.createElement('button');
  settingsButton.type=searchButton.type='button';settingsButton.textContent='设置';searchButton.textContent='搜索';settingsButton.className=searchButton.className='memo-theatre-utility';settingsButton.setAttribute('data-theatre-settings','');searchButton.setAttribute('data-theatre-search','');
  const closeButton = documentRef.createElement('button'); closeButton.type = 'button'; closeButton.className = 'memo-workbench-close';
  closeButton.textContent = '收起'; closeButton.setAttribute('aria-label', `收起${displayName}`);
  const content = documentRef.createElement('div'); content.className = 'memo-workbench-content'; content.appendChild(panel);
  if (phone) content.className += ' memo-phone-content';
  const dock = documentRef.createElement(phone ? 'details' : 'div'); dock.className = 'memo-workbench-dock';
  let notificationSummary, notificationTask, notificationContext;
  if (phone) {
    dock.className += ' memo-phone-notification'; dock.setAttribute('data-phone-notification','');
    notificationSummary=documentRef.createElement('summary');notificationSummary.className='memo-phone-notification-summary';notificationSummary.setAttribute('aria-live','polite');notificationSummary.textContent='就绪';dock.append(notificationSummary);
  }
  const notice = documentRef.createElement('div'); notice.className = 'memo-workbench-notice'; notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');notice.setAttribute('aria-atomic','true');notice.textContent='就绪';
  const stopButton=documentRef.createElement('button');stopButton.type='button';stopButton.textContent='停止';stopButton.hidden=true;stopButton.className='memo-dock-stop';
  const logButton=documentRef.createElement('button');logButton.type='button';logButton.textContent='日志';logButton.className='memo-dock-logs';logButton.setAttribute('aria-label','查看运行日志');
  if (phone) {
    const body=documentRef.createElement('div');body.className='memo-phone-notification-body';
    notificationContext=documentRef.createElement('div');notificationContext.className='memo-phone-notification-task memo-help';notificationContext.hidden=true;
    notificationTask=documentRef.createElement('button');notificationTask.type='button';notificationTask.textContent='任务详情';notificationTask.hidden=true;notificationTask.setAttribute('data-phone-task-details','');
    body.append(notificationContext,notice,notificationTask,logButton,stopButton);dock.append(body);
  } else dock.append(notice,logButton,stopButton);
  const dockTask=documentRef.createElement('div');dockTask.className='memo-dock-current-task';dockTask.setAttribute('data-dock-current-task','');dockTask.setAttribute('role','status');dockTask.hidden=true;
  const dockTaskText=documentRef.createElement('span'),dockTaskProgress=documentRef.createElement('progress');dockTaskProgress.setAttribute('aria-label','当前任务已保存批次进度');dockTask.append(dockTaskText,dockTaskProgress);if(theatre)dock.prepend(dockTask);
  let phoneControls,backButton,homeButton,phoneClose;
  if (phone) {
    phoneControls=documentRef.createElement('nav');phoneControls.className='memo-phone-controls memo-phone-homebar';phoneControls.setAttribute('aria-label','手机导航');
    backButton=documentRef.createElement('button');backButton.type='button';backButton.textContent='返回';backButton.disabled=true;backButton.setAttribute('data-phone-back','');backButton.setAttribute('aria-label','返回上一页');
    homeButton=documentRef.createElement('button');homeButton.type='button';homeButton.setAttribute('data-phone-home','');homeButton.setAttribute('aria-label','返回拾忆主页');homeButton.setAttribute('aria-current','page');homeButton.disabled=true;
    const icon=documentRef.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('width','20');icon.setAttribute('height','20');icon.setAttribute('aria-hidden','true');icon.setAttribute('focusable','false');icon.classList.add('memo-phone-home-icon');
    const path=documentRef.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M3 10 12 3 21 10v11h-6v-7H9v7H3Z');path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','1.8');path.setAttribute('stroke-linejoin','round');icon.append(path);
    const label=documentRef.createElement('span');label.textContent='主页';homeButton.append(icon,label);
    phoneClose=documentRef.createElement('button');phoneClose.type='button';phoneClose.textContent='收起';phoneClose.setAttribute('data-phone-close','');phoneClose.setAttribute('aria-label','收起拾忆手机');
    for (const button of [backButton,homeButton,phoneClose]) { button.style.minHeight='44px';button.style.minWidth='44px'; }
    phoneControls.append(backButton,homeButton,phoneClose);
  }
  const taskBar=documentRef.createElement('aside');taskBar.className='memo-host-task-bar';taskBar.hidden=true;taskBar.setAttribute('data-host-task','');taskBar.setAttribute('data-tt-mobile-surface','free-window');
  const taskText=documentRef.createElement('div');taskText.className='memo-host-task-text';taskText.setAttribute('role','status');taskText.setAttribute('aria-live','polite');taskText.setAttribute('aria-atomic','true');
  const taskTitle=documentRef.createElement('strong'),taskDetail=documentRef.createElement('div'),taskHint=documentRef.createElement('small'),taskProgress=documentRef.createElement('progress');
  taskTitle.setAttribute('data-host-task-current','');taskDetail.setAttribute('data-host-task-detail','');taskHint.setAttribute('data-host-task-hint','');taskProgress.setAttribute('aria-label','本次计划已保存批次');
  taskText.append(taskTitle,taskDetail,taskHint,taskProgress);
  const taskActions=documentRef.createElement('div');taskActions.className='memo-host-task-actions';
  const taskOpen=documentRef.createElement('button');taskOpen.type='button';taskOpen.textContent='详情';taskOpen.setAttribute('aria-label','打开拾忆查看任务详情');
  const taskStop=documentRef.createElement('button');taskStop.type='button';taskStop.textContent='停止';taskStop.setAttribute('data-host-task-stop','');
  taskActions.append(taskOpen,taskStop);taskBar.append(taskText,taskActions);
  // Navigation and feedback must not scroll away with a long API form.
  const nav=panel.querySelector('.memo-nav');
  header.append(grip);if(theatre)header.append(searchButton,settingsButton);header.append(closeButton); windowEl.append(header);if(nav&&!phone)windowEl.append(nav);windowEl.append(content,dock);if(phoneControls)windowEl.append(phoneControls);layer.append(launcher, windowEl,taskBar); documentRef.body.appendChild(layer);
  // A manual popover is non-modal and escapes drawer/theme stacking contexts.
  // Old WebViews retain a fixed high-z-index surface; no showModal or scroll lock.
  if (typeof layer.showPopover === 'function') {
    layer.setAttribute('popover', 'manual');
    try { layer.showPopover(); } catch { layer.removeAttribute('popover'); }
  }
  const shortcut = documentRef.createElement('div'); shortcut.id = 'memo-extension-shortcut';
  const shortcutButton = documentRef.createElement('button'); shortcutButton.type = 'button'; shortcutButton.textContent = `打开${displayName}悬浮窗`;
  const toggleLabel = documentRef.createElement('label'), toggle = documentRef.createElement('input');
  toggle.type = 'checkbox'; toggle.checked = preferences.showLauncher;
  toggleLabel.append(toggle, documentRef.createTextNode(' 显示悬浮按钮')); shortcut.append(shortcutButton, toggleLabel);
  documentRef.getElementById('extensions_settings2')?.appendChild(shortcut);
  let disposed = false, raf = null, unsubscribe = null;
  const cancelDrags = [];
  const cleanup = [];
  let taskStatus=hostTaskStatus(),taskStopping=false,taskSignature=JSON.stringify(taskStatus),busy=false;
  function listen(target, type, fn, options) { target?.addEventListener?.(type, fn, options); cleanup.push(() => target?.removeEventListener?.(type, fn, options)); }
  listen(stopButton,'click',onStop);
  listen(logButton,'click',onLogs);
  if(theatre){listen(settingsButton,'click',onSettings);listen(searchButton,'click',onSearch);}
  listen(taskOpen,'click',()=>{show();onTaskDetails();});
  if (phone) {
    listen(backButton,'click',()=>{if(!backButton.disabled)return onBack();});
    listen(homeButton,'click',()=>{if(!homeButton.disabled)return onHome();});
    listen(phoneClose,'click',()=>hide());listen(notificationTask,'click',onTaskDetails);
  }
  listen(taskStop,'click',async()=>{if(taskStopping||!taskStatus.canStop)return;taskStopping=true;paintTask();try{await onStop();}finally{taskStopping=false;if(!disposed)paintTask();}});
  // A touch opens on pointerup and hides its target. Some WebViews then retarget
  // the compatibility click to the newly exposed window control under the finger.
  // Consume only that gesture's click; a new pointerdown or keyboard click is free.
  let openingGesture = null;
  listen(documentRef, 'pointerdown', () => { openingGesture = null; }, true);
  listen(documentRef, 'click', event => {
    const g = openingGesture; openingGesture = null;
    if (g && event.detail !== 0 && Date.now() - g.at < 700 && Math.hypot(event.clientX - g.x, event.clientY - g.y) < 20) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  const px = (style, name) => Math.max(0, Number.parseFloat(style.getPropertyValue(name)) || 0);
  function frameFor(element) {
    const rootStyle = win.getComputedStyle(documentRef.documentElement), localStyle = win.getComputedStyle(element);
    const vv = win.visualViewport;
    return floatingBounds({ width: vv?.width ?? win.innerWidth, height: vv?.height ?? win.innerHeight,
      left: vv?.offsetLeft ?? 0, top: vv?.offsetTop ?? 0, layoutHeight: px(rootStyle,'--tt-base-viewport-height') || win.innerHeight,
      insets: Object.fromEntries(['top', 'right', 'bottom', 'left'].map(side => [side, px(rootStyle, `--tt-inset-${side}`)])),
      bottomInset: Math.max(px(localStyle, '--tt-viewport-bottom-inset'), px(localStyle, '--tt-ime-bottom')) });
  }
  function setPx(element, key, number) {
    const value = `${Math.round(number * 100) / 100}px`;
    if (element.style[key] !== value) element.style[key] = value;
  }
  function place(element, point) {
    const frame = frameFor(element), size = element.getBoundingClientRect(), position = floatingPosition(point, size, frame);
    setPx(element, 'left', position.x); setPx(element, 'top', position.y);
  }
  function layout() {
    if (disposed) return;
    for (const cancel of cancelDrags) cancel();
    const frame = frameFor(windowEl);
    // Leave room to drag even on a narrow screen; content scrolls below the grip.
    setPx(windowEl, 'width', theatre ? Math.min(960, frame.width * (frame.width >= 700 ? .88 : 1)) : Math.min(phone ? 392 : 660, frame.width));
    setPx(windowEl, 'height', Math.min(theatre ? 900 : phone ? 760 : 720, frame.height * (theatre ? .9 : phone ? .96 : .92)));
    if (!windowEl.hidden) place(windowEl, preferences.window);
    if (!launcher.hidden) place(launcher, preferences.bubble);
    placeTask();
    keepInputVisible();
  }
  function placeTask(){
    if(taskBar.hidden||disposed)return;
    const frame=frameFor(taskBar);setPx(taskBar,'width',Math.min(560,frame.width));
    const size=taskBar.getBoundingClientRect();setPx(taskBar,'left',frame.x+Math.max(0,(frame.width-size.width)/2));
    setPx(taskBar,'top',frame.y+Math.min(48,Math.max(0,frame.height-size.height)));
  }
  function paintTask(){
    if(theatre){dockTask.hidden=!taskStatus.visible;dockTaskText.textContent=[taskStatus.title,taskStatus.detail].filter(Boolean).join(' · ');dockTaskProgress.hidden=!taskStatus.canStop;if(taskStatus.progress){dockTaskProgress.max=taskStatus.progress.max;dockTaskProgress.value=taskStatus.progress.value;}else dockTaskProgress.removeAttribute('value');stopButton.hidden=!taskStatus.canStop&&!busy;}

    taskBar.hidden=!windowEl.hidden||!taskStatus.visible;
    for(const [node,value]of [[taskTitle,taskStatus.title],[taskDetail,taskStatus.detail],[taskHint,taskStatus.hint]]){if(node.textContent!==value)node.textContent=value;node.hidden=!value;}
    taskStop.hidden=!taskStatus.canStop&&!taskStopping;taskStop.disabled=taskStopping;taskStop.textContent=taskStopping?'正在停止…':'停止';taskStop.setAttribute('aria-busy',String(taskStopping));
    taskProgress.hidden=!taskStatus.canStop;
    if(taskStatus.progress){taskProgress.max=taskStatus.progress.max;taskProgress.value=taskStatus.progress.value;}else taskProgress.removeAttribute('value');
    paintPhoneNotice();
    placeTask();
  }
  function paintPhoneNotice(){
    if(!phone)return;
    const level=notice.dataset.level??'info',attention=level==='error'?'未完成':level==='warning'?'提醒':taskStatus.canStop||busy?'正在处理':'';
    const message=notice.textContent||'就绪',current=taskStatus.visible?taskStatus.title:'';
    // CSS limits the summary to two lines; the full message remains here and in
    // the disclosure body. Errors are never replaced with a generic busy label.
    notificationSummary.textContent=[attention,level==='error'||level==='warning'?message:current||message].filter(Boolean).join(' · ');
    notificationContext.textContent=[taskStatus.title,taskStatus.detail,taskStatus.hint].filter(Boolean).join('\n');notificationContext.hidden=!taskStatus.visible;
    dock.dataset.level=level;dock.dataset.busy=String(taskStatus.canStop||busy);dock.setAttribute('aria-label',level==='error'?'任务未完成，展开通知查看详情':'展开通知查看详情');
    stopButton.hidden=!busy&&!taskStatus.canStop;notificationTask.hidden=!busy&&!taskStatus.visible;
  }
  function keepInputVisible() {
    const input=documentRef.activeElement;
    if(windowEl.hidden||!content.contains(input)||!input.matches('input,textarea,select,[contenteditable="true"]'))return;
    const rect=input.getBoundingClientRect(), bounds=content.getBoundingClientRect();
    if(rect.bottom>bounds.bottom-12)content.scrollTop+=rect.bottom-(bounds.bottom-12);
    else if(rect.top<bounds.top+12)content.scrollTop-=bounds.top+12-rect.top;
  }
  function schedule() { if (raf === null && !disposed) raf = win.requestAnimationFrame(() => { raf = null; layout(); }); }
  function show() {
    if (disposed) return;
    windowEl.hidden = false; launcher.hidden = true; launcher.setAttribute('aria-expanded', 'true'); layout();
    grip.focus({ preventScroll: true });
    paintTask();onOpen();
  }
  function hide() {
    windowEl.hidden = true; launcher.hidden = !preferences.showLauncher; launcher.setAttribute('aria-expanded', 'false'); layout();
    paintTask();onClose(); (launcher.hidden ? shortcutButton : launcher).focus({ preventScroll: true });
  }
  function move(element, kind, x, y, persist = false) {
    const frame = frameFor(element), size = element.getBoundingClientRect();
    const maxX = Math.max(0, frame.width - size.width), maxY = Math.max(0, frame.height - size.height);
    x = clamp(x, frame.x, frame.x + maxX); y = clamp(y, frame.y, frame.y + maxY);
    setPx(element, 'left', x); setPx(element, 'top', y);
    if (persist) { preferences[kind] = { x: maxX ? (x - frame.x) / maxX : preferences[kind].x, y: maxY ? (y - frame.y) / maxY : preferences[kind].y }; save(); }
  }
  function draggable(handle, element, kind, tap) {
    let drag = null, suppressClick = false;
    const motion = frameScheduler(win, () => {
      if (drag?.moved) element.style.transform = `translate3d(${drag.nextX - drag.left}px, ${drag.nextY - drag.top}px, 0)`;
    });
    const resetMotion = () => { motion.cancel(); element.style.transform = ''; element.style.willChange = ''; };
    const cancelDrag = () => { if (drag) { drag = null; suppressClick = true; resetMotion(); } };
    cancelDrags.push(cancelDrag); cleanup.push(() => { cancelDrag(); motion.dispose(); });
    function track(event) {
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) >= 6) drag.moved = true;
      drag.nextX = clamp(drag.left + dx, drag.frame.x, drag.frame.x + Math.max(0, drag.frame.width - drag.width));
      drag.nextY = clamp(drag.top + dy, drag.frame.y, drag.frame.y + Math.max(0, drag.frame.height - drag.height));
    }
    listen(handle, 'pointerdown', event => {
      if (event.isPrimary === false || event.button !== 0) return;
      cancelDrag();
      const r = element.getBoundingClientRect(); suppressClick = false;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: r.left, top: r.top, width:r.width, height:r.height, frame:frameFor(element), nextX:r.left, nextY:r.top, moved: false };
      try { handle.setPointerCapture(event.pointerId); } catch { /* fallback listeners still work */ }
      event.preventDefault();
    });
    listen(handle, 'pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      track(event);
      if (drag.moved) { event.preventDefault(); element.style.willChange = 'transform'; motion.request(); }
    });
    const finish = event => {
      if (!drag || drag.id !== event.pointerId) return;
      if (event.type === 'pointerup') track(event);
      const previous = drag; drag = null; suppressClick = previous.moved; resetMotion();
      if (event.type === 'pointercancel') { suppressClick = true; place(element, preferences[kind]); }
      else if (previous.moved) move(element, kind, previous.nextX, previous.nextY, true);
      try { handle.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      if (event.type === 'pointerup' && !previous.moved && tap) {
        // Some Android WebViews suppress/delay the compatibility click after
        // pointer capture. Complete taps here and ignore the duplicate click.
        suppressClick = true; event.preventDefault();
        openingGesture = { x: event.clientX, y: event.clientY, at: Date.now() };
        tap();
      }
    };
    listen(handle, 'pointerup', finish); listen(handle, 'pointercancel', finish);
    listen(handle, 'lostpointercapture', event => { if (drag?.id === event.pointerId) { cancelDrag(); place(element, preferences[kind]); } });
    listen(handle, 'click', event => { if (suppressClick && event.detail !== 0) { suppressClick = false; event.preventDefault(); return; } tap?.(); });
    listen(handle, 'keydown', event => {
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!direction) return;
      event.preventDefault(); const r = element.getBoundingClientRect(), step = event.shiftKey ? 40 : 16;
      move(element, kind, r.left + direction[0] * step, r.top + direction[1] * step, true);
    });
  }
  draggable(launcher, launcher, 'bubble', show); draggable(grip, windowEl, 'window');
  listen(closeButton, 'click', hide); listen(shortcutButton, 'click', show);
  listen(toggle, 'change', () => { preferences.showLauncher = toggle.checked; launcher.hidden = !windowEl.hidden || !toggle.checked; save(); layout(); });
  listen(windowEl, 'keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); hide(); } });
  listen(win, 'resize', schedule); listen(win, 'orientationchange', schedule);
  listen(win.visualViewport, 'resize', schedule); listen(win.visualViewport, 'scroll', schedule);
  listen(content,'focusin',schedule);
  // Ignore our own left/top writes in both our observer and TT's subscription:
  // otherwise reapplying saved coordinates would snap an active drag back.
  // Own position/transform writes cannot affect insets. Check cheap inline inputs
  // first so neither our observer nor TT's subscription forces layout per move.
  const geometryInputs = () => JSON.stringify([documentRef.documentElement.style.cssText, documentRef.documentElement.className,
    documentRef.documentElement.getAttribute('data-tt-ime-active'), ...[windowEl,launcher].map(el => [el.className,el.getAttribute('data-tt-ime-active'),
      el.style.getPropertyValue('--tt-viewport-bottom-inset'),el.style.getPropertyValue('--tt-ime-bottom')])]);
  let geometrySignature = geometryInputs();
  function geometryChanged() {
    const next = geometryInputs();
    if (next !== geometrySignature) { geometrySignature = next; schedule(); }
  }
  let observer;
  if (win.MutationObserver) {
    observer = new win.MutationObserver(geometryChanged);
    for (const element of [documentRef.documentElement, windowEl, launcher]) observer.observe(element, { attributes: true, attributeFilter: ['style', 'class', 'data-tt-ime-active'] });
  }
  // Prefer TT's subscription when present; CSS/viewport observers remain the fallback.
  Promise.resolve(host?.__TAURITAVERN__?.ready).then(async () => {
    if (disposed) return;
    const subscription = await host?.__TAURITAVERN__?.api?.layout?.subscribe?.(geometryChanged);
    if (disposed) await subscription?.(); else unsubscribe = subscription;
  }).catch(() => { /* CSS contract remains available */ });
  launcher.hidden = !preferences.showLauncher; layout();
  return { layer, launcher, window: windowEl, content, shortcut, show, hide,
    setPhonePage({title='拾忆',home=false,canBack=false}={}){if(!phone)return;const label=String(title??'').trim()||'拾忆';grip.textContent=label;grip.setAttribute('aria-label',`移动拾忆窗口 · ${label}`);windowEl.setAttribute('aria-label',`拾忆手机 · ${label}`);windowEl.setAttribute('data-phone-at-home',String(Boolean(home)));backButton.disabled=!canBack;homeButton.disabled=Boolean(home);homeButton.setAttribute('aria-current',home?'page':'false');},
    setTaskMonitor(monitor){const next=hostTaskStatus(monitor),signature=JSON.stringify(next);if(signature===taskSignature)return;taskSignature=signature;taskStatus=next;paintTask();},
    setNotice(text,level='info'){notice.textContent=text;notice.dataset.level=level;launcher.dataset.notice=level;launcher.title=`打开拾忆 · ${text}`;paintPhoneNotice();},
    setBusy(value){busy=Boolean(value);stopButton.hidden=!busy;paintPhoneNotice();},
    destroy() { disposed = true; if (raf !== null) win.cancelAnimationFrame(raf); observer?.disconnect(); for (const off of cleanup) off(); Promise.resolve().then(() => unsubscribe?.()).catch(() => {}); layer.remove(); shortcut.remove(); } };
}
