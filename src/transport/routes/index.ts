import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Express } from 'express';
import type { Db } from '../../db/connection.js';

type RouteModule = { default: (app: Express, db: Db) => void };

/**
 * Loads every route module in this directory (besides this file) so parallel work packages can each
 * add `/api/...` routes without touching http.ts. A module is `export default (app, db) => void`.
 */
export async function registerRouteModules(app: Express, db: Db): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(here)
    .filter((f) => (f.endsWith('.js') || f.endsWith('.ts')) && !f.startsWith('index.') && !f.endsWith('.d.ts'))
    .sort();
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(here, file)).href)) as RouteModule;
    mod.default(app, db);
  }
}
