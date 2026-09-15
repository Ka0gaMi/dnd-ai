import { fileURLToPath } from 'node:url';
import { backupDatabase } from '../db/backup.js';
import { openDb } from '../db/connection.js';
import { HOST, log, readOrCreateSecret, startHttpServer } from '../transport/http.js';

const db = openDb();
const secret = readOrCreateSecret();
const { port } = await startHttpServer(db, { secret });
log(`dnd-ai listening on http://${HOST}:${port} (MCP at /mcp/<secret>, ws at /ws, health at /healthz)`);

const backupDir = process.env.DND_BACKUP_DIR ?? fileURLToPath(new URL('../../data/backups/', import.meta.url));
function runBackup() {
  // A throw inside a timer is an uncaught exception, and losing the game server
  // to an unwritable backup folder would be a poor trade.
  try {
    const result = backupDatabase(db, backupDir);
    log(result.written ? `backup written to ${result.path} (kept ${result.kept})` : `backup skipped (kept ${result.kept})`);
  } catch (err) {
    log(`backup failed: ${(err as Error).message}`);
  }
}
setTimeout(runBackup, 5_000).unref();
setInterval(runBackup, 24 * 60 * 60 * 1000).unref();
