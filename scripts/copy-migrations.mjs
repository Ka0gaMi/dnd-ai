// tsc does not emit .sql; the migration runner resolves them next to the compiled db module.
import { cpSync } from 'node:fs';

cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
