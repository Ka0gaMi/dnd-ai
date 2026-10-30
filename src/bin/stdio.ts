import { enableBackgroundRegions } from '../core/region-job.js';
import { openDb } from '../db/connection.js';
import { startStdioServer } from '../transport/stdio.js';

enableBackgroundRegions();
await startStdioServer(openDb());
