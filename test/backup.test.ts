import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase } from '../src/db/backup.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dnd-ai-backup-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  db?.close();
});

describe('backupDatabase', () => {
  it('writes a consistent snapshot containing the schema', () => {
    db = openDb(':memory:');
    const dir = tempDir();
    const result = backupDatabase(db, dir);

    expect(result.written).toBe(true);
    expect(result.kept).toBe(1);
    expect(result.path).toBeDefined();

    const copy = new Database(result.path!, { readonly: true });
    const tables = (copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (t) => t.name,
    );
    expect(tables).toContain('campaign');
    copy.close();
  });

  it('skips a second backup within 20 hours', () => {
    db = openDb(':memory:');
    const dir = tempDir();
    backupDatabase(db, dir);
    const second = backupDatabase(db, dir);

    expect(second.written).toBe(false);
    expect(second.kept).toBe(1);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('rotates to keep only the newest 14 files', () => {
    db = openDb(':memory:');
    const dir = tempDir();
    const old = Date.now() - 25 * 60 * 60 * 1000;
    for (let i = 0; i < 20; i++) {
      const file = join(dir, `dnd-ai-1999-01-${String(i + 1).padStart(2, '0')}-0000.sqlite`);
      writeFileSync(file, '');
      const mtime = new Date(old - i * 1000);
      utimesSync(file, mtime, mtime);
    }

    const result = backupDatabase(db, dir);

    expect(result.written).toBe(true);
    expect(result.kept).toBe(14);
    expect(readdirSync(dir)).toHaveLength(14);
  });
});
