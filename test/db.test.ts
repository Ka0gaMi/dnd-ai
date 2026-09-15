import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../src/db/connection.js';

const migrationFiles = readdirSync(fileURLToPath(new URL('../src/db/migrations/', import.meta.url)))
  .filter((file) => file.endsWith('.sql'))
  .sort();

describe('migrations', () => {
  it('applies once and is idempotent', () => {
    const db = openDb(':memory:');
    const applied = db.prepare('SELECT name FROM schema_migration ORDER BY name').all() as Array<{ name: string }>;
    expect(applied.map((r) => r.name)).toEqual(migrationFiles);

    expect(migrate(db)).toEqual([]);
    expect(migrate(db)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migration').get()).toEqual({ n: migrationFiles.length });
  });

  it('creates every table the tools need', () => {
    const db = openDb(':memory:');
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((t) => t.name);
    for (const table of [
      'campaign',
      'session',
      'scene',
      'character',
      'quest',
      'quest_step',
      'canon_fact',
      'glossary_entry',
      'event',
      'roll',
      'encounter',
      'combatant',
      'effect',
      'combat_log',
    ]) {
      expect(tables).toContain(table);
    }
  });
});
