// The region routes: generate or upload a realm, then read the player-safe summary. The realm
// fetcher is mocked so no browser runs.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';

vi.mock('../src/core/realm-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/realm-fetch.js')>();
  return { ...actual, fetchRealm: vi.fn() };
});

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

let base: string;
let db: Db;
let stop: () => Promise<void>;
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let fetchRealm: (typeof import('../src/core/realm-fetch.js'))['fetchRealm'];
let RealmFetchError: (typeof import('../src/core/realm-fetch.js'))['RealmFetchError'];
let mockedFetch: ReturnType<typeof vi.mocked<typeof fetchRealm>>;

beforeAll(async () => {
  // With isolate: false an earlier file in this worker may already have loaded the route with the
  // real fetcher, so drop the module cache and import the server fresh under the mock.
  vi.resetModules();
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ fetchRealm, RealmFetchError } = await import('../src/core/realm-fetch.js'));
  mockedFetch = vi.mocked(fetchRealm);
  const { openDb } = await import('../src/db/connection.js');
  const { HOST, startHttpServer } = await import('../src/transport/http.js');
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'regionroutes0123456789abcdef012' });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

beforeEach(() => {
  mockedFetch.mockReset();
  mockedFetch.mockResolvedValue({ raw: dangerous, url: 'x' });
});

const newCampaign = (name = 'Region Campaign'): number =>
  createCampaign(db, { name, story_shape: 'sandbox' }).campaign_id;

const getRegion = (id: number): Promise<Response> => fetch(`${base}/api/campaigns/${id}/region`);

const postRegion = (id: number, body: unknown): Promise<Response> =>
  fetch(`${base}/api/campaigns/${id}/region`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('the mocked realm fetcher', () => {
  it('fetchRealm is the mock', () => {
    expect(vi.isMockFunction(fetchRealm)).toBe(true);
  });
});

describe('GET /api/campaigns/:id/region', () => {
  it('returns null before anything is imported', async () => {
    const res = await getRegion(newCampaign());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ region: null });
  });

  it('404s for an unknown campaign', async () => {
    const res = await getRegion(9999);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });
});

describe('POST /api/campaigns/:id/region generate', () => {
  it('generates with the seed and tags and returns only the player summary', async () => {
    const id = newCampaign();
    const res = await postRegion(id, { mode: 'generate', seed: 4242, tags: ['wild'] });
    expect(res.status).toBe(201);
    expect(mockedFetch).toHaveBeenCalledWith(4242, ['wild'], { size: 'medium' });

    const text = await res.text();
    expect(text).not.toContain('Hidden Keep');
    expect(text).not.toContain('one-page-dungeon');
    const body = JSON.parse(text) as { region: { dangers: number } };
    expect(body.region.dangers).toBe(2);

    const after = await getRegion(id);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual(body);
  });

  it('picks an integer seed when none is given', async () => {
    const res = await postRegion(newCampaign(), { mode: 'generate' });
    expect(res.status).toBe(201);
    expect(Number.isInteger(mockedFetch.mock.calls[0]?.[0])).toBe(true);
  });

  it('passes a chosen size through to the fetcher and defaults to medium', async () => {
    const large = await postRegion(newCampaign(), { mode: 'generate', seed: 4242, size: 'large' });
    expect(large.status).toBe(201);
    expect(mockedFetch).toHaveBeenLastCalledWith(4242, [], { size: 'large' });

    await postRegion(newCampaign(), { mode: 'generate', seed: 4243 });
    expect(mockedFetch).toHaveBeenLastCalledWith(4243, [], { size: 'medium' });
  });

  it('rejects an unknown size without starting the browser', async () => {
    const res = await postRegion(newCampaign(), { mode: 'generate', seed: 4242, size: 'huge' });
    expect(res.status).toBe(400);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('refuses an existing region without replace and never starts the browser', async () => {
    const id = newCampaign();
    await postRegion(id, { mode: 'generate', seed: 5 });

    mockedFetch.mockClear();
    const res = await postRegion(id, { mode: 'generate', seed: 6 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('already has a region');
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe('POST /api/campaigns/:id/region upload', () => {
  it('uploads a saved realm over an existing one when replace is set', async () => {
    const id = newCampaign();
    await postRegion(id, { mode: 'generate', seed: 1 });

    const res = await postRegion(id, { mode: 'upload', realm: safe, replace: true });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { region: { name: string; settlements: unknown[] } };
    expect(body.region.name).toBe('Realm Of Poss');
    expect(body.region.settlements).toHaveLength(5);
  });

  it('refuses to replace a region without replace', async () => {
    const id = newCampaign();
    await postRegion(id, { mode: 'generate', seed: 2 });

    const res = await postRegion(id, { mode: 'upload', realm: safe });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('already has a region');
  });

  it('rejects a file that is not a Perilous Shores region', async () => {
    const res = await postRegion(newCampaign(), { mode: 'upload', realm: { nope: 1 } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('Not a Perilous Shores region');
  });
});

describe('POST /api/campaigns/:id/region failures', () => {
  it('maps a fetch failure to 502', async () => {
    mockedFetch.mockRejectedValueOnce(new RealmFetchError('boom'));
    const res = await postRegion(newCampaign(), { mode: 'generate', seed: 3 });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'boom' });
  });

  it('rejects an invalid body', async () => {
    const id = newCampaign();
    for (const body of [{ mode: 'x' }, { mode: 'generate', tags: ['Bad Tag'] }, { mode: 'generate', seed: -1 }]) {
      const res = await postRegion(id, body);
      expect(res.status).toBe(400);
      const parsed = (await res.json()) as { error: string; details: unknown };
      expect(parsed.error).toBe('invalid region request');
      expect(Array.isArray(parsed.details)).toBe(true);
    }
  });

  it('404s for an unknown campaign', async () => {
    const res = await postRegion(9999, { mode: 'generate', seed: 4 });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });
});
