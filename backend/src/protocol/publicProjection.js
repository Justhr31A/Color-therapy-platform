/**
 * Public projections of a PUBLISHED snapshot (pure functions).
 *
 * Every response field is listed explicitly (a whitelist): nothing is copied
 * wholesale from the snapshot, so internal fields can never leak by accident.
 * NOT exposed: protocol/canvas/version ids, owner/doctor/patient data, status,
 * lifecycle info, other versions, and any protocol metadata outside
 * `metadata.public`. Object ids ARE exposed — renderers and the AR layer need
 * a stable id per drawn object.
 *
 * `/render` is the single structured contract for the public viewer, downloads
 * and (later) AR. Future Studio-only fields (size presets/scale, Dot+Ring,
 * Finger Band, landmark references) travel inside each object's `metadata` and
 * `landmarkReference`, so adding them never changes this shape.
 */
const { HAND_ASSETS } = require('../config/handAssets');
const { assetUrlFor } = require('../utils/serialize');
const { canonicalFinger } = require('./vocabulary');

const RENDER_CONTRACT = 'protocol-render/1';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const toIso = (dbTime) => (dbTime ? `${String(dbTime).replace(' ', 'T')}Z` : null);

function publicMetadata(protocol) {
  // Only the explicitly public part of the free-form metadata is ever exposed.
  return isPlainObject(protocol.metadata) && isPlainObject(protocol.metadata.public) ? protocol.metadata.public : {};
}

function labelFor(canvas) {
  const asset = canvas.canvasType === 'hand' ? HAND_ASSETS[canvas.viewKey] : null;
  return { label: canvas.backgroundLabel || canvas.viewKey, handSide: asset ? asset.handSide : null };
}

function baseInfo(snapshot, ctx) {
  const p = snapshot.protocol;
  return {
    slug: ctx.slug,
    name: p.name,
    displayName: p.displayName || p.name,
    shortDescription: p.shortDescription,
    description: p.description,
    protocolType: p.protocolType,
    category: p.category ? { slug: p.category.slug, name: p.category.name, description: p.category.description } : null,
    conditions: p.conditions.map((c) => ({ slug: c.slug, name: c.name, description: c.description })),
    searchTerms: p.searchTerms.map((t) => t.term),
    metadata: publicMetadata(p),
    version: { number: ctx.version, publishedAt: toIso(ctx.publishedAt) },
  };
}

/** GET /api/public/protocols/:slug */
function toPublicDetail(snapshot, ctx) {
  return {
    ...baseInfo(snapshot, ctx),
    views: snapshot.canvases.map((c) => ({ viewKey: c.viewKey, ...labelFor(c), objectCount: c.objects.length })),
    links: { render: `/api/public/protocols/${ctx.slug}/render` },
  };
}

function toPublicObject(o) {
  return {
    id: o.id,
    type: o.type,
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    rotation: o.rotation,
    color: o.color,
    thickness: o.thickness,
    opacity: o.opacity,
    points: o.points,
    finger: canonicalFinger(o.finger),
    landmarkReference: o.landmarkReference,
    metadata: o.metadata,
    zIndex: o.zIndex,
  };
}

/** GET /api/public/protocols/:slug/render */
function toPublicRender(snapshot, ctx) {
  return {
    contract: RENDER_CONTRACT,
    protocol: baseInfo(snapshot, ctx),
    canvases: snapshot.canvases.map((c) => ({
      viewKey: c.viewKey,
      canvasType: c.canvasType,
      ...labelFor(c),
      background: { assetKey: c.backgroundAssetKey, url: assetUrlFor(c.canvasType, c.backgroundAssetKey) },
      width: c.width,
      height: c.height,
      sortOrder: c.sortOrder,
      objects: c.objects.map(toPublicObject),
    })),
  };
}

/** One entry of GET /api/public/protocols */
function toPublicSummary(snapshot, ctx) {
  const p = snapshot.protocol;
  return {
    slug: ctx.slug,
    name: p.name,
    displayName: p.displayName || p.name,
    shortDescription: p.shortDescription,
    category: p.category ? { slug: p.category.slug, name: p.category.name } : null,
    conditions: p.conditions.map((c) => ({ slug: c.slug, name: c.name })),
    version: { number: ctx.version, publishedAt: toIso(ctx.publishedAt) },
  };
}

module.exports = { RENDER_CONTRACT, toPublicDetail, toPublicRender, toPublicSummary, toPublicObject, toIso };
