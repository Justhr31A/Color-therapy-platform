const crypto = require('crypto');

function frozenSlugify(input) {
  let s = String(input === null || input === undefined ? '' : input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > 80) s = s.slice(0, 80).replace(/-+$/, '');
  return s || 'protocol';
}

function uniqueSlug(base, taken) {
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) {
    const suffix = `-${n}`;
    slug = base.slice(0, 80 - suffix.length).replace(/-+$/, '') + suffix;
  }
  return slug;
}

async function up(client) {
  await client.query(`
    ALTER TABLE protocols
      ADD COLUMN IF NOT EXISTS slug TEXT,
      ADD COLUMN IF NOT EXISTS display_name TEXT,
      ADD COLUMN IF NOT EXISTS short_description TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS metadata_json TEXT,
      ADD COLUMN IF NOT EXISTS published_version_id TEXT,
      ADD COLUMN IF NOT EXISTS published_at TIMESTAMP
  `);

  const protocols = await client.query(
    'SELECT id, name, slug FROM protocols ORDER BY created_at ASC, id ASC'
  );
  const taken = new Set();
  for (const row of protocols.rows) {
    let slug = row.slug && String(row.slug).length ? String(row.slug) : '';
    if (!slug || taken.has(slug)) slug = uniqueSlug(frozenSlugify(row.name), taken);
    taken.add(slug);
    await client.query('UPDATE protocols SET slug = $1 WHERE id = $2', [slug, row.id]);
  }

  await client.query(`
    ALTER TABLE protocols ALTER COLUMN slug SET NOT NULL;
    ALTER TABLE protocols ADD CONSTRAINT protocols_slug_format_check
      CHECK (slug = lower(slug) AND length(slug) BETWEEN 1 AND 80);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_protocols_slug ON protocols(slug);
    CREATE INDEX IF NOT EXISTS idx_protocols_doctor_id ON protocols(doctor_id);
    CREATE INDEX IF NOT EXISTS idx_protocols_patient_id ON protocols(patient_id);
    CREATE INDEX IF NOT EXISTS idx_protocols_category_id ON protocols(category_id);
    CREATE INDEX IF NOT EXISTS idx_protocols_status ON protocols(status)
  `);

  await client.query(`
    ALTER TABLE protocol_versions
      ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'checkpoint',
      ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS restored_from_version INTEGER,
      ADD COLUMN IF NOT EXISTS checksum TEXT,
      ADD COLUMN IF NOT EXISTS note TEXT
  `);

  const versions = await client.query(
    'SELECT id, snapshot_json, checksum FROM protocol_versions ORDER BY protocol_id, version, id'
  );
  for (const row of versions.rows) {
    if (row.checksum) continue;
    const snapshot = row.snapshot_json == null ? '' : String(row.snapshot_json);
    const checksum = crypto.createHash('sha256').update(snapshot, 'utf8').digest('hex');
    await client.query('UPDATE protocol_versions SET checksum = $1 WHERE id = $2', [checksum, row.id]);
  }

  await client.query(`
    ALTER TABLE protocol_versions ADD CONSTRAINT protocol_versions_kind_check
      CHECK (kind IN ('checkpoint', 'published'));
    CREATE INDEX IF NOT EXISTS idx_protocol_versions_protocol ON protocol_versions(protocol_id, version);
    ALTER TABLE protocols ADD CONSTRAINT protocols_published_requires_version
      CHECK (status <> 'published' OR published_version_id IS NOT NULL);
    ALTER TABLE protocol_versions ADD CONSTRAINT protocol_versions_id_protocol_unique UNIQUE (id, protocol_id);
    ALTER TABLE protocols ADD CONSTRAINT protocols_published_version_fk
      FOREIGN KEY (published_version_id, id)
      REFERENCES protocol_versions (id, protocol_id)
      DEFERRABLE INITIALLY DEFERRED
  `);

  await client.query(`
    CREATE OR REPLACE FUNCTION ct_reject_protocol_version_update()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'protocol_versions rows are immutable and cannot be updated';
    END;
    $$;

    CREATE OR REPLACE FUNCTION ct_reject_protocol_version_delete()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM protocols WHERE id = OLD.protocol_id) THEN
        RAISE EXCEPTION 'protocol_versions rows cannot be deleted while their protocol exists';
      END IF;
      RETURN OLD;
    END;
    $$;

    CREATE OR REPLACE FUNCTION ct_reject_published_protocol_delete()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.published_version_id IS NOT NULL THEN
        RAISE EXCEPTION 'a protocol that has been published cannot be deleted; archive it instead';
      END IF;
      RETURN OLD;
    END;
    $$;

    CREATE OR REPLACE FUNCTION ct_validate_published_pointer()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.published_version_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM protocol_versions v
        WHERE v.id = NEW.published_version_id
          AND v.protocol_id = NEW.id
          AND v.kind = 'published'
      ) THEN
        RAISE EXCEPTION 'published_version_id must reference a published version of this protocol';
      END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS protocol_versions_no_update ON protocol_versions;
    CREATE TRIGGER protocol_versions_no_update BEFORE UPDATE ON protocol_versions
      FOR EACH ROW EXECUTE FUNCTION ct_reject_protocol_version_update();
    DROP TRIGGER IF EXISTS protocol_versions_no_delete ON protocol_versions;
    CREATE TRIGGER protocol_versions_no_delete BEFORE DELETE ON protocol_versions
      FOR EACH ROW EXECUTE FUNCTION ct_reject_protocol_version_delete();
    DROP TRIGGER IF EXISTS protocols_no_delete_when_published ON protocols;
    CREATE TRIGGER protocols_no_delete_when_published BEFORE DELETE ON protocols
      FOR EACH ROW EXECUTE FUNCTION ct_reject_published_protocol_delete();
    DROP TRIGGER IF EXISTS protocols_published_pointer_insert ON protocols;
    CREATE TRIGGER protocols_published_pointer_insert BEFORE INSERT ON protocols
      FOR EACH ROW EXECUTE FUNCTION ct_validate_published_pointer();
    DROP TRIGGER IF EXISTS protocols_published_pointer_update ON protocols;
    CREATE TRIGGER protocols_published_pointer_update BEFORE UPDATE OF published_version_id ON protocols
      FOR EACH ROW EXECUTE FUNCTION ct_validate_published_pointer();
  `);
}

module.exports = { version: 3, name: 'protocol_publishing', up };
