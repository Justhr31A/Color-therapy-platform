/**
 * LEGACY SQLite helpers, used ONLY by the importer tests (tests/sqlite-import.test.js) to build the kind of
 * SQLite file older versions of the app wrote. The application itself runs on PostgreSQL (see ./pg.js).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Returns false if every named package is installed, otherwise a human-readable reason to skip. */
function missingReason(...packages) {
  for (const name of packages) {
    try {
      require.resolve(name);
    } catch (e) {
      return `${name} is not installed (run \`npm install\` in backend/)`;
    }
  }
  return false;
}

const SKIP_REASON = missingReason('better-sqlite3');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctpp-test-'));
}

/** Opens a fresh temp database with the app's own pragmas (WAL + foreign keys). */
function openTempDb() {
  const { openDatabase } = require('../../scripts/legacy-sqlite/open'); // eslint-disable-line global-require
  const dir = makeTempDir();
  const file = path.join(dir, 'test.db');
  const db = openDatabase(file);
  return {
    db,
    file,
    dir,
    cleanup() {
      try { db.close(); } catch (e) { /* already closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Builds a database exactly as the app created it BEFORE the migration
 * system existed: the old schema (001_baseline.sql is that file, moved
 * unchanged) with user_version left at 0, then fills it with realistic data.
 */
function seedLegacyDatabase(db) {
  db.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'legacy-sqlite', 'migrations', '001_baseline.sql'), 'utf8'));

  // Timestamps are set EXPLICITLY and made different from each other and from
  // "now": if a migration ever dropped or re-defaulted a timestamp column, the
  // value would change and the before/after comparison would catch it. (Relying
  // on DEFAULT (datetime('now')) would let a lost column go unnoticed whenever
  // the copy happened within the same second.)
  const user = db.prepare('INSERT INTO users (id,name,email,password_hash,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
  user.run('u-doc', 'Dr Existing', 'doc@example.com', '$2a$12$existinghashexistinghashexistinghashexistinghash', 'doctor', 'active', '2024-01-05 10:00:00', '2024-02-06 11:30:00');
  user.run('u-pat1', 'Active Patient', 'p1@example.com', '$2a$12$patienthashpatienthashpatienthashpatienthashpatie', 'patient', 'active', '2024-03-07 09:15:00', '2024-04-08 16:45:00');
  user.run('u-pat2', 'Pending Patient', 'p2@example.com', null, 'patient', 'pending', '2024-05-09 08:00:00', '2024-05-09 08:00:00');

  const proto = db.prepare(
    'INSERT INTO protocols (id,name,description,doctor_id,patient_id,protocol_type,status,current_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  );
  proto.run('p-1', 'Calm', 'desc one', 'u-doc', 'u-pat1', 'hand', 'active', 3, '2024-01-10 12:00:00', '2024-06-11 13:00:00');
  proto.run('p-2', 'Sleep', '', 'u-doc', null, 'hand', 'draft', 1, '2024-02-12 14:00:00', '2024-02-12 14:00:00');

  const canvas = db.prepare(
    'INSERT INTO canvases (id,protocol_id,canvas_type,view_key,background_asset_key,width,height,sort_order) VALUES (?,?,?,?,?,?,?,?)'
  );
  ['left_front', 'right_front', 'left_back', 'right_back'].forEach((v, i) => canvas.run(`c-1-${v}`, 'p-1', 'hand', v, v, 1586, 1982, i));
  canvas.run('c-2-left_front', 'p-2', 'hand', 'left_front', 'left_front', 1586, 1982, 0);

  const obj = db.prepare(
    `INSERT INTO objects (id,canvas_id,object_type,x,y,width,height,rotation,color,thickness,opacity,points_json,finger,landmark_json,metadata_json,z_index)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  obj.run('o-dot', 'c-1-left_front', 'dot', 0.4578, 0.4983, 0.03, 0.03, 0, '#e5484d', 0, 1, null, 'pinky', null, '{}', 1);
  obj.run('o-ring', 'c-1-left_front', 'ring', 0.5, 0.55, 0.08, 0.08, 0, '#1a73e8', 4, 0.8, null, null, null, '{}', 2);
  obj.run('o-free', 'c-1-right_front', 'freeline', 0, 0, null, null, 0, '#00aa00', 4, 1, '[{"x":0.1,"y":0.2},{"x":0.3,"y":0.4}]', null, null, null, 3);
  obj.run('o-rect', 'c-2-left_front', 'rectangle', 0.3, 0.3, 0.16, 0.1, 15, '#000000', 3, 1, null, 'thumb', '{"start":9,"end":10,"relativeT":0.35}', '{"note":"x"}', 4);

  const ver = db.prepare('INSERT INTO protocol_versions (id,protocol_id,version,snapshot_json,created_at) VALUES (?,?,?,?,?)');
  ver.run('v-1', 'p-1', 1, '{"canvases":[]}', '2024-01-10 12:00:00');
  ver.run('v-2', 'p-1', 2, '{"canvases":[{"id":"c-1-left_front"}]}', '2024-03-20 15:30:00');
}

const LEGACY_TABLES = ['users', 'protocols', 'canvases', 'objects', 'protocol_versions'];

/** Every row of every legacy table, as plain objects in a stable order — for before/after comparison. */
function snapshotTables(db, tables = LEGACY_TABLES) {
  const out = {};
  tables.forEach((t) => {
    out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY id`).all().map((r) => ({ ...r }));
  });
  return out;
}

module.exports = { SKIP_REASON, missingReason, makeTempDir, openTempDb, seedLegacyDatabase, snapshotTables, LEGACY_TABLES };
