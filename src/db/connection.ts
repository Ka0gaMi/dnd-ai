import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedSrdGlossary } from '../srd/glossary.js';

export type Db = Database.Database;

const migrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));

export function defaultDbPath(): string {
  return process.env.DND_AI_DB ?? fileURLToPath(new URL('../../data/dnd-ai.sqlite', import.meta.url));
}

export function openDb(file: string = defaultDbPath()): Db {
  const inMemory = file === ':memory:';
  if (!inMemory) mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  if (!inMemory) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  seedSrdGlossary(db);
  return db;
}

/** Applies every not-yet-applied migration file in name order. Safe to call repeatedly. */
export function migrate(db: Db): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migration (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migration').all() as Array<{ name: string }>).map((r) => r.name),
  );
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  const record = db.prepare('INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)');
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    })();
    ran.push(file);
  }
  return ran;
}
