import { foldName } from '../src/name-fold.js';
import { sha256, stableStringify } from '../src/utils.js';

// Device-only presentation data. This module deliberately has no workspace,
// provider, backup or recall imports.
const PREFIX = 'memo-tt-person-avatars-v1:';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_CHARS = 192 * 1024;
const MAX_DOCUMENT_CHARS = 2 * 1024 * 1024;
const IMAGE_SIZE = 256;
const keyPattern = /^[cn]:[a-f0-9]{64}$/;
const empty = () => ({ version: 1, images: {}, names: {} });
const fail = message => Object.assign(new Error(message), { code: 'PERSON_AVATAR_ERROR' });

function scopeKey(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !Object.keys(scope).length) throw fail('请先打开聊天，再设置人物头像');
  return PREFIX + sha256(stableStringify(scope));
}

function identity(group) {
  if (!group || group.ambiguous) throw fail('请先确认这个称呼属于哪位人物，再设置头像');
  const name = foldName(String(group.name ?? group.key ?? '').trim());
  if (!name || name.length > 160) throw fail('没有可识别的人物姓名');
  // A generated profile ID may change every batch. Only characterId is a
  // stable identity; otherwise use the explicit canonical name, never aliases.
  const characterId = group.characterId ?? [...(group.profiles ?? []), ...(group.profileSources ?? [])].find(p => typeof p?.characterId === 'string' && p.characterId)?.characterId;
  const nameKey = `n:${sha256(name)}`;
  return { name: nameKey, owner: characterId ? `c:${sha256(String(characterId))}` : nameKey, stable: Boolean(characterId) };
}

function safeSource(value) {
  return typeof value === 'string' && value.length <= MAX_IMAGE_CHARS && /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function decodeDocument(raw) {
  if (raw == null) return empty();
  if (typeof raw !== 'string' || raw.length > MAX_DOCUMENT_CHARS) throw fail('本机头像数据超出容量，旧头像已保留');
  let value;
  try { value = JSON.parse(raw); } catch { throw fail('本机头像数据读取失败，旧头像已保留'); }
  if (value?.version !== 1 || !value.images || typeof value.images !== 'object' || Array.isArray(value.images) || !value.names || typeof value.names !== 'object' || Array.isArray(value.names)) throw fail('本机头像数据格式不兼容，旧头像已保留');
  for (const [key, src] of Object.entries(value.images)) if (!keyPattern.test(key) || !safeSource(src)) throw fail('本机头像数据含无效图片，旧头像已保留');
  for (const [key, owner] of Object.entries(value.names)) if (!/^n:[a-f0-9]{64}$/.test(key) || !keyPattern.test(owner) || !value.images[owner]) throw fail('本机头像身份数据无效，旧头像已保留');
  return value;
}

function ownerFor(doc, person) {
  if (doc.images[person.owner]) return person.owner;
  const named = doc.names[person.name];
  // A name-only avatar may follow that person's first generated dossier. A
  // different stable character with the same name must never inherit it.
  return named && (!person.stable || named.startsWith('n:')) ? named : null;
}

function prune(doc) {
  for (const [name, owner] of Object.entries(doc.names)) if (!doc.images[owner]) delete doc.names[name];
}

function imageKind(bytes) {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return '';
}

async function decodedImage(host, file) {
  if (typeof host.createImageBitmap === 'function') return host.createImageBitmap(file);
  if (!host.Image || !host.URL?.createObjectURL) throw fail('当前宿主暂不支持读取头像图片');
  const url = host.URL.createObjectURL(file);
  try {
    const image = new host.Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(fail('图片无法解码，请选择正常的 PNG、JPEG 或 WebP 图片')); image.src = url; });
    return image;
  } finally { host.URL.revokeObjectURL(url); }
}

async function thumbnail(host, file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || typeof file.arrayBuffer !== 'function') throw fail('头像只支持 PNG、JPEG 或 WebP 图片');
  if (!Number.isFinite(file.size) || file.size < 1 || file.size > MAX_FILE_BYTES) throw fail('头像原图最大 8 MB，旧头像已保留');
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (imageKind(bytes) !== file.type) throw fail('图片内容与格式不符，请重新选择图片');
  let image;
  try { image = await decodedImage(host, file); }
  catch (error) { if (error?.code === 'PERSON_AVATAR_ERROR') throw error; throw fail('图片无法解码，请重新选择图片'); }
  try {
    const width = image.naturalWidth ?? image.width, height = image.naturalHeight ?? image.height;
    if (!(width > 0 && height > 0) || width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) throw fail('图片尺寸过大或无效，请先缩小图片');
    const canvas = host.document?.createElement('canvas'), context = canvas?.getContext('2d');
    if (!context) throw fail('当前宿主暂不支持生成头像缩略图');
    canvas.width = canvas.height = IMAGE_SIZE;
    context.fillStyle = '#e8dec8'; context.fillRect(0, 0, IMAGE_SIZE, IMAGE_SIZE);
    const edge = Math.min(width, height);
    context.drawImage(image, (width - edge) / 2, (height - edge) / 2, edge, edge, 0, 0, IMAGE_SIZE, IMAGE_SIZE);
    for (const quality of [0.88, 0.7, 0.5]) {
      const src = canvas.toDataURL('image/jpeg', quality);
      if (safeSource(src)) return src;
    }
    throw fail('缩略图仍超过 192 KB，请选择更简单的图片；旧头像已保留');
  } finally { image.close?.(); }
}

/** Chat-scoped device avatars. Reads are cached and never write storage. */
export function createPersonAvatarStore({ host = globalThis } = {}) {
  const cache = new Map();
  let revision = 0;
  const storage = () => { try { if (host.localStorage) return host.localStorage; } catch {} throw fail('当前宿主无法保存本机头像，旧头像已保留'); };
  function load(key) {
    if (cache.has(key)) return cache.get(key);
    let entry;
    try { const raw = storage().getItem(key); entry = { raw, doc: decodeDocument(raw) }; }
    catch (error) { entry = { error }; }
    if (cache.size >= 4) cache.delete(cache.keys().next().value);
    cache.set(key, entry);
    return entry;
  }
  function mutate(scope, callback) {
    const key = scopeKey(scope), prior = load(key);
    if (prior.error) throw prior.error;
    const doc = structuredClone(prior.doc);
    if (callback(doc) === false) return;
    prune(doc);
    const raw = JSON.stringify(doc);
    if (raw.length > MAX_DOCUMENT_CHARS) throw fail('本聊天头像总量达到 2 MB，请先移除部分头像；旧头像已保留');
    const store = storage();
    try { store.setItem(key, raw); }
    catch { throw fail('本机头像空间不足或不可写，旧头像已保留'); }
    let actual;
    try { actual = store.getItem(key); } catch {}
    if (actual !== raw) {
      try { prior.raw == null ? store.removeItem(key) : store.setItem(key, prior.raw); } catch {}
      cache.delete(key);
      throw fail('头像保存未通过读回确认，请重试');
    }
    cache.set(key, { raw, doc }); revision++;
  }
  const storageChanged = event => {
    if (event.key == null || String(event.key).startsWith(PREFIX)) { cache.clear(); revision++; }
  };
  host.addEventListener?.('storage', storageChanged);
  return {
    get revision() { return revision; },
    read(scope, group) {
      try { const entry = load(scopeKey(scope)); if (entry.error) return ''; const owner = ownerFor(entry.doc, identity(group)); return owner ? entry.doc.images[owner] : ''; }
      catch { return ''; }
    },
    async set(scope, group, file) {
      // Freeze the intended scope/person before asynchronous decoding. Switching
      // chats during upload cannot attach the image to the next open person.
      scopeKey(scope); const person = identity(group), frozenScope = structuredClone(scope);
      const src = await thumbnail(host, file);
      mutate(frozenScope, doc => {
        const previous = ownerFor(doc, person);
        doc.images[person.owner] = src; doc.names[person.name] = person.owner;
        if (previous?.startsWith('n:') && previous !== person.owner && !Object.values(doc.names).includes(previous)) delete doc.images[previous];
      });
      return src;
    },
    remove(scope, group) {
      const person = identity(group);
      mutate(scope, doc => { const owner = ownerFor(doc, person); if (!owner) return false; delete doc.images[owner]; });
    },
    rename(scope, fromGroup, nextName) {
      const from = identity(fromGroup), to = identity({ ...fromGroup, name: nextName });
      mutate(scope, doc => {
        const owner = ownerFor(doc, from); if (!owner || from.name === to.name) return false;
        const other = ownerFor(doc, to);
        if (other && other !== owner && doc.images[other] !== doc.images[owner]) throw fail('新姓名已有另一个头像，原头像保留；请合并档案后再调整');
        doc.images[to.owner] = doc.images[owner]; doc.names[to.name] = to.owner; delete doc.names[from.name];
        if (owner !== to.owner && !Object.values(doc.names).includes(owner)) delete doc.images[owner];
      });
    },
    merge(scope, sourceGroup, targetGroup) {
      const source = identity(sourceGroup), target = identity(targetGroup);
      mutate(scope, doc => {
        const from = ownerFor(doc, source); if (!from) return false;
        const existing = ownerFor(doc, target);
        if (existing) return false;
        doc.images[target.owner] = doc.images[from]; doc.names[target.name] = target.owner;
        // Keep the absorbed source's local avatar for an explicit dossier undo.
      });
    },
    dispose() { host.removeEventListener?.('storage', storageChanged); cache.clear(); },
  };
}
