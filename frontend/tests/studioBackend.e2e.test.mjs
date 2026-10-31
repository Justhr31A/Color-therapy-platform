/**
 * [DETERMINISTIC SOFTWARE TESTS — frontend + backend together] The REAL Studio store saves through the REAL backend service into a
 * REAL (disposable) PostgreSQL database, then reloads. This is the closest a test can get to "doctor draws, saves, reloads" without a browser:
 * it proves the objects the Studio actually produces are accepted by the API, survive storage, come back identical, and can be published.
 * (Only the HTTP transport and the login are bypassed; the service, validation, database and snapshots are the shipped code.)
 * Needs TEST_DATABASE_URL (a disposable PostgreSQL server); without it this test FAILS, it is never silently skipped.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import useProtocolStore from '../src/builder/store.js';
import api from './support/stubs/apiClient.mjs';
import {
  TOOL_IDS, getRing, hasActiveRing, getBand, getText, patchText, patchScale, addRing, patchRingAt, getRings, hasRings, patchOutline, patchThickness,
  patchThicknessPreset, patchSizePreset, patchBandFinger, patchBandType,
} from '../src/builder/model/objectModel.js';
import { axisPoint } from '../src/builder/model/fingerGeometry.js';

const require = createRequire(import.meta.url);
const { missingReason } = require('../../backend/tests/helpers/testDb.js');
const SKIP = missingReason('pg', 'uuid');

const S = () => useProtocolStore.getState();
const wire = (v) => JSON.parse(JSON.stringify(v)); // what HTTP does to data
const KEYS = ['left_front', 'right_front', 'left_back', 'right_back'];
const place = (tool, viewKey, x = 0.4, y = 0.5) => {
  S().setActiveTool(tool);
  S().addObjectAtPoint(x, y, S().canvases.find((c) => c.viewKey === viewKey).id);
  return S().getSelectedObject();
};
const edit = (o, patch) => S().commitObjectChange(o.id, patch);
const objectsOf = (k) => S().canvases.find((c) => c.viewKey === k).objects;

describe('[DETERMINISTIC · real store + real backend + real database] Studio round trip', { skip: SKIP }, () => {
  let env; let protocolId;

  before(async () => { env = await require('../../backend/tests/helpers/publishingEnv.js').makeEnv(); });
  after(async () => { if (env) await env.cleanup(); });

  beforeEach(async () => {
    api.reset();
    protocolId = (await env.protocols.create({ name: `E2E ${Date.now()}${Math.random()}` }, env.actor));
    // The doctor's save endpoint, backed by the real service: exactly what POST /api/protocols/:id/save does.
    api.handler = async (url, body) => {
      const m = url.match(/^\/protocols\/([^/]+)\/save$/);
      if (!m) throw new Error(`unexpected call ${url}`);
      (await env.protocols.saveCanvases(m[1], wire(body).canvases, env.actor));
      return { data: wire((await env.protocols.getFull(m[1]))) };
    };
    S().loadProtocol(wire((await env.protocols.getFull(protocolId))));
  });

  /** Draws a rich protocol across all four views, the way a doctor would. */
  const draw = () => {
    place('dot', 'left_front', 0.3, 0.6);
    const ring = place('ring', 'right_front', 0.5, 0.5);
    edit(ring, patchThicknessPreset(ring, 'large'));
    edit(objectsOf('right_front')[0], patchScale(objectsOf('right_front')[0], 0.8));

    const dr = place('dotRing', 'left_back', 0.6, 0.6);
    const cur = () => objectsOf('left_back')[0];
    edit(dr, patchRingAt(dr, 0, { color: '#1a73e8', thickness: 14 }));
    edit(cur(), addRing(cur()));
    edit(cur(), patchRingAt(cur(), 1, { color: '#f76b15', thickness: 40000, outline: { enabled: true, color: '#000000', thickness: 6 } })); // a huge ring
    edit(cur(), addRing(cur()));
    edit(cur(), patchRingAt(cur(), 2, { color: '#46a758', thickness: 9 }));
    edit(cur(), patchOutline(cur(), { enabled: true, color: '#ffffff', thickness: 3 }));

    const p = axisPoint('right_back', 'ring', 0.4);
    const band = place('fingerBand', 'right_back', p.x, p.y);
    edit(band, patchBandType(band, 'double'));
    edit(objectsOf('right_back')[0], { color: '#12a594', opacity: 0.7 });

    const t = place('text', 'right_back', 0.5, 0.85);
    edit(t, patchText(t, 'Hold 3 minutes'));
    edit(objectsOf('right_back')[1], patchSizePreset(objectsOf('right_back')[1], 'large'));
  };

  // The database orders objects by z_index then id (see protocols.repo.js). Two objects created in the same
  // millisecond (as `draw()` does synchronously) tie on z_index, and id — a fresh UUID — is not meant to be a
  // stable ordering key, so which one comes first after a round trip is not guaranteed. That has no bearing on
  // whether the round trip preserved the data, so comparisons here are keyed by object id instead of position.
  const byId = (canvases) => canvases.map((c) => ({ viewKey: c.viewKey, objects: Object.fromEntries(c.objects.map((o) => [o.id, o])) }));

  it('saves all four views in one call and reloads everything identically', async () => {
    draw();
    const before = byId(wire(S().canvases));
    await S().save();
    assert.equal(api.calls.length, 1);
    assert.equal(S().isDirty, false);

    // What the DATABASE holds, read back independently of the store:
    const stored = (await env.protocols.getFull(protocolId));
    assert.deepEqual(stored.canvases.map((c) => c.viewKey), KEYS);
    assert.deepEqual(stored.canvases.map((c) => c.objects.length), [1, 1, 1, 2]);

    // Reload from the server into a fresh store: every value is back, object for object, value for value.
    S().loadProtocol(wire(stored));
    assert.deepEqual(byId(wire(S().canvases)), before, 'reloaded protocol equals what the doctor drew');
  });

  it('each Studio feature is present after the reload', async () => {
    draw();
    await S().save();
    S().loadProtocol(wire((await env.protocols.getFull(protocolId))));

    const dot = objectsOf('left_front')[0];
    assert.equal(dot.type, 'dot');
    assert.equal(hasActiveRing(dot), false);

    const ring = objectsOf('right_front')[0];
    assert.deepEqual([ring.metadata.thicknessPreset, ring.metadata.scale, ring.thickness], ['large', 0.8, 8]);

    const dr = objectsOf('left_back')[0];
    assert.equal(objectsOf('left_back').length, 1, 'Dot + Ring is still ONE stored object');
    assert.equal(getRings(dr).length, 3, 'three attached rings, all inside the one stored object');
    assert.deepEqual(getRings(dr).map((r) => [r.color, r.thickness]), [['#1a73e8', 14], ['#f76b15', 40000], ['#46a758', 9]]);
    assert.deepEqual(getRings(dr)[1].outline, { enabled: true, color: '#000000', thickness: 6 });
    assert.deepEqual(dr.metadata.outline, { enabled: true, color: '#ffffff', thickness: 3 });
    assert.equal('ring' in dr.metadata, false, 'no legacy ring is written for new objects');

    // right_back holds a band and a text object; their relative order after a round trip is not guaranteed
    // (see the `byId` comment above), so each is found by type rather than assumed to be at a given index.
    assert.equal(objectsOf('right_back').length, 2);
    const band = objectsOf('right_back').find((o) => o.type === 'fingerBand');
    assert.ok(band, 'the band survived the round trip');
    assert.equal(band.finger, 'ring');
    assert.deepEqual([getBand(band).type, getBand(band).position], ['double', 0.4]);
    assert.deepEqual([band.color, band.opacity, band.landmarkReference], ['#12a594', 0.7, null]);

    const text = objectsOf('right_back').find((o) => o.type === 'text');
    assert.ok(text, 'the text object survived the round trip');
    assert.deepEqual([getText(text), text.metadata.sizePreset], ['Hold 3 minutes', 'large']);
  });

  it('editing a DUPLICATE (after a save and reload) never changes the original in the database', async () => {
    draw();
    await S().save();
    S().loadProtocol(wire((await env.protocols.getFull(protocolId))));
    const original = objectsOf('left_back')[0];
    S().selectObject(original.id);
    S().duplicateSelected();
    const dup = S().getSelectedObject();
    edit(dup, patchRingAt(dup, 0, { color: '#111111' }));
    await S().save();
    const stored = (await env.protocols.getFull(protocolId)).canvases[2].objects;
    assert.equal(stored.length, 2);
    assert.equal(getRings(stored.find((o) => o.id === original.id))[0].color, '#1a73e8');
    assert.equal(getRings(stored.find((o) => o.id === dup.id))[0].color, '#111111');
  });

  it('EVERY tool produces an object the server accepts and that passes publish validation', async () => {
    const drawing = TOOL_IDS.filter((t) => t !== 'select' && t !== 'eraser');
    drawing.forEach((tool, i) => place(tool, KEYS[i % 4], 0.3 + (i % 5) * 0.08, 0.5));
    assert.equal(S().canvases.flatMap((c) => c.objects).length, drawing.length);
    await S().save();                                   // the service validates types and fields on save
    const published = (await env.protocols.publish(protocolId, env.actor, {}));
    assert.ok(published, 'passes the same validation a real publish runs');
    const render = (await env.publicSvc.getRender((await env.protocols.getFull(protocolId)).slug));
    assert.equal(render.canvases.flatMap((c) => c.objects).length, drawing.length);
  });

  it('after publishing, further Studio edits stay in the draft and the published version does not change', async () => {
    draw();
    await S().save();
    (await env.protocols.publish(protocolId, env.actor, {}));
    const slug = (await env.protocols.getFull(protocolId)).slug;
    const frozen = JSON.stringify((await env.publicSvc.getRender(slug)));
    const versionRow = async () => (await env.row('SELECT snapshot_json, checksum FROM protocol_versions WHERE protocol_id = $1 AND kind = $2', protocolId, 'published'));
    const frozenRow = await versionRow();

    S().loadProtocol(wire((await env.protocols.getFull(protocolId))));
    const dr = objectsOf('left_back')[0];
    edit(dr, patchRingAt(dr, 0, { color: '#111111' }));
    const band = objectsOf('right_back')[0];
    edit(band, patchBandFinger(band, 'right_back', { width: 1971, height: 2010 }, 'thumb'));
    S().deleteObject(objectsOf('left_front')[0].id);
    await S().save();

    assert.equal(JSON.stringify((await env.publicSvc.getRender(slug))), frozen, 'the public render is byte-identical');
    assert.deepEqual(await versionRow(), frozenRow, 'the stored published version is untouched');
    const full = (await env.protocols.getFull(protocolId));
    assert.equal(full.hasUnpublishedChanges, true);
    assert.equal(full.status, 'published');
    assert.equal(getRings(full.canvases[2].objects[0])[0].color, '#111111', 'the draft did take the edits');
  });

  it('import -> save -> reload: an imported file becomes stored, structured, independent data', async () => {
    draw();
    const exported = wire(S().exportProtocolData());
    S().loadProtocol(wire((await env.protocols.getFull((await env.protocols.create({ name: `Import target ${Math.random()}` }, env.actor))))));
    const targetId = S().protocol.id;
    assert.equal(S().importProtocolData(exported).ok, true);
    await S().save();
    const stored = (await env.protocols.getFull(targetId));
    assert.deepEqual(stored.canvases.map((c) => c.objects.length), [1, 1, 1, 2]);
    const sourceIds = exported.views.flatMap((v) => v.objects.map((o) => o.id));
    assert.equal(stored.canvases.flatMap((c) => c.objects).filter((o) => sourceIds.includes(o.id)).length, 0, 'fresh ids: no collision with the protocol it came from');
    assert.equal(getRings(stored.canvases[2].objects[0])[0].color, '#1a73e8');
  });
});
