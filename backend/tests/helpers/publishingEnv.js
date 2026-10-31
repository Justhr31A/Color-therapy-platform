/**
 * Test environment for the publishing layer: a freshly migrated, disposable PostgreSQL database,
 * an admin and a doctor user row, and the real services wired to it. Everything is async.
 */
const { openTestDatabase } = require('./pg');

async function makeEnv() {
  const { createProtocolService } = require('../../src/services/protocolService'); // eslint-disable-line global-require
  const { createCatalogService } = require('../../src/services/catalogService'); // eslint-disable-line global-require
  const { createPublicProtocolService } = require('../../src/services/publicProtocols'); // eslint-disable-line global-require

  const t = await openTestDatabase();
  await t.run("INSERT INTO users (id,name,email,password_hash,role) VALUES ('admin-1','Admin','admin@example.com','x','admin')");
  await t.run("INSERT INTO users (id,name,email,password_hash,role) VALUES ('doc-1','Doc','doc@example.com','x','doctor')");
  const actor = { id: 'admin-1', role: 'admin' };

  const protocols = createProtocolService(t.db);
  const catalog = createCatalogService(t.db);
  const publicSvc = createPublicProtocolService(t.db);

  let n = 0;
  /** A valid, drawable dot in API shape. */
  const dot = (o = {}) => {
    n += 1;
    return { id: `obj-${Date.now()}-${n}`, type: 'dot', x: 0.45, y: 0.5, width: 0.03, height: 0.03, rotation: 0, color: '#e5484d', thickness: 0, opacity: 1, zIndex: n, metadata: {}, ...o };
  };
  /** Replaces the objects of one view of a protocol through the same path the builder uses. */
  const setObjects = async (protocolId, viewIndex, objects) => {
    const full = await protocols.getFull(protocolId);
    await protocols.saveCanvases(protocolId, [{ id: full.canvases[viewIndex].id, objects }], actor);
  };
  /** Creates a protocol that passes publish validation. */
  const makePublishable = async (name = 'Headache Relief Protocol', extra = {}) => {
    const id = await protocols.create({ name, ...extra }, actor);
    await setObjects(id, 0, [dot()]);
    return id;
  };

  return { ...t, actor, protocols, catalog, publicSvc, dot, setObjects, makePublishable };
}

module.exports = { makeEnv };
