/**
 * Protocol snapshot format (schema version 2) and integrity helpers.
 *
 * A snapshot is the COMPLETE, self-contained description of a protocol at one
 * moment: metadata, lifecycle info, category, conditions, search terms, every
 * canvas and every object with all of its properties (normalized coordinates,
 * finger, landmarkReference, metadata …). It is what gets stored, frozen, in
 * protocol_versions.snapshot_json and what the public API is built from — the
 * public side never reads editable draft rows.
 *
 * Text is stored with SORTED keys (canonicalStringify) so the same content
 * always produces the same bytes and therefore the same SHA-256 checksum.
 *
 * schemaVersion 1 = the older, partial snapshots written before this phase
 * (protocol name/description + canvases only). They are kept untouched and are
 * still readable/restorable; see normalizeSnapshot().
 */
const crypto = require('crypto');

const SNAPSHOT_SCHEMA_VERSION = 2;

function canon(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('A non-finite number (NaN/Infinity) cannot be stored in a snapshot.');
      return JSON.stringify(value);
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'undefined':
      return undefined; // omitted from objects, null inside arrays — same as JSON
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => { const s = canon(v); return s === undefined ? 'null' : s; }).join(',')}]`;
      const parts = [];
      for (const key of Object.keys(value).sort()) {
        const s = canon(value[key]);
        if (s !== undefined) parts.push(`${JSON.stringify(key)}:${s}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`A value of type ${typeof value} cannot be stored in a snapshot.`);
  }
}

/** Deterministic JSON text: identical content -> identical string. Throws if it cannot be serialized. */
function canonicalStringify(value) {
  return canon(value);
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const parseJsonOrNull = (text) => (text ? JSON.parse(text) : null);
const isoNow = () => new Date().toISOString();

/**
 * Builds a schema-2 snapshot from a loaded working copy.
 *
 * @param working  { protocol: <protocols row>, category: <categories row|null>, conditions: [<conditions row>],
 *                   searchTerms: [<protocol_search_terms row>], canvases: [<serializeCanvasRow output>] }
 * @param lifecycle { status, kind: 'checkpoint'|'published', versionNumber, restoredFromVersion?: number|null, createdAt? }
 */
function buildSnapshot(working, lifecycle) {
  const p = working.protocol;
  const bySlug = (a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    protocol: {
      id: p.id,
      slug: p.slug,
      name: p.name,
      displayName: p.display_name || null,
      shortDescription: p.short_description || '',
      description: p.description || '',
      protocolType: p.protocol_type,
      metadata: parseJsonOrNull(p.metadata_json) || {},
      category: working.category
        ? { id: working.category.id, slug: working.category.slug, name: working.category.name, description: working.category.description || '' }
        : null,
      conditions: [...working.conditions]
        .sort(bySlug)
        .map((c) => ({ id: c.id, slug: c.slug, name: c.name, description: c.description || '' })),
      searchTerms: [...working.searchTerms]
        .sort((a, b) => (a.term_normalized < b.term_normalized ? -1 : a.term_normalized > b.term_normalized ? 1 : 0))
        .map((t) => ({ term: t.term, kind: t.kind })),
    },
    lifecycle: {
      status: lifecycle.status,
      kind: lifecycle.kind,
      versionNumber: lifecycle.versionNumber,
      restoredFromVersion: lifecycle.restoredFromVersion === undefined ? null : lifecycle.restoredFromVersion,
      createdAt: lifecycle.createdAt || isoNow(),
    },
    canvases: working.canvases.map((c) => ({
      id: c.id,
      canvasType: c.canvasType,
      viewKey: c.viewKey,
      backgroundAssetKey: c.backgroundAssetKey,
      backgroundLabel: c.backgroundLabel,
      isPlaceholderAsset: c.isPlaceholderAsset,
      width: c.width,
      height: c.height,
      sortOrder: c.sortOrder,
      objects: c.objects,
    })),
  };
}

/**
 * Fingerprint of the protocol CONTENT only — excludes ids that change on
 * duplicate/restore, the slug (a URL identity that takes effect immediately)
 * and the lifecycle block (timestamps/status). Two snapshots with the same
 * fingerprint publish identically. Used to tell whether the editable working
 * copy differs from what is currently published.
 */
function contentFingerprint(snapshot) {
  const { id, slug, ...protocolContent } = snapshot.protocol; // eslint-disable-line no-unused-vars
  const canvases = snapshot.canvases.map(({ id: canvasId, ...rest }) => rest); // eslint-disable-line no-unused-vars
  return sha256Hex(canonicalStringify({ protocol: protocolContent, canvases }));
}

/** Old (schema 1) snapshots have no schemaVersion; give them a uniform shape without altering stored data. */
function normalizeSnapshot(parsed) {
  if (parsed && parsed.schemaVersion >= 2) return parsed;
  const p = (parsed && parsed.protocol) || {};
  return {
    schemaVersion: 1,
    protocol: { id: p.id, name: p.name, description: p.description, protocolType: p.protocolType },
    canvases: (parsed && parsed.canvases) || [],
  };
}

/** True if the stored text still matches the checksum recorded when the version was created. */
function verifyChecksum(snapshotJson, checksum) {
  return Boolean(checksum) && sha256Hex(snapshotJson) === checksum;
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  canonicalStringify,
  sha256Hex,
  buildSnapshot,
  contentFingerprint,
  normalizeSnapshot,
  verifyChecksum,
};
