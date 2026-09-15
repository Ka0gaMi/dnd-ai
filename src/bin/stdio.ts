import { openDb } from '../db/connection.js';
import { startStdioServer } from '../transport/stdio.js';

await startStdioServer(openDb());
