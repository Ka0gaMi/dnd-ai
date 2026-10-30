// Region generation as one job per campaign: started behind campaign creation, joined by the DM's region {op: generate},
// shared with the window's region route, and owed as a duty while a campaign has no map. A stub stands in for the browser.
import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { dueDuties, NEXT_STEP_CHARS } from '../src/core/duties.js';
import { RealmFetchError } from '../src/core/realm-fetch.js';
import { getRegion, importRegion } from '../src/core/region.js';
import {
  regionJobRunning,
  startBackgroundRegion,
  startRegionJob,
  stubRegionJobs,
  type RegionGenerator,
} from '../src/core/region-job.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { HOST, startHttpServer } from '../src/transport/http.js';

type Reply = { content: Array<{ type: string; text?: string }>; isError?: boolean };

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
const safe = fixture('realm-safe.json');
const dangerous = fixture('realm-dangerous.json');

/** A generator that waits until the test finishes or fails it. */
function gated() {
  let finish!: (raw: unknown) => void;
  let fail!: (err: Error) => void;
  const pending = new Promise<unknown>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // A rejection nobody awaits yet must not count as unhandled.
  pending.catch(() => undefined);
  return { generate: vi.fn<RegionGenerator>(() => pending), finish, fail };
}

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  stubRegionJobs();
  vi.restoreAllMocks();
});

const campaign = (name = 'Region Job'): number => createCampaign(db, { name, story_shape: 'sandbox' }).campaign_id;

const lastSystemEvent = (campaignId: number): string | undefined =>
  (
    db.prepare("SELECT text FROM event WHERE campaign_id = ? AND kind = 'system' ORDER BY id DESC LIMIT 1").get(campaignId) as
      | { text: string }
      | undefined
  )?.text;

const settled = (campaignId: number): Promise<void> =>
  vi.waitFor(() => expect(regionJobRunning(db, campaignId)).toBe(false));

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'region-job-test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown>): Promise<Reply> =>
  (await client.callTool({ name, arguments: args })) as unknown as Reply;

const textOf = (reply: Reply): string => reply.content.map((c) => c.text ?? '').join('');

describe('the region job', () => {
  it('imports the generated map, joins a second start, and runs only until it lands', async () => {
    const id = campaign();
    const gate = gated();
    stubRegionJobs({ generate: gate.generate, holdMs: 50 });
    const job = startRegionJob(db, id, { size: 'large' });
    expect(regionJobRunning(db, id)).toBe(true);
    expect(startRegionJob(db, id)).toBe(job);
    // Each database keeps its own jobs, so a campaign with the same id elsewhere is not generating.
    expect(regionJobRunning(openDb(':memory:'), id)).toBe(false);

    gate.finish(dangerous);
    const view = await job;
    expect(view.source).toBe('generated');
    expect(getRegion(db, id)?.name).toBe(view.name);
    expect(gate.generate).toHaveBeenCalledTimes(1);
    expect(gate.generate).toHaveBeenCalledWith(expect.any(Number), [], 'large');
    await settled(id);
  });

  it('refuses before generating for a campaign that has a map or does not exist', () => {
    const id = campaign();
    importRegion(db, id, safe, { source: 'uploaded' });
    const gate = gated();
    stubRegionJobs({ generate: gate.generate, holdMs: 50 });
    expect(() => startRegionJob(db, id)).toThrow(/already has a region/);
    expect(() => startRegionJob(db, 999)).toThrow(/No campaign with id 999/);
    expect(gate.generate).not.toHaveBeenCalled();
    expect(regionJobRunning(db, id)).toBe(false);
  });

  it('logs a failure to the server log and the campaign, then lets a new job start', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const id = campaign();
    const gate = gated();
    stubRegionJobs({ generate: gate.generate, holdMs: 50 });
    const job = startRegionJob(db, id);
    gate.fail(new RealmFetchError('No Chrome or Edge browser was found to generate the region.'));
    await expect(job).rejects.toThrow('No Chrome or Edge');
    await settled(id);
    expect(lastSystemEvent(id)).toBe('Region map generation failed: No Chrome or Edge browser was found to generate the region.');
    expect(String(errors.mock.calls[0]?.[1])).toContain(`region for campaign ${id} failed`);

    stubRegionJobs({ generate: async () => safe, holdMs: 50 });
    expect((await startRegionJob(db, id)).name).toBe('Realm Of Poss');
  });

  it('keeps a map uploaded while it generated, and reports no failure', async () => {
    const id = campaign();
    const gate = gated();
    stubRegionJobs({ generate: gate.generate, holdMs: 50 });
    const job = startRegionJob(db, id);
    importRegion(db, id, safe, { source: 'uploaded' });
    gate.finish(dangerous);
    expect((await job).source).toBe('uploaded');
    expect(getRegion(db, id)?.name).toBe('Realm Of Poss');
    expect(lastSystemEvent(id)).not.toContain('failed');
  });
});

describe('campaign creation', () => {
  it('starts a map behind create_campaign without holding its reply, and a failure never reaches it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const gate = gated();
    stubRegionJobs({ generate: gate.generate, holdMs: 50 });
    const client = await connect();
    const created = await call(client, 'create_campaign', { name: 'Behind', story_shape: 'sandbox' });
    expect(created.isError).toBeFalsy();
    const id = (JSON.parse(textOf(created).split('\n\n')[0]!) as { campaign_id: number }).campaign_id;
    // The reply came back while the generator still waits.
    expect(regionJobRunning(db, id)).toBe(true);

    gate.fail(new RealmFetchError('Perilous Shores did not produce a region file.'));
    await settled(id);
    expect(lastSystemEvent(id)).toBe('Region map generation failed: Perilous Shores did not produce a region file.');
    expect(getRegion(db, id)).toBeNull();
    await client.close();
  });

  it('starts nothing until the server switches background regions on or a test stubs the generator', async () => {
    const client = await connect();
    const created = await call(client, 'create_campaign', { name: 'Unstubbed', story_shape: 'sandbox' });
    const id = (JSON.parse(textOf(created).split('\n\n')[0]!) as { campaign_id: number }).campaign_id;
    expect(regionJobRunning(db, id)).toBe(false);
    startBackgroundRegion(db, id);
    expect(regionJobRunning(db, id)).toBe(false);
    await client.close();
  });
});

describe('region {op: generate}', () => {
  it('answers with the new map when it lands within the hold, at the size asked', async () => {
    const generate = vi.fn<RegionGenerator>(async () => dangerous);
    stubRegionJobs({ generate, holdMs: 5_000 });
    const id = campaign();
    const client = await connect();
    const reply = await call(client, 'region', { campaign_id: id, op: 'generate', size: 'small' });
    expect(reply.isError).toBeFalsy();
    const view = getRegion(db, id)!;
    const settlements = view.places.filter((p) => p.kind === 'settlement').length;
    expect(textOf(reply)).toMatch(new RegExp(`^Region map ${view.name} is ready: ${settlements} settlements \\(`));
    expect(textOf(reply)).toContain(', 2 dangers. Call region {op: get} to read it');
    expect(generate).toHaveBeenCalledWith(expect.any(Number), [], 'small');
    await client.close();
  });

  it('joins the job campaign creation started, says it is still generating past the hold, then refuses a second map', async () => {
    const gate = gated();
    stubRegionJobs({ generate: gate.generate, holdMs: 50 });
    const client = await connect();
    const created = await call(client, 'create_campaign', { name: 'Joined', story_shape: 'sandbox' });
    const id = (JSON.parse(textOf(created).split('\n\n')[0]!) as { campaign_id: number }).campaign_id;

    const waiting = await call(client, 'region', { campaign_id: id, op: 'generate' });
    expect(waiting.isError).toBeFalsy();
    expect(textOf(waiting)).toMatch(/^The region map is still generating\. Call region \{op: get\} in a minute to read it\./);
    expect(gate.generate).toHaveBeenCalledTimes(1);

    gate.finish(safe);
    await settled(id);
    const got = await call(client, 'region', { campaign_id: id, op: 'get' });
    expect(got.isError).toBeFalsy();
    expect(textOf(got)).toContain('Realm Of Poss');

    const again = await call(client, 'region', { campaign_id: id, op: 'generate' });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toBe(
      'This campaign already has its region map, Realm Of Poss; read it with region {op: get}. Only the player can replace it, in the companion window (Settings, Region), until the party knows a place on it.',
    );
    expect(gate.generate).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("refuses with the window's upload as the way round when no browser can run", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const message = 'No Chrome or Edge browser was found to generate the region; upload a saved region JSON instead.';
    stubRegionJobs({ generate: () => Promise.reject(new RealmFetchError(message)), holdMs: 5_000 });
    const id = campaign();
    const client = await connect();
    const refused = await call(client, 'region', { campaign_id: id, op: 'generate' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe(
      `The region map could not be generated: ${message} Ask the player to upload a saved region in the companion window (Settings, Region), or retry region {op: generate} later.`,
    );
    expect(getRegion(db, id)).toBeNull();
    await client.close();
  });
});

describe('the region duty', () => {
  const regionDuty = (id: number) => dueDuties(db, id).find((d) => d.id === 'region_missing');

  it('owes a map while a campaign has none, but not while one generates, during a fight, or once it has one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const id = campaign();
    const due = regionDuty(id)!;
    expect(due).toEqual({
      id: 'region_missing',
      urgency: 2,
      text: 'region {op: generate} - every campaign needs its region map; factions, deeds and travel need it.',
    });
    expect(due.text.length).toBeLessThanOrEqual(NEXT_STEP_CHARS);

    const gate = gated();
    stubRegionJobs({ generate: gate.generate, holdMs: 50 });
    const job = startRegionJob(db, id);
    expect(regionDuty(id)).toBeUndefined();
    gate.fail(new Error('boom'));
    await expect(job).rejects.toThrow('boom');
    await settled(id);
    expect(regionDuty(id)).toBeDefined();

    const fight = Number(
      db
        .prepare("INSERT INTO encounter (campaign_id, seed, map_json, started_at) VALUES (?, 1, '{}', ?)")
        .run(id, new Date().toISOString()).lastInsertRowid,
    );
    expect(regionDuty(id)).toBeUndefined();
    db.prepare("UPDATE encounter SET status = 'ended' WHERE id = ?").run(fight);
    expect(regionDuty(id)).toBeDefined();

    importRegion(db, id, safe, { source: 'uploaded' });
    expect(regionDuty(id)).toBeUndefined();
  });
});

describe('the refusals that need a map', () => {
  it('name region {op: generate} in world, region and checkpoint deeds', async () => {
    const id = campaign();
    const client = await connect();
    for (const [name, args] of [
      ['world', { campaign_id: id, op: 'get' }],
      ['region', { campaign_id: id, op: 'get' }],
    ] as const) {
      const refused = await call(client, name, args);
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toBe(
        'This campaign has no region map yet. Call region {op: generate} to make one, then call this again.',
      );
    }
    const deeds = await call(client, 'checkpoint', {
      campaign_id: id,
      op: 'save',
      scene_summary: 'A deed.',
      deeds: [{ target: 'Anyone', value: 1, reason: 'a test' }],
    });
    expect(deeds.isError).toBe(true);
    expect(textOf(deeds)).toContain(
      'deeds need a region map, which this campaign has not got yet (leave deeds out, or call region {op: generate} first)',
    );
    await client.close();
  });
});

describe('the window routes', () => {
  let base: string;
  let serverDb: Db;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    serverDb = openDb(':memory:');
    const started = await startHttpServer(serverDb, { port: 0, secret: 'regionjob0123456789abcdef0123456' });
    base = `http://${HOST}:${started.port}`;
    stop = started.close;
  });

  afterAll(async () => {
    await stop();
  });

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('starts a map behind the new-story route, refuses a second generation meanwhile, and keeps an upload', async () => {
    const gate = gated();
    stubRegionJobs({ generate: gate.generate, holdMs: 50 });
    const res = await post('/api/campaigns', { name: 'Window Story' });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: number };
    expect(regionJobRunning(serverDb, id)).toBe(true);

    const second = await post(`/api/campaigns/${id}/region`, { mode: 'generate', seed: 7 });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe(
      'A region map is already being generated for this story (up to a minute). Upload one instead, or replace it once it is ready.',
    );
    expect(gate.generate).toHaveBeenCalledTimes(1);

    const upload = await post(`/api/campaigns/${id}/region`, { mode: 'upload', realm: safe });
    expect(upload.status).toBe(201);
    gate.finish(dangerous);
    await vi.waitFor(() => expect(regionJobRunning(serverDb, id)).toBe(false));
    expect(getRegion(serverDb, id)).toMatchObject({ name: 'Realm Of Poss', source: 'uploaded' });
  });
});
