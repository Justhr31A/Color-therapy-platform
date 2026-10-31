/**
 * 001 — baseline.
 *
 * Represents the schema exactly as it existed before the migration system
 * was introduced (001_baseline.sql is the old schema.sql, moved unchanged).
 * Every statement uses CREATE ... IF NOT EXISTS, so:
 *   - on a brand-new database it creates everything;
 *   - on an EXISTING database (user_version 0 but tables already present) it
 *     changes nothing and simply lets the runner adopt it at version 1.
 * It must therefore never be edited to do anything destructive.
 */
const fs = require('fs');
const path = require('path');

const REQUIRED_TABLES = ['users', 'protocols', 'canvases', 'objects', 'protocol_versions'];

module.exports = {
  version: 1,
  name: 'baseline',
  up(db) {
    db.exec(fs.readFileSync(path.join(__dirname, '001_baseline.sql'), 'utf8'));

    const present = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    );
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    if (missing.length) {
      throw new Error(`Baseline migration finished but tables are missing: ${missing.join(', ')}`);
    }
  },
};
