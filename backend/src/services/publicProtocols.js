'use strict';

const { createProtocolRepository } = require('../repositories/protocols.repo');
const { createCatalogRepository } = require('../repositories/catalog.repo');
const { verifyChecksum } = require('../protocol/snapshot');
const { isValidSlug } = require('./slug');
const { HttpError } = require('../utils/errors');
const { toPublicDetail, toPublicRender, toPublicSummary } = require('../protocol/publicProjection');

const normalize = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Public reading of PUBLISHED protocols. Everything here comes from the frozen
 * snapshot of the published version (protocols.published_version_id) — never
 * from the editable working-copy rows — so drafts, later edits and other
 * versions are invisible by construction.
 */
function createPublicProtocolService(db) { // `db`: the PostgreSQL app database. Every method is async.
  const repo = createProtocolRepository(db);
  const catalog = createCatalogRepository(db);

  /** Parses a stored snapshot after re-checking its checksum. A mismatch means tampering/corruption: refuse to serve it. */
  function parseVerified(row) {
    if (!verifyChecksum(row.snapshot_json, row.checksum)) {
      console.error(`[public] integrity check failed for published protocol "${row.slug}" (version ${row.version}).`); // eslint-disable-line no-console
      throw new HttpError(500, 'This protocol is temporarily unavailable.');
    }
    const snapshot = JSON.parse(row.snapshot_json);
    if (!snapshot.schemaVersion || snapshot.schemaVersion < 2) return null; // published versions are always schema 2
    return snapshot;
  }

  async function loadPublished(slug) {
    if (!isValidSlug(slug)) return null;
    const row = await repo.findPublishedBySlug(slug);
    // Belt and braces on top of the SQL join and the database triggers:
    if (!row || row.kind !== 'published' || row.protocol_id !== row.id) return null;
    const snapshot = parseVerified(row);
    if (!snapshot) return null;
    return { snapshot, ctx: { slug: row.slug, version: row.version, publishedAt: row.published_at } };
  }

  function score(snapshot, phrase, tokens) {
    const p = snapshot.protocol;
    const terms = p.searchTerms.map((t) => normalize(t.term));
    const names = [normalize(p.displayName), normalize(p.name)].filter(Boolean);
    const conds = p.conditions.map((c) => normalize(c.name));
    const short = normalize(p.shortDescription);
    let s = 0;
    if (terms.includes(phrase)) s += 100;
    else if (terms.some((t) => t.length >= 3 && (t.includes(phrase) || phrase.includes(t)))) s += 60;
    if (names.some((n) => n.includes(phrase))) s += 50;
    if (conds.some((c) => c.includes(phrase))) s += 40;
    if (short.includes(phrase)) s += 20;
    const haystack = [...terms, ...names, ...conds, short].join(' ');
    tokens.forEach((t) => { if (haystack.includes(t)) s += 5; });
    return s;
  }

  return {
    /** null when the protocol is not currently published (draft, in review, archived, unknown — all look the same). */
    async getDetail(slug) {
      const found = await loadPublished(slug);
      return found ? toPublicDetail(found.snapshot, found.ctx) : null;
    },

    async getRender(slug) {
      const found = await loadPublished(slug);
      return found ? toPublicRender(found.snapshot, found.ctx) : null;
    },

    /**
     * Every currently PUBLISHED protocol as its public detail projection (the exact fields GET /protocols/:slug
     * already exposes), for the AI Protocol Assistant's matcher. Same published-snapshot source as `list()`: never a
     * draft, never a second query path. A damaged snapshot is skipped rather than failing the whole call.
     */
    async listForMatching() {
      const out = [];
      for (const row of await repo.listPublishedWithVersions()) {
        let snapshot;
        try { snapshot = parseVerified(row); } catch (e) { continue; }
        if (!snapshot) continue;
        out.push(toPublicDetail(snapshot, { slug: row.slug, version: row.version, publishedAt: row.published_at }));
      }
      return out;
    },

    /**
     * Categories that currently have at least one PUBLISHED protocol, for the public site's category list —
     * reads the same published snapshots `list()` already reads (never a second query path, never a draft),
     * so a category only ever appears here because a real, published protocol actually belongs to it.
     */
    async listCategories() {
      const seen = new Map();
      for (const row of await repo.listPublishedWithVersions()) {
        let snapshot;
        try { snapshot = parseVerified(row); } catch (e) { continue; } // one damaged protocol must not take the whole list down
        if (!snapshot) continue;
        const cat = snapshot.protocol.category;
        if (cat && !seen.has(cat.slug)) seen.set(cat.slug, { slug: cat.slug, name: cat.name });
      }
      return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    },

    /** Browse/search published protocols. `q` matches search terms first, then names, conditions and short description. */
    async list({ q, category, condition, limit = 20, offset = 0 } = {}) {
      const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
      const off = Math.max(parseInt(offset, 10) || 0, 0);

      // category/condition filters are slugs of ACTIVE categories/conditions; an unknown or inactive one matches nothing.
      let categoryId = null;
      let conditionId = null;
      if (category) {
        const c = isValidSlug(String(category)) ? await catalog.findBySlug('category', String(category)) : null;
        if (!c || !c.is_active) return { total: 0, limit: lim, offset: off, items: [] };
        categoryId = c.id;
      }
      if (condition) {
        const c = isValidSlug(String(condition)) ? await catalog.findBySlug('condition', String(condition)) : null;
        if (!c || !c.is_active) return { total: 0, limit: lim, offset: off, items: [] };
        conditionId = c.id;
      }
      const phrase = normalize(String(q || '').slice(0, 100));
      const tokens = phrase ? phrase.split(' ').filter((t) => t.length >= 2) : [];

      const entries = [];
      for (const row of await repo.listPublishedWithVersions()) {
        let snapshot;
        try { snapshot = parseVerified(row); } catch (e) { continue; } // one damaged protocol must not take the whole list down
        if (!snapshot) continue;
        const p = snapshot.protocol;
        if (categoryId && !(p.category && p.category.id === categoryId)) continue;
        if (conditionId && !p.conditions.some((c) => c.id === conditionId)) continue;
        const s = phrase ? score(snapshot, phrase, tokens) : 0;
        if (phrase && s === 0) continue;
        entries.push({ s, item: toPublicSummary(snapshot, { slug: row.slug, version: row.version, publishedAt: row.published_at }) });
      }
      entries.sort((a, b) => b.s - a.s || a.item.displayName.localeCompare(b.item.displayName) || (a.item.slug < b.item.slug ? -1 : 1));
      return { total: entries.length, limit: lim, offset: off, items: entries.slice(off, off + lim).map((e) => e.item) };
    },
  };
}

module.exports = { createPublicProtocolService };
