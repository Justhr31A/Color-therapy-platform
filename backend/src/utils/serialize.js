const { HAND_ASSETS } = require('../config/handAssets');
const { ORGAN_ASSETS } = require('../config/organAssets');

function assetFor(canvasType, assetKey) {
  const registry = canvasType === 'hand' ? HAND_ASSETS : ORGAN_ASSETS;
  return registry[assetKey] || null;
}

function assetUrlFor(canvasType, assetKey) {
  const asset = assetFor(canvasType, assetKey);
  const folder = canvasType === 'hand' ? 'hands' : 'organs';
  return asset ? `/static/${folder}/${asset.file}` : null;
}

function serializeObjectRow(row) {
  return {
    id: row.id,
    type: row.object_type,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    rotation: row.rotation,
    color: row.color,
    thickness: row.thickness,
    opacity: row.opacity,
    points: row.points_json ? JSON.parse(row.points_json) : null,
    finger: row.finger,
    landmarkReference: row.landmark_json ? JSON.parse(row.landmark_json) : null,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    zIndex: row.z_index,
  };
}

function serializeCanvasRow(row, objectRows) {
  const asset = assetFor(row.canvas_type, row.background_asset_key);
  return {
    id: row.id,
    canvasType: row.canvas_type,
    viewKey: row.view_key,
    backgroundAssetKey: row.background_asset_key,
    backgroundUrl: assetUrlFor(row.canvas_type, row.background_asset_key),
    backgroundLabel: asset ? asset.label : row.view_key,
    // Surfaced so the UI can show a clear "placeholder — not a final asset"
    // banner instead of silently presenting a stand-in as a finished diagram.
    isPlaceholderAsset: Boolean(asset && asset.isPlaceholder),
    width: row.width,
    height: row.height,
    sortOrder: row.sort_order,
    objects: objectRows.map(serializeObjectRow),
  };
}

/**
 * `options.extended` adds the publishing/metadata fields. Only the builder's
 * protocol routes ask for it; the patient routes call this without options, so
 * what patients receive is unchanged.
 */
function serializeProtocolRow(row, canvases, patientRow, options = {}) {
  const extra = options.extended
    ? {
        slug: row.slug,
        displayName: row.display_name,
        shortDescription: row.short_description,
        categoryId: row.category_id,
        metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
        publishedVersionId: row.published_version_id,
        publishedAt: row.published_at,
      }
    : {};
  return {
    ...extra,
    id: row.id,
    name: row.name,
    description: row.description,
    protocolType: row.protocol_type,
    status: row.status,
    currentVersion: row.current_version,
    doctorId: row.doctor_id,
    patient: patientRow
      ? { id: patientRow.id, name: patientRow.name, email: patientRow.email, status: patientRow.status }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canvases,
  };
}

module.exports = { serializeObjectRow, serializeCanvasRow, serializeProtocolRow, assetUrlFor };
