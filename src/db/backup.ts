import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './connection.js';

const FILE_PATTERN = /^dnd-ai-\d{4}-\d{2}-\d{2}-\d{4}\.sqlite$/;
const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
const KEEP = 14;

export interface BackupResult {
  written: boolean;
  path?: string;
  kept: number;
}

function backupFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => FILE_PATTERN.test(f));
}

function timestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Writes a consistent VACUUM INTO snapshot of `db`, skipping if one was made in the last 20h, then rotates old files. */
export function backupDatabase(db: Db, dir: string): BackupResult {
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const existing = backupFiles(dir);
  const recent = existing.some((f) => now - statSync(join(dir, f)).mtimeMs < MIN_INTERVAL_MS);
  if (recent) return { written: false, kept: existing.length };

  const path = join(dir, `dnd-ai-${timestamp(new Date(now))}.sqlite`);
  db.prepare('VACUUM INTO ?').run(path);

  const files = backupFiles(dir)
    .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of files.slice(KEEP)) unlinkSync(join(dir, stale.name));

  return { written: true, path, kept: Math.min(files.length, KEEP) };
}
