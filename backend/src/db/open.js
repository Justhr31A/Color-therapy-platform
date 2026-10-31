const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

/**
 * Resolves the database file exactly as the app always has: DATABASE_FILE
 * (default ./data/protocol_platform.db) relative to the process working
 * directory. This MUST NOT change casually — an existing database is found
 * purely by this path, and resolving it differently would make the app
 * start against a new, empty database.
 */
function resolveDatabasePath() {
  const dbFile = process.env.DATABASE_FILE || './data/protocol_platform.db';
  return path.resolve(process.cwd(), dbFile);
}

/** Opens (creating the file/folder if needed) with the pragmas the app relies on. No schema work here. */
function openDatabase(resolvedPath = resolveDatabasePath()) {
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

module.exports = { resolveDatabasePath, openDatabase };
