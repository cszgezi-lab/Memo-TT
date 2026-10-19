// TT's desktop browser-mode exporter releases its Blob URL before a delayed
// WebView download may consume it. Use its existing permitted filesystem API
// for an explicit, verified file save instead. No dialog permission is added.
const active = new WeakMap();
const CHUNK = 4 * 1024 * 1024;
let sequence = 0;
const normalized = value => String(value).replaceAll('\\', '/').replace(/\/+$/, '');
const exportFailure = (reason, stage, message, causeError) => Object.assign(new Error(message), {
  code: 'FILE_EXPORT_FAILED', details: { reason, stage, exportAttempt: 'desktop', ...(causeError ? { causeError } : {}) },
});

export async function verifyNativeExportFile({ invoke, filePath, blob, check = () => {}, baseDir }) {
  let rid;
  try {
    rid = await invoke('plugin:fs|open', { path: filePath, options: { read: true, ...(baseDir === undefined ? {} : { baseDir }) } }); check();
    if (!Number.isSafeInteger(rid) || rid < 0) throw new Error('export read handle unavailable');
    let offset = 0;
    while (true) {
      // This is TT's existing readable-file-stream-service binary protocol:
      // a bounded chunk followed by an eight-byte big-endian read count.
      const response = await invoke('plugin:fs|read', { rid, len: 512 * 1024 }); check();
      const bytes = response instanceof ArrayBuffer ? new Uint8Array(response)
        : ArrayBuffer.isView(response) ? new Uint8Array(response.buffer, response.byteOffset, response.byteLength) : null;
      if (!bytes || bytes.byteLength < 8) throw new Error('export read response invalid');
      let count = 0;
      for (let i = bytes.byteLength - 8; i < bytes.byteLength; i++) count = count * 256 + bytes[i];
      if (!Number.isSafeInteger(count) || count > 512 * 1024 || count > bytes.byteLength - 8 || offset + count > blob.size) throw new Error('export read length invalid');
      if (!count) { if (offset !== blob.size || !offset) throw new Error('export file length mismatch'); return offset; }
      const expected = new Uint8Array(await blob.slice(offset, offset + count).arrayBuffer()); check();
      for (let i = 0; i < count; i++) if (bytes[i] !== expected[i]) throw new Error('export file readback mismatch');
      offset += count;
    }
  } finally {
    if (Number.isSafeInteger(rid) && rid >= 0) await invoke('plugin:resources|close', { rid });
  }
}

export function isDesktopNativeExport(host) {
  const navigator = host?.navigator;
  const mobile = /android|iphone|ipad|ipod/i.test(navigator?.userAgent ?? '')
    || (navigator?.maxTouchPoints > 1 && /MacIntel|macintosh/i.test(`${navigator?.platform ?? ''} ${navigator?.userAgent ?? ''}`));
  return !mobile && !host?.TauriTavernAndroidPublicDownloadBridge && Boolean(host?.__TAURITAVERN__?.api)
    && typeof host?.__TAURI__?.core?.invoke === 'function' && typeof host?.__TAURI__?.path?.downloadDir === 'function';
}

export async function exportDesktopJson(blob, name, host, timeoutMs = 30000) {
  if (active.has(host)) throw exportFailure('export_desktop_busy', 'export_prepare', '上一次文件保存尚未结束，请等待后重试；原数据保留。');
  const pathApi = host?.__TAURI__?.path, core = host?.__TAURI__?.core;
  if (typeof pathApi?.join !== 'function' || typeof pathApi?.downloadDir !== 'function' || typeof core?.invoke !== 'function') {
    throw exportFailure('export_desktop_unavailable', 'export_prepare', 'TT 未提供可用的下载目录保存接口，未确认文件保存。');
  }
  const invoke = (...args) => core.invoke(...args);
  const fileName = String(name || '拾忆-导出.json').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/, '').trim() || '拾忆-导出.json';
  const state = {}; active.set(host, state);
  let relativePath, owned = false, saved = false, expired = false, timer, stage = 'export_prepare';
  const check = () => { if (expired) throw new Error('export expired'); };
  const work = (async () => {
    try {
      const downloads = await pathApi.downloadDir(); check();
      if (typeof downloads !== 'string' || !/^(?:[A-Za-z]:[\\/]|\/)/.test(downloads)) throw new Error('invalid download root');
      const random = typeof host.crypto?.randomUUID === 'function' ? host.crypto.randomUUID().replaceAll('-', '') : Math.random().toString(36).slice(2);
      const stem = fileName.replace(/\.json$/i, '').slice(0, 120);
      relativePath = `${stem}-${Date.now().toString(36)}-${(++sequence).toString(36)}-${random}.json`;
      const filePath = await pathApi.join(downloads, relativePath); check();
      if (normalized(filePath) !== `${normalized(downloads)}/${relativePath}` || /(?:^|\/)\.\.?(?:\/|$)/.test(normalized(filePath))) throw new Error('invalid export filename');
      stage = 'export_save_copy';
      for (let offset = 0; offset < blob.size; offset += CHUNK) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer()); check();
        // TT permits writes and handle-based reads in Downloads, but not mkdir,
        // stat or read_file there. createNew is an atomic no-overwrite guard.
        await invoke('plugin:fs|write_file', bytes, { headers: { path: encodeURIComponent(relativePath), options: JSON.stringify({ baseDir: 7, append: offset > 0, create: offset === 0, ...(offset === 0 ? { createNew: true } : {}) }) } }); owned = true; check();
      }
      stage = 'export_save_verify';
      await verifyNativeExportFile({ invoke, filePath: relativePath, baseDir: 7, blob, check }); check();
      saved = true;
      return { mode: 'desktop-native', status: 'saved', saved: true, savedPath: filePath,
        displayName: relativePath, exportAttempt: 'desktop', exportBytes: blob.size,
        saveLocation: `下载目录 / ${relativePath}` };
    } catch (error) {
      throw exportFailure(stage === 'export_save_verify' ? 'export_file_verify_failed' : 'export_desktop_write_failed', stage,
        stage === 'export_save_verify' ? '导出文件的内容校验未通过，没有确认保存；请重试，原数据保留。'
          : 'TT 未能完成下载目录中的文件保存；请重试，原数据保留。', error);
    } finally {
      // Only this operation's successfully created file is eligible for cleanup.
      // Some hosts deny removal; a leftover partial file is never a saved result.
      if (owned && !saved) try { await invoke('plugin:fs|remove', { path: relativePath, options: { baseDir: 7 } }); } catch { /* unconfirmed partial export only */ }
      if (active.get(host) === state) active.delete(host);
    }
  })();
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(exportFailure('export_native_failed', stage, 'TT 保存文件超时，尚未确认保存；请等待本次保存结束后重试，原数据保留。')); }, timeoutMs); timer?.unref?.();
    })]);
  } catch (error) {
    if (error?.details) error.details.exportBytes = blob.size;
    throw error;
  } finally { clearTimeout(timer); }
}
