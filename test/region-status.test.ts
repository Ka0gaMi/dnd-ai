// The region route reports a running or failed background job so the window can wait instead of meeting a 409.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { regionJobRunning, stubRegionJobs, type RegionGenerator } from '../src/core/region-job.js';
import { openDb, type Db } from '../src/db/connection.js';
import { HOST, startHttpServer } from '../src/transport/http.js';

let base: string;
let db: Db;
let stop: () => Promise<void>;

beforeAll(async () => {
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'regionstatus0123456789abcdef012' });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});
afterAll(async () => stop());
afterEach(() => stubRegionJobs());

const status = async (id: number) => (await fetch(`${base}/api/campaigns/${id}/region`)).json() as Promise<Record<string, unknown>>;

describe('GET /api/campaigns/:id/region status', () => {
  it('reports generating while the job runs, then the failure once it fails', async () => {
    let fail!: (err: Error) => void;
    const pending = new Promise<unknown>((_, reject) => (fail = reject));
    stubRegionJobs({ generate: vi.fn<RegionGenerator>(() => pending), holdMs: 50 });
    const res = await fetch(`${base}/api/campaigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Status Story' }),
    });
    const { id } = (await res.json()) as { id: number };
    expect(await status(id)).toEqual({ region: null, generating: true, failure: null });

    fail(new Error('browser missing'));
    await vi.waitFor(() => expect(regionJobRunning(db, id)).toBe(false));
    expect(await status(id)).toEqual({ region: null, generating: false, failure: 'browser missing' });
  });
});
