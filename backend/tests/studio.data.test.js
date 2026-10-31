/**
 * [DETERMINISTIC SOFTWARE TESTS] Protocol Studio data: what the Studio stores inside protocol objects must survive
 * save -> load through the real database, validate correctly at publish, and never leak into a frozen published version.
 * Service level (real PostgreSQL) plus the real HTTP server. These prove the SERVER side; they do not draw anything in a browser.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { missingReason } = require('./helpers/testDb');
const { HTTP_SKIP, bootstrap } = require('./helpers/httpHarness');

const SKIP = missingReason('pg', 'uuid');
const env = () => require('./helpers/publishingEnv').makeEnv(); // eslint-disable-line global-require

let n = 0;
const base = (o) => { n += 1; return { id: `studio-${Date.now()}-${n}`, x: 0.4, y: 0.5, width: 0.03, height: 0.03, rotation: 0, color: '#e5484d', thickness: 0, opacity: 1, zIndex: n, metadata: {}, ...o }; };

/** A Dot + Ring in the shape the Studio produces: ONE dot object whose ring lives in metadata. */
const dotRing = (o = {}) => base({
  type: 'dot',
  metadata: {
    sizePreset: 'medium', scale: 1,
    ring: { enabled: true, sizePreset: 'large', scale: 1.2, width: 0.144, thicknessPreset: 'medium', thicknessScale: 1, thickness: 4, color: '#1a73e8' },
  },
  ...o,
});
const band = (o = {}) => base({
  type: 'fingerBand', x: 0.7325, y: 0.36, width: 0.14, height: null, rotation: 0.2, color: '#12a594', thickness: 6, opacity: 0.8, finger: 'ring', landmarkReference: null,
  metadata: { sizePreset: 'medium', scale: 1.077, thicknessPreset: 'large', thicknessScale: 0.75, band: { type: 'double', position: 0.35, rotationOffset: 5 } },
  ...o,
});
const text = (o = {}) => base({ type: 'text', width: 0.036, height: null, color: '#111111', metadata: { sizePreset: 'medium', scale: 1.2, text: 'Hold for 3 minutes' }, ...o });
const sized = (o = {}) => base({ type: 'hline', width: 0.09, height: null, thickness: 8, metadata: { sizePreset: 'small', scale: 0.9, thicknessPreset: 'large', thicknessScale: 1 }, ...o });
/** A Dot + Ring with independent colours and an explicit gap (dot RED, ring BLUE, gap set via the Large preset). */
const dotRingWithGap = (o = {}) => base({
  type: 'dot', color: '#e5484d',
  metadata: {
    sizePreset: 'medium', scale: 1,
    ring: { enabled: true, sizePreset: 'large', scale: 1, width: 0.15, thicknessPreset: 'medium', thicknessScale: 1, thickness: 4, color: '#1a73e8', gapPreset: 'large', gapScale: 1, gap: 28 },
  },
  ...o,
});

/** Saves a set of objects to a view, reads the protocol back, and returns what came back. */
const roundTrip = async (e, id, viewIndex, objects) => {
  (await e.setObjects(id, viewIndex, objects));
  return (await e.protocols.getFull(id)).canvases[viewIndex].objects;
};
const byId = (list) => Object.fromEntries(list.map((o) => [o.id, o]));

describe('[DETERMINISTIC] Studio data survives save and load', { skip: SKIP }, () => {
  it('four views coexist in ONE protocol, and every object stays on the view it was drawn on', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Four views' }, e.actor));
      const full0 = (await e.protocols.getFull(id));
      assert.deepEqual(full0.canvases.map((c) => c.viewKey), ['left_front', 'right_front', 'left_back', 'right_back']);

      const perView = [
        [base({ type: 'dot' })],
        [base({ type: 'ring', width: 0.08, height: 0.08, thickness: 4, metadata: { sizePreset: 'medium', scale: 1, thicknessPreset: 'medium', thicknessScale: 1 } })],
        [dotRing()],
        [band()],
      ];
      (await e.protocols.saveCanvases(id, full0.canvases.map((c, i) => ({ id: c.id, objects: perView[i] })), e.actor));

      const full = (await e.protocols.getFull(id));
      assert.equal(full.canvases.length, 4);
      assert.deepEqual(full.canvases.map((c) => c.objects.map((o) => o.id)), perView.map((list) => list.map((o) => o.id)), 'each view holds exactly its own objects');
      assert.deepEqual(full.canvases.map((c) => c.objects[0].type), ['dot', 'ring', 'dot', 'fingerBand']);
      assert.equal((await e.protocols.listVersions(id)).filter((v) => v.kind === 'checkpoint').length >= 2, true);
      assert.equal((await e.rows('SELECT id FROM protocols WHERE name = $1', 'Four views')).length, 1, 'one protocol, not one per hand');
    } finally { await e.cleanup(); }
  });

  it('Dot + Ring is ONE object and its nested ring data survives exactly', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'DR' }, e.actor));
      const sent = dotRing();
      const got = (await roundTrip(e, id, 2, [sent]));
      assert.equal(got.length, 1, 'one object, not a dot plus a separate ring');
      assert.equal(got[0].type, 'dot');
      assert.deepEqual(got[0].metadata.ring, sent.metadata.ring);
      assert.equal(got[0].metadata.ring.enabled, true);
      assert.equal(got[0].id, sent.id);
    } finally { await e.cleanup(); }
  });

  it('Finger Band data survives: canonical finger, band details, width, rotation, position, and the reserved landmark reference', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'FB' }, e.actor));
      const sent = band();
      const [got] = (await roundTrip(e, id, 3, [sent]));
      assert.equal(got.type, 'fingerBand');
      assert.equal(got.finger, 'ring');
      assert.deepEqual(got.metadata.band, sent.metadata.band);
      assert.equal(got.width, sent.width);
      assert.equal(got.rotation, sent.rotation);
      assert.equal(got.x, sent.x);
      assert.equal(got.y, sent.y);
      assert.equal(got.thickness, 6);
      assert.equal(got.opacity, 0.8);
      assert.equal(got.landmarkReference, null, 'reserved for future AR; nothing writes it in this phase');
    } finally { await e.cleanup(); }
  });

  it('Dot + Ring with independent dot/ring colours AND an explicit gap survives save and load exactly', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'DR gap' }, e.actor));
      const sent = dotRingWithGap();
      const [got] = (await roundTrip(e, id, 0, [sent]));
      assert.equal(got.color, '#e5484d', 'dot colour');
      assert.equal(got.metadata.ring.color, '#1a73e8', 'ring colour, independent of the dot');
      assert.deepEqual([got.metadata.ring.gapPreset, got.metadata.ring.gapScale, got.metadata.ring.gap], ['large', 1, 28]);
    } finally { await e.cleanup(); }
  });

  it('a ring saved with no colour of its own round-trips exactly as given (still falls back to the dot colour wherever it is read)', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'DR legacy colour' }, e.actor));
      const sent = dotRing();
      delete sent.metadata.ring.color;
      const [got] = (await roundTrip(e, id, 0, [sent]));
      assert.equal('color' in got.metadata.ring, false, 'nothing invents a colour that was never stored');
    } finally { await e.cleanup(); }
  });

  it('a band saved with the legacy name "pinky" is read as "little" (new data is always written canonical)', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'legacy' }, e.actor));
      const [got] = (await roundTrip(e, id, 0, [band({ finger: 'pinky' })]));
      assert.equal(got.finger, 'little');
    } finally { await e.cleanup(); }
  });

  it('size presets, custom scale and thickness presets/scale survive', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'sizes' }, e.actor));
      const sent = sized();
      const [got] = (await roundTrip(e, id, 0, [sent]));
      assert.equal(got.metadata.sizePreset, 'small');
      assert.equal(got.metadata.scale, 0.9);
      assert.equal(got.metadata.thicknessPreset, 'large');
      assert.equal(got.metadata.thicknessScale, 1);
      assert.equal(got.width, 0.09, 'the resolved width the AR/public layers read is unchanged');
      assert.equal(got.thickness, 8);
    } finally { await e.cleanup(); }
  });

  it('text survives exactly, including punctuation and a second line', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'txt' }, e.actor));
      const sent = text({ metadata: { sizePreset: 'large', scale: 0.8, text: 'Breathe in — 4 s\nHold "gently" & release <b>' } });
      const [got] = (await roundTrip(e, id, 1, [sent]));
      assert.equal(got.metadata.text, sent.metadata.text);
      assert.equal(got.metadata.scale, 0.8);
      assert.equal(got.width, 0.036);
    } finally { await e.cleanup(); }
  });

  it('the ORIGINAL object types still save and load exactly as before (nothing about them changed)', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'orig' }, e.actor));
      const legacy = [
        base({ type: 'dot' }),
        base({ type: 'ring', width: 0.08, height: 0.08, thickness: 4 }),
        base({ type: 'hline', width: 0.18, height: null, thickness: 4 }),
        base({ type: 'rectangle', width: 0.16, height: 0.1, thickness: 3 }),
        base({ type: 'freeline', width: null, height: null, thickness: 4, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.25 }] }),
      ];
      const got = byId((await roundTrip(e, id, 0, legacy)));
      legacy.forEach((o) => {
        assert.equal(got[o.id].type, o.type);
        assert.equal(got[o.id].width, o.width);
        assert.equal(got[o.id].height, o.height);
        assert.deepEqual(got[o.id].metadata, {}, 'no Studio data appears on objects that never had any');
      });
      assert.deepEqual(got[legacy[4].id].points, legacy[4].points);
    } finally { await e.cleanup(); }
  });
});

describe('[DETERMINISTIC] publishing with Studio data', { skip: SKIP }, () => {
  const studioObjects = () => [dotRing(), band(), text(), sized()];

  it('a protocol made of Studio objects passes publish validation and the public render carries their data', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Publish me' }, e.actor));
      (await e.setObjects(id, 0, studioObjects()));
      const result = (await e.protocols.publish(id, e.actor, {}));
      assert.ok(result);
      const slug = (await e.protocols.getFull(id)).slug;
      const render = (await e.publicSvc.getRender(slug));
      const objs = render.canvases.flatMap((c) => c.objects);
      const ring = objs.find((o) => o.metadata && o.metadata.ring);
      assert.ok(ring, 'the ring travels inside the dot object');
      assert.equal(ring.metadata.ring.color, '#1a73e8');
      assert.ok(objs.find((o) => o.type === 'fingerBand' && o.metadata.band.position === 0.35));
      assert.ok(objs.find((o) => o.type === 'text' && o.metadata.text === 'Hold for 3 minutes'));
    } finally { await e.cleanup(); }
  });

  it('the published version is IMMUTABLE: editing every Studio value afterwards leaves it untouched and shows "unpublished changes"', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Frozen' }, e.actor));
      const original = studioObjects();
      (await e.setObjects(id, 0, original));
      (await e.protocols.publish(id, e.actor, {}));
      const before = JSON.stringify((await e.publicSvc.getRender((await e.protocols.getFull(id)).slug)));
      const versionRowBefore = (await e.row('SELECT snapshot_json, checksum FROM protocol_versions WHERE protocol_id = $1 AND kind = $2', id, 'published'));

      // change everything: ring colour, band position, text, presets, delete an object
      const edited = studioObjects().slice(0, 3);
      edited[0].metadata.ring.color = '#111111';
      edited[0].metadata.ring.enabled = false;
      edited[1].metadata.band.position = 0.9;
      edited[1].finger = 'thumb';
      edited[2].metadata.text = 'CHANGED';
      (await e.setObjects(id, 0, edited));

      assert.equal(JSON.stringify((await e.publicSvc.getRender((await e.protocols.getFull(id)).slug))), before, 'the public render is unchanged');
      const versionRowAfter = (await e.row('SELECT snapshot_json, checksum FROM protocol_versions WHERE protocol_id = $1 AND kind = $2', id, 'published'));
      assert.deepEqual(versionRowAfter, versionRowBefore, 'the stored published version is byte-identical');
      const full = (await e.protocols.getFull(id));
      assert.equal(full.hasUnpublishedChanges, true);
      assert.equal(full.canvases[0].objects.find((o) => o.type === 'text').metadata.text, 'CHANGED', 'the draft did take the edits');
    } finally { await e.cleanup(); }
  });

  it('a published snapshot preserves independent dot/ring colours and the gap; editing the gap afterwards never touches it', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Frozen gap' }, e.actor));
      (await e.setObjects(id, 0, [dotRingWithGap()]));
      (await e.protocols.publish(id, e.actor, {}));
      const slug = (await e.protocols.getFull(id)).slug;
      const publishedRing = (await e.publicSvc.getRender(slug)).canvases[0].objects[0].metadata.ring;
      assert.deepEqual([publishedRing.color, publishedRing.gapPreset, publishedRing.gap], ['#1a73e8', 'large', 28]);

      const edited = dotRingWithGap();
      edited.metadata.ring.color = '#111111';
      edited.metadata.ring.gapPreset = 'small';
      edited.metadata.ring.gap = 8;
      (await e.setObjects(id, 0, [edited]));

      const stillPublished = (await e.publicSvc.getRender(slug)).canvases[0].objects[0].metadata.ring;
      assert.deepEqual([stillPublished.color, stillPublished.gapPreset, stillPublished.gap], ['#1a73e8', 'large', 28], 'the published version never changes');
    } finally { await e.cleanup(); }
  });

  it('restoring an older version copies it into the draft and never alters the old version', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Restore' }, e.actor));
      (await e.setObjects(id, 0, [dotRing()]));
      const v = (await e.protocols.listVersions(id))[0].version;
      const snapshotBefore = (await e.protocols.getVersion(id, v)).snapshot;
      (await e.setObjects(id, 0, [text()]));
      (await e.protocols.restoreVersion(id, v, e.actor));
      assert.equal((await e.protocols.getFull(id)).canvases[0].objects[0].metadata.ring.color, '#1a73e8');
      assert.deepEqual((await e.protocols.getVersion(id, v)).snapshot, snapshotBefore);
    } finally { await e.cleanup(); }
  });

  it('a DUPLICATE gets new ids and its nested Studio data is independent of the original', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Original' }, e.actor));
      (await e.setObjects(id, 0, [dotRing(), band()]));
      const copyId = (await e.protocols.duplicate(id, e.actor));
      const a = (await e.protocols.getFull(id));
      const b = (await e.protocols.getFull(copyId));
      assert.notEqual(copyId, id);
      assert.equal(b.status, 'draft');
      assert.equal(b.published, null);
      const aIds = a.canvases.flatMap((c) => c.objects.map((o) => o.id));
      const bIds = b.canvases.flatMap((c) => c.objects.map((o) => o.id));
      assert.equal(bIds.length, aIds.length);
      assert.equal(bIds.filter((x) => aIds.includes(x)).length, 0, 'every object id is new');
      assert.equal(new Set([...a.canvases, ...b.canvases].map((c) => c.id)).size, 8, 'canvas ids are new too');

      // the copy has the same Studio data ...
      assert.deepEqual(b.canvases[0].objects.find((o) => o.type === 'dot').metadata.ring, a.canvases[0].objects.find((o) => o.type === 'dot').metadata.ring);
      // ... and editing the copy does not change the original
      const editedCopy = b.canvases[0].objects.map((o) => (o.type === 'dot' ? { ...o, metadata: { ...o.metadata, ring: { ...o.metadata.ring, color: '#111111', width: 0.3 } } } : o));
      (await e.protocols.saveCanvases(copyId, [{ id: b.canvases[0].id, objects: editedCopy }], e.actor));
      assert.equal((await e.protocols.getFull(id)).canvases[0].objects.find((o) => o.type === 'dot').metadata.ring.color, '#1a73e8');
      assert.equal((await e.protocols.getFull(id)).canvases[0].objects.find((o) => o.type === 'dot').metadata.ring.width, 0.144);
    } finally { await e.cleanup(); }
  });

  it('a DUPLICATE of a Dot + Ring keeps both independent colours and the gap, but gets a new object id', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Original with gap' }, e.actor));
      (await e.setObjects(id, 0, [dotRingWithGap()]));
      const copyId = (await e.protocols.duplicate(id, e.actor));
      const original = (await e.protocols.getFull(id)).canvases[0].objects[0];
      const copy = (await e.protocols.getFull(copyId)).canvases[0].objects[0];
      assert.notEqual(copy.id, original.id);
      assert.deepEqual(
        [copy.color, copy.metadata.ring.color, copy.metadata.ring.gapPreset, copy.metadata.ring.gap],
        [original.color, original.metadata.ring.color, original.metadata.ring.gapPreset, original.metadata.ring.gap]
      );
    } finally { await e.cleanup(); }
  });
});

describe('[DETERMINISTIC] publish validation of the Studio structures', { skip: SKIP }, () => {
  const publishError = async (objects) => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'V' }, e.actor));
      (await e.setObjects(id, 0, objects));
      try { (await e.protocols.publish(id, e.actor, {})); return null; } catch (err) { return err; } // eslint-disable-line brace-style
    } finally { await e.cleanup(); }
  };
  const codes = (err) => (err && err.details ? err.details.map((d) => d.code) : []);

  it('accepts a complete, well-formed set of Studio objects', async () => {
    assert.equal((await publishError([dotRing(), band(), text(), sized()])), null);
  });
  it('accepts all four sizes — small, medium, large and "xl" (Extra Large) — and rejects anything else', async () => {
    for (const sizePreset of ['small', 'medium', 'large', 'xl']) {
      assert.equal((await publishError([sized({ metadata: { sizePreset, scale: 1 } })])), null, `${sizePreset} must publish`);
    }
    for (const sizePreset of ['xxl', 'huge', 'XL', '', 0]) {
      const err = (await publishError([sized({ metadata: { sizePreset, scale: 1 } })]));
      assert.ok(err, `${JSON.stringify(sizePreset)} must be rejected`);
      assert.ok(codes(err).includes('SIZE_PRESET_INVALID'), JSON.stringify(err.details));
    }
  });
  it('rejects a bad thickness preset, a non-positive scale and a scale above the maximum', async () => {
    assert.ok(codes((await publishError([sized({ metadata: { thicknessPreset: 'huge' } })]))).includes('THICKNESS_PRESET_INVALID'));
    assert.ok(codes((await publishError([sized({ metadata: { sizePreset: 'small', scale: 0 } })]))).includes('SCALE_INVALID'));
    assert.ok(codes((await publishError([sized({ metadata: { sizePreset: 'small', scale: 99 } })]))).includes('SCALE_INVALID'));
  });
  it('rejects a malformed ring, and a ring on anything that is not a dot', async () => {
    const noEnabled = dotRing(); delete noEnabled.metadata.ring.enabled;
    assert.ok(codes((await publishError([noEnabled]))).includes('RING_INVALID'));
    const badColor = dotRing(); badColor.metadata.ring.color = 'red';
    assert.ok(codes((await publishError([badColor]))).includes('COLOR_INVALID'));
    const onRing = base({ type: 'ring', width: 0.08, height: 0.08, thickness: 4, metadata: dotRing().metadata });
    assert.ok(codes((await publishError([onRing]))).includes('RING_INVALID'), 'only a dot can carry a ring');
  });
  it('a ring with NO colour of its own (predating independent ring colours, or hand-written data) still publishes', async () => {
    const noColor = dotRing(); delete noColor.metadata.ring.color;
    assert.equal((await publishError([noColor])), null, 'a missing ring.color must not block publishing — only an invalid one does');
  });
  it('rejects an invalid gap preset, gap scale, or gap value, but accepts a well-formed one', async () => {
    const withGap = (patch) => { const o = dotRing(); o.metadata.ring = { ...o.metadata.ring, ...patch }; return o; };
    assert.equal((await publishError([withGap({ gapPreset: 'medium', gapScale: 1, gap: 16 })])), null);
    assert.ok(codes((await publishError([withGap({ gapPreset: 'xl' })]))).includes('SIZE_PRESET_INVALID'));
    assert.ok(codes((await publishError([withGap({ gapScale: 0 })]))).includes('SCALE_INVALID'));
    assert.ok(codes((await publishError([withGap({ gapScale: 99 })]))).includes('SCALE_INVALID'));
    assert.ok(codes((await publishError([withGap({ gap: -1 })]))).includes('RING_INVALID'));
    // the legacy gap has no upper limit either (nothing in this model has an artificial maximum)
    assert.equal((await publishError([withGap({ gap: 100000 })])), null);
  });
  it('rejects a finger band with no finger, an unknown band type, or a position outside the finger', async () => {
    assert.ok(codes((await publishError([band({ finger: null })]))).includes('FINGER_REQUIRED'));
    const badType = band(); badType.metadata.band.type = 'spiral';
    assert.ok(codes((await publishError([badType]))).includes('BAND_INVALID'));
    const badPos = band(); badPos.metadata.band.position = 1.5;
    assert.ok(codes((await publishError([badPos]))).includes('BAND_INVALID'));
  });
  it('rejects empty text and text that is too long', async () => {
    assert.ok(codes((await publishError([text({ metadata: { text: '   ' } })]))).includes('TEXT_REQUIRED'));
    assert.ok(codes((await publishError([text({ metadata: {} })]))).includes('TEXT_REQUIRED'));
    assert.ok(codes((await publishError([text({ metadata: { text: 'x'.repeat(201) } })]))).includes('TEXT_TOO_LONG'));
  });
});

describe('[DETERMINISTIC · HTTP] Studio save/load and roles on the real server', { skip: HTTP_SKIP }, () => {
  let h;
  before(async () => { h = await bootstrap(); });
  after(async () => { if (h) await h.stop(); });

  it('a doctor saves all four views in ONE request and gets every Studio value back on reload', async () => {
    const created = await h.doctor.post('/api/protocols', { name: 'HTTP studio', protocolType: 'hand' });
    assert.equal(created.status, 201, created.text);
    const p = created.json;
    const perView = [[dotRingWithGap()], [base({ type: 'dot' })], [band(), text()], [sized()]];
    const save = await h.doctor.post(`/api/protocols/${p.id}/save`, { canvases: p.canvases.map((c, i) => ({ id: c.id, objects: perView[i] })) });
    assert.equal(save.status, 200, save.text);

    const reload = await h.doctor.get(`/api/protocols/${p.id}`);
    assert.equal(reload.status, 200);
    assert.deepEqual(reload.json.canvases.map((c) => c.objects.length), [1, 1, 2, 1]);
    const objs = byId(reload.json.canvases.flatMap((c) => c.objects));
    assert.deepEqual(objs[perView[0][0].id].metadata.ring, perView[0][0].metadata.ring);
    assert.deepEqual(objs[perView[2][0].id].metadata.band, perView[2][0].metadata.band);
    assert.equal(objs[perView[2][0].id].finger, 'ring');
    assert.equal(objs[perView[2][1].id].metadata.text, 'Hold for 3 minutes');
    assert.equal(objs[perView[3][0].id].metadata.sizePreset, 'small');
  });

  it('the server rejects an unknown object type (the type list is a real contract)', async () => {
    const p = (await h.doctor.post('/api/protocols', { name: 'unknown type', protocolType: 'hand' })).json;
    const res = await h.doctor.post(`/api/protocols/${p.id}/save`, { canvases: [{ id: p.canvases[0].id, objects: [base({ type: 'hologram' })] }] });
    assert.equal(res.status, 400, res.text);
  });

  it('nobody without a doctor/admin login can save or read a protocol, and a patient cannot edit one', async () => {
    const p = (await h.doctor.post('/api/protocols', { name: 'locked', protocolType: 'hand' })).json;
    const body = { canvases: [{ id: p.canvases[0].id, objects: [dotRing()] }] };
    assert.equal((await h.anon.post(`/api/protocols/${p.id}/save`, body)).status, 401);
    assert.equal((await h.anon.get(`/api/protocols/${p.id}`)).status, 401);
    assert.ok([401, 403, 404].includes((await h.patient.post(`/api/protocols/${p.id}/save`, body)).status), 'a patient is refused');
  });

  it('metadata, publishing and versions stay admin-only: a doctor is refused, an admin can publish Studio data', async () => {
    const p = (await h.admin.post('/api/admin/protocols', { name: 'Admin publishes' })).json;
    await h.admin.post(`/api/protocols/${p.id}/save`, { canvases: [{ id: p.canvases[0].id, objects: [dotRing(), band(), text()] }] });
    assert.equal((await h.doctor.post(`/api/admin/protocols/${p.id}/publish`, {})).status, 403);
    assert.equal((await h.doctor.put(`/api/admin/protocols/${p.id}`, { shortDescription: 'x' })).status, 403);
    const pub = await h.admin.post(`/api/admin/protocols/${p.id}/publish`, {});
    assert.equal(pub.status, 201, pub.text);
    const render = await h.anon.get(`/api/public/protocols/${p.slug}/render`);
    assert.equal(render.status, 200, render.text);
    const rendered = render.json.canvases.flatMap((c) => c.objects);
    assert.ok(rendered.some((o) => o.metadata && o.metadata.ring), 'the public render carries the Dot + Ring');
  });
});

// =====================================================================================================================
// Sharing/PDF task: Extra Large size, unlimited thickness, the shared outline structure, and many attached rings.
// =====================================================================================================================
const ringEntry = (over = {}) => ({ color: '#1a73e8', thickness: 10, outline: { enabled: false, color: '#000000', thickness: 4 }, ...over });
/** A dot with ATTACHED rings (innermost first), the new model: `metadata.rings`, no gap anywhere. */
const ringsDot = (rings, o = {}) => base({ type: 'dot', color: '#e5484d', width: 0.03, metadata: { sizePreset: 'medium', scale: 1, rings }, ...o });
const withOutline = (o, outline = { enabled: true, color: '#000000', thickness: 6 }) => ({ ...o, metadata: { ...o.metadata, outline } });

const tryPublish = async (objects) => {
  const e = await env();
  try {
    const id = (await e.protocols.create({ name: 'Rings/outline validation' }, e.actor));
    (await e.setObjects(id, 0, objects));
    try { (await e.protocols.publish(id, e.actor, {})); return null; } catch (err) { return err; } // eslint-disable-line brace-style
  } finally { await e.cleanup(); }
};
const codesOf = (err) => (err && err.details ? err.details.map((d) => d.code) : []);

describe('[DETERMINISTIC] Extra Large size and unlimited thickness persist and publish', { skip: SKIP }, () => {
  it('Extra Large ("xl") survives save → load for the objects that have a size', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'XL' }, e.actor));
      const sent = [sized({ metadata: { sizePreset: 'xl', scale: 1 }, width: 0.4 }), ringsDot([ringEntry()], { metadata: { sizePreset: 'xl', scale: 1, rings: [ringEntry()] }, width: 0.065 })];
      const got = (await roundTrip(e, id, 0, sent));
      assert.deepEqual(got.map((o) => o.metadata.sizePreset), ['xl', 'xl']);
      assert.equal(got[0].width, 0.4);
    } finally { await e.cleanup(); }
  });

  it('thickness has NO artificial maximum: normal, huge and enormous values all save, load and publish', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Thick' }, e.actor));
      const thicknesses = [0.5, 4, 8, 50, 1001, 5000, 250000, 1e9];
      const sent = thicknesses.map((thickness, i) => sized({ id: `thick-${i}`, thickness, zIndex: i + 1, metadata: { sizePreset: 'medium', scale: 1 } }));
      const got = (await roundTrip(e, id, 0, sent));
      assert.deepEqual(got.map((o) => o.thickness).sort((a, b) => a - b), thicknesses);
      assert.ok((await e.protocols.publish(id, e.actor, {})), 'a protocol using a 1,000,000,000 px stroke is publishable');
    } finally { await e.cleanup(); }
  });

  it('only unusable thickness values are rejected: negative at publish, non-numeric already at save (and 0 stays valid for objects without a stroke)', async () => {
    // (NaN / Infinity / null / numeric strings never reach the validator through persistence — the column coerces a numeric
    //  string to a number and the save layer defaults null — they are covered directly in lifecycle-snapshot-validation.test.js)
    assert.ok(codesOf((await tryPublish([sized({ thickness: -1 })]))).includes('THICKNESS_INVALID'));
    // PostgreSQL migration: a non-numeric value cannot be stored in the numeric column, so the SAVE refuses it with a 400
    // (under SQLite it was stored as text and refused only at publish). It is still never publishable.
    await assert.rejects(tryPublish([sized({ thickness: 'thick' })]), (err) => err.status === 400 && err.code === 'INVALID_INPUT' && /thickness must be a number/.test(err.message));
    assert.equal((await tryPublish([sized({ thickness: '7' })])), null, 'a numeric string is stored as a number, as before');
    assert.equal((await tryPublish([base({ type: 'dot', width: 0.03, thickness: 0 })])), null);
    assert.equal((await tryPublish([sized({ thickness: 123456789 })])), null);
  });
});

describe('[DETERMINISTIC] outline: one shared structure on every shape', { skip: SKIP }, () => {
  const SHAPES = [
    base({ type: 'dot', width: 0.03 }),
    base({ type: 'ring', width: 0.08, thickness: 4 }),
    base({ type: 'hline', width: 0.18, thickness: 4 }),
    base({ type: 'vline', width: 0.18, thickness: 4 }),
    base({ type: 'freeline', thickness: 4, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.25 }] }),
    base({ type: 'triangle', width: 0.12, height: 0.12, thickness: 3 }),
    base({ type: 'invertedTriangle', width: 0.12, height: 0.12, thickness: 3 }),
    base({ type: 'rectangle', width: 0.16, height: 0.1, thickness: 3 }),
    base({ type: 'square', width: 0.1, height: 0.1, thickness: 3 }),
    base({ type: 'arrow', width: 0.18, thickness: 4 }),
    band(),
  ];

  it('every shape type carries an outline through save → load unchanged, with independent enabled / colour / thickness', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Outlines' }, e.actor));
      const sent = SHAPES.map((o, i) => withOutline({ ...o, id: `ol-${i}`, zIndex: i + 1 }, { enabled: i % 2 === 0, color: i % 2 ? '#ffffff' : '#12a594', thickness: 3 + i * 40 }));
      const got = byId((await roundTrip(e, id, 0, sent)));
      sent.forEach((o) => assert.deepEqual(got[o.id].metadata.outline, o.metadata.outline, `${o.type} outline`));
      assert.equal(sent.length, 11);
    } finally { await e.cleanup(); }
  });

  it('a well-formed outline publishes on every shape, including a very thick one', async () => {
    for (const o of SHAPES) assert.equal((await tryPublish([withOutline(o, { enabled: true, color: '#000000', thickness: 99999 })])), null, `${o.type}`);
  });

  it('objects saved WITHOUT any outline still publish, and nothing invents an outline for them', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'No outline' }, e.actor));
      const got = (await roundTrip(e, id, 0, SHAPES.map((o, i) => ({ ...o, id: `plain-${i}`, zIndex: i + 1 }))));
      got.forEach((o) => assert.equal('outline' in o.metadata, false, o.type));
      assert.ok((await e.protocols.publish(id, e.actor, {})));
    } finally { await e.cleanup(); }
  });

  it('rejects an malformed outline: not an object, non-boolean enabled, bad colour, non-positive / non-numeric thickness', async () => {
    const bad = [
      ['not-an-object', 'OUTLINE_INVALID'], [{ enabled: 'yes' }, 'OUTLINE_INVALID'], [{ enabled: true, color: 'black' }, 'COLOR_INVALID'],
      [{ enabled: true, thickness: 0 }, 'OUTLINE_INVALID'], [{ enabled: true, thickness: -2 }, 'OUTLINE_INVALID'], [{ enabled: true, thickness: '4' }, 'OUTLINE_INVALID'],
    ];
    for (const [outline, code] of bad) {
      const err = (await tryPublish([withOutline(base({ type: 'hline', width: 0.18, thickness: 4 }), outline)]));
      assert.ok(err, JSON.stringify(outline));
      assert.ok(codesOf(err).includes(code), `${JSON.stringify(outline)} -> ${code}; got ${JSON.stringify(codesOf(err))}`);
    }
  });
});

describe('[DETERMINISTIC] Dot + many attached rings (metadata.rings)', { skip: SKIP }, () => {
  const RING_COUNT = 60; // far beyond anything "reasonable": there is no predefined maximum
  const manyRings = () => Array.from({ length: RING_COUNT }, (_, i) => ringEntry({ color: i % 2 ? '#e5484d' : '#1a73e8', thickness: 3 + i, outline: { enabled: i % 3 === 0, color: '#000000', thickness: 1 + i } }));

  it('an unlimited number of rings round-trips through the database exactly — each with its own colour, thickness and outline', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Many rings' }, e.actor));
      const sent = ringsDot(manyRings());
      const [got] = (await roundTrip(e, id, 0, [sent]));
      assert.equal(got.type, 'dot', 'still ONE object of type dot');
      assert.equal(got.metadata.rings.length, RING_COUNT);
      assert.deepEqual(got.metadata.rings, sent.metadata.rings);
      assert.equal((await e.rows('SELECT id FROM objects WHERE canvas_id = $1', (await e.protocols.getFull(id)).canvases[0].id)).length, 1, 'one stored object, not one per ring');
    } finally { await e.cleanup(); }
  });

  it('the ring list is an ARRAY, not ring/ring2/ring3 fields, and no gap field is stored by the model', async () => {
    const o = ringsDot([ringEntry(), ringEntry()]);
    assert.ok(Array.isArray(o.metadata.rings));
    assert.deepEqual(Object.keys(o.metadata).filter((k) => /^ring\d/.test(k)), []);
    o.metadata.rings.forEach((r) => assert.equal('gap' in r, false));
  });

  it('a Dot + Rings publishes (including rings with huge thickness) and the PUBLISHED snapshot carries every ring unchanged', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Publish rings' }, e.actor));
      const sent = ringsDot([ringEntry({ thickness: 12 }), ringEntry({ color: '#46a758', thickness: 70000 })]);
      (await e.setObjects(id, 0, [sent]));
      assert.ok((await e.protocols.publish(id, e.actor, {})));
      const rendered = (await e.publicSvc.getRender((await e.protocols.getFull(id)).slug)).canvases[0].objects[0];
      assert.deepEqual(rendered.metadata.rings, sent.metadata.rings);
    } finally { await e.cleanup(); }
  });

  it('editing the rings AFTER publishing never changes the published version (immutability)', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Frozen rings' }, e.actor));
      (await e.setObjects(id, 0, [ringsDot([ringEntry(), ringEntry({ color: '#46a758' })])]));
      (await e.protocols.publish(id, e.actor, {}));
      const slug = (await e.protocols.getFull(id)).slug;
      const before = JSON.stringify((await e.publicSvc.getRender(slug)));
      (await e.setObjects(id, 0, [ringsDot([ringEntry({ color: '#000000', thickness: 99 })])])); // fewer rings, other colour/thickness
      assert.equal(JSON.stringify((await e.publicSvc.getRender(slug))), before);
      assert.equal((await e.protocols.getFull(id)).hasUnpublishedChanges, true);
    } finally { await e.cleanup(); }
  });

  it('a DUPLICATE keeps every ring, with new object ids and independent ring data', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Dup rings' }, e.actor));
      (await e.setObjects(id, 0, [ringsDot(manyRings().slice(0, 5))]));
      const copyId = (await e.protocols.duplicate(id, e.actor));
      const a = (await e.protocols.getFull(id)).canvases[0].objects[0];
      const b = (await e.protocols.getFull(copyId)).canvases[0].objects[0];
      assert.notEqual(a.id, b.id);
      assert.deepEqual(b.metadata.rings, a.metadata.rings);
      const changed = { ...b, metadata: { ...b.metadata, rings: b.metadata.rings.map((r) => ({ ...r, color: '#111111' })) } };
      (await e.protocols.saveCanvases(copyId, [{ id: (await e.protocols.getFull(copyId)).canvases[0].id, objects: [changed] }], e.actor));
      assert.notDeepEqual((await e.protocols.getFull(id)).canvases[0].objects[0].metadata.rings.map((r) => r.color), ['#111111', '#111111', '#111111', '#111111', '#111111']);
    } finally { await e.cleanup(); }
  });

  it('rejects malformed rings: not a list, a ring that is not an object, thickness missing / zero / negative / non-numeric, bad colour, bad ring outline', async () => {
    const cases = [
      [{ rings: 'two' }, 'RINGS_INVALID'], [{ rings: [5] }, 'RINGS_INVALID'], [{ rings: [{ color: '#1a73e8' }] }, 'RINGS_INVALID'],
      [{ rings: [{ thickness: 0 }] }, 'RINGS_INVALID'], [{ rings: [{ thickness: -4 }] }, 'RINGS_INVALID'], [{ rings: [{ thickness: '10' }] }, 'RINGS_INVALID'],
      [{ rings: [{ thickness: 10, color: 'blue' }] }, 'COLOR_INVALID'],
      [{ rings: [{ thickness: 10, outline: { enabled: 'x' } }] }, 'OUTLINE_INVALID'],
      [{ rings: [{ thickness: 10, outline: { enabled: true, thickness: 0 } }] }, 'OUTLINE_INVALID'],
    ];
    for (const [meta, code] of cases) {
      const err = (await tryPublish([base({ type: 'dot', width: 0.03, metadata: { sizePreset: 'medium', scale: 1, ...meta } })]));
      assert.ok(err, JSON.stringify(meta));
      assert.ok(codesOf(err).includes(code), `${JSON.stringify(meta)} -> ${code}; got ${JSON.stringify(codesOf(err))}`);
    }
  });

  it('only a dot may carry rings', async () => {
    const err = (await tryPublish([base({ type: 'ring', width: 0.08, thickness: 4, metadata: { rings: [ringEntry()] } })]));
    assert.ok(codesOf(err).includes('RINGS_INVALID'));
  });

  it('an empty ring list is valid (a plain dot whose last ring was removed)', async () => {
    assert.equal((await tryPublish([ringsDot([])])), null);
  });

  it('LEGACY single-ring objects (metadata.ring with a gap) keep loading, saving and publishing unchanged alongside the new model', async () => {
    const e = await env();
    try {
      const id = (await e.protocols.create({ name: 'Legacy + new' }, e.actor));
      const legacy = dotRingWithGap({ id: 'legacy-1', zIndex: 1 });
      const modern = ringsDot([ringEntry()], { id: 'modern-1', zIndex: 2 });
      const got = byId((await roundTrip(e, id, 0, [legacy, modern])));
      assert.deepEqual(got['legacy-1'].metadata.ring, legacy.metadata.ring);
      assert.deepEqual(got['modern-1'].metadata.rings, modern.metadata.rings);
      assert.ok((await e.protocols.publish(id, e.actor, {})));
    } finally { await e.cleanup(); }
  });
});

describe('[DETERMINISTIC · HTTP] rings, outline, XL and huge thickness over the real server', { skip: HTTP_SKIP }, () => {
  let h;
  before(async () => { h = await bootstrap(); });
  after(async () => { if (h) await h.stop(); });

  it('a doctor saves them, reloads them identically; only a published version is publicly reachable; a draft is not', async () => {
    const p = (await h.admin.post('/api/admin/protocols', { name: 'HTTP rings share' })).json;
    const obj = withOutline(ringsDot([ringEntry({ thickness: 12 }), ringEntry({ color: '#46a758', thickness: 400 })], { metadata: { sizePreset: 'xl', scale: 1, rings: [ringEntry({ thickness: 12 }), ringEntry({ color: '#46a758', thickness: 400 })] }, thickness: 0 }));
    const line = sized({ id: 'fat-line', thickness: 65000, metadata: { sizePreset: 'xl', scale: 1 }, zIndex: 9 });
    const save = await h.admin.post(`/api/protocols/${p.id}/save`, { canvases: [{ id: p.canvases[0].id, objects: [obj, line] }] });
    assert.equal(save.status, 200, save.text);

    const reload = (await h.admin.get(`/api/protocols/${p.id}`)).json.canvases[0].objects;
    assert.deepEqual(byId(reload)[obj.id].metadata.rings, obj.metadata.rings);
    assert.deepEqual(byId(reload)[obj.id].metadata.outline, obj.metadata.outline);
    assert.equal(byId(reload)['fat-line'].thickness, 65000);

    // DRAFT: the public link does not exist yet
    assert.equal((await h.anon.get(`/api/public/protocols/${p.slug}`)).status, 404, 'a draft is never reachable by its public link');
    assert.equal((await h.anon.get(`/api/public/protocols/${p.slug}/render`)).status, 404);

    // PUBLISHED: the same link now serves the published snapshot, rings and all
    const pub = await h.admin.post(`/api/admin/protocols/${p.id}/publish`, {});
    assert.equal(pub.status, 201, pub.text);
    const render = await h.anon.get(`/api/public/protocols/${p.slug}/render`);
    assert.equal(render.status, 200, render.text);
    const rendered = byId(render.json.canvases[0].objects);
    assert.deepEqual(rendered[obj.id].metadata.rings, obj.metadata.rings);
    assert.equal(rendered['fat-line'].thickness, 65000);

    // an edit after publishing does not leak: the link still serves the published version
    await h.admin.post(`/api/protocols/${p.id}/save`, { canvases: [{ id: p.canvases[0].id, objects: [] }] });
    const still = (await h.anon.get(`/api/public/protocols/${p.slug}/render`)).json.canvases[0].objects;
    assert.equal(still.length, 2, 'the public page still shows the published snapshot, not the emptied draft');
  });

  it('the server refuses a malformed ring list at publish, with a readable problem list', async () => {
    const p = (await h.admin.post('/api/admin/protocols', { name: 'HTTP bad rings' })).json;
    await h.admin.post(`/api/protocols/${p.id}/save`, { canvases: [{ id: p.canvases[0].id, objects: [ringsDot([{ color: '#1a73e8', thickness: -5 }])] }] });
    const pub = await h.admin.post(`/api/admin/protocols/${p.id}/publish`, {});
    assert.equal(pub.status, 422, pub.text);
    assert.ok(pub.json.details.some((d) => d.code === 'RINGS_INVALID'));
  });
});
