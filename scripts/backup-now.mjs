// Manual backup trigger; run `npm run build` first so dist/ is up to date.
import { fileURLToPath } from 'node:url';
import { backupDatabase } from '../dist/db/backup.js';
import { defaultDbPath, openDb } from '../dist/db/connection.js';

const dir = process.env.DND_BACKUP_DIR ?? fileURLToPath(new URL('../data/backups/', import.meta.url));
const db = openDb(defaultDbPath());
const result = backupDatabase(db, dir);
console.log(result.written ? `backup written to ${result.path} (kept ${result.kept})` : `backup skipped (kept ${result.kept})`);
db.close();
