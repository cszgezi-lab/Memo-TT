const VERSION = '1.0.15';
const identities = new Map();

function name(value, kind) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw Object.assign(new TypeError(`Memo ${kind} must be a non-empty name`), { code: 'MEMO_IDENTITY_ARGUMENT' });
  }
  return value;
}

/** One build identity for ownership at the host boundary, not a data migration.
 * Existing document kinds, chat identities and source provenance stay intact. */
export function createMemoIdentity(edition = 'tt') {
  if (!['tt', 'st'].includes(edition)) {
    throw Object.assign(new TypeError('Memo edition must be tt or st'), { code: 'MEMO_IDENTITY_ARGUMENT' });
  }
  if (identities.has(edition)) return identities.get(edition);
  const id = `memo-${edition}`, prefix = `${id}-`;
  const qualify = (value, kind) => {
    const logical = name(value, kind);
    return logical.startsWith(prefix) ? logical : prefix + logical;
  };
  const identity = Object.freeze({
    id, edition, version: VERSION, displayName: 'Memo', prefix,
    repository: `https://github.com/cszgezi-lab/Memo-${edition.toUpperCase()}`,
    namespace: value => qualify(value, 'namespace'),
    promptKey: value => qualify(value, 'prompt key'),
    metadataNamespace: value => qualify(value, 'metadata namespace'),
    domId: value => qualify(value, 'DOM ID'),
    preferenceKey: value => qualify(value, 'preference key'),
    avatarPrefix: `${prefix}person-avatars-v1:`,
    personaMarker: `MEMO_${edition.toUpperCase()}_PERSONA`,
  });
  identities.set(edition, identity);
  return identity;
}

export const MEMO_VERSION = VERSION;
export const MEMO_TT_IDENTITY = createMemoIdentity('tt');
export const MEMO_ST_IDENTITY = createMemoIdentity('st');
