// The town-map route: a revealed settlement's city or village map for the player's window. A hidden
// place, a danger, a missing map and an unknown campaign all answer the same 404.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;
const cityRedham = JSON.parse(
  readFileSync(new URL('./fixtures/map-city-redham.json', import.meta.url), 'utf8'),
) as unknown;
const dungeonHiddenKeep = JSON.parse(
  readFileSync(new URL('./fixtures/map-dungeon-hidden-keep.json', import.meta.url), 'utf8'),
) as unknown;

let base: string;
let db: Db;
let stop: () => Promise<void>;
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let findPlace: (typeof import('../src/core/region.js'))['findPlace'];
let revealPlace: (typeof import('../src/core/region-reveal.js'))['revealPlace'];
let savePlaceMap: (typeof import('../src/core/place-map.js'))['savePlaceMap'];
let upsertEntity: (typeof import('../src/core/codex.js'))['upsertEntity'];

beforeAll(async () => {
  // Match the region route test's reset for consistency: the server is imported fresh after a reset.
  vi.resetModules();
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ importRegion, findPlace } = await import('../src/core/region.js'));
  ({ revealPlace } = await import('../src/core/region-reveal.js'));
  ({ savePlaceMap } = await import('../src/core/place-map.js'));
  ({ upsertEntity } = await import('../src/core/codex.js'));
  const { openDb } = await import('../src/db/connection.js');
  const { HOST, startHttpServer } = await import('../src/transport/http.js');
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'townmap0123456789abcdef01234' });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

function newCampaign(name = 'Town Map Campaign'): number {
  return createCampaign(db, { name, story_shape: 'sandbox' }).campaign_id;
}

function getTownMap(campaignId: number, eid: number | string): Promise<Response> {
  return fetch(`${base}/api/campaigns/${campaignId}/entities/${eid}/town-map`);
}

describe('GET /api/campaigns/:id/entities/:eid/town-map', () => {
  it('serves a revealed settlement with a saved city map', async () => {
    const id = newCampaign();
    importRegion(db, id, safe, { source: 'generated' });
    const redham = findPlace(db, id, 'Redham')!;
    savePlaceMap(db, id, redham.id, { kind: 'city', url: 'https://example/map', raw: cityRedham });
    const { entity_id } = revealPlace(db, id, 'Redham');
    expect(entity_id).not.toBeNull();

    const res = await getTownMap(id, entity_id!);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; kind: string; geojson: { type: string } };
    expect(body.name).toBe('Redham');
    expect(body.kind).toBe('city');
    expect(body.geojson.type).toBe('FeatureCollection');
  });

  it('404s when the revealed settlement has no map yet', async () => {
    const id = newCampaign();
    importRegion(db, id, safe, { source: 'generated' });
    const { entity_id } = revealPlace(db, id, 'Redham');

    const res = await getTownMap(id, entity_id!);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no town map' });
  });

  it('404s an unrevealed settlement, queried by an unrelated entity and an unknown id', async () => {
    const id = newCampaign();
    importRegion(db, id, safe, { source: 'generated' });
    const redham = findPlace(db, id, 'Redham')!;
    savePlaceMap(db, id, redham.id, { kind: 'city', url: 'u', raw: cityRedham });

    const unrelated = upsertEntity(db, { campaign_id: id, kind: 'npc', name: 'A Bystander' }).entity.id;
    const byUnrelated = await getTownMap(id, unrelated);
    expect(byUnrelated.status).toBe(404);
    expect(await byUnrelated.json()).toEqual({ error: 'no town map' });

    const byUnknown = await getTownMap(id, 999999);
    expect(byUnknown.status).toBe(404);
    expect(await byUnknown.json()).toEqual({ error: 'no town map' });
  });

  it('never serves a saved dungeon map for a revealed danger', async () => {
    const id = newCampaign('Danger Campaign');
    importRegion(db, id, dangerous, { source: 'uploaded' });
    const hiddenKeep = findPlace(db, id, 'Hidden Keep')!;
    savePlaceMap(db, id, hiddenKeep.id, { kind: 'dungeon', url: 'u', raw: dungeonHiddenKeep });
    const { entity_id } = revealPlace(db, id, 'Hidden Keep');
    expect(entity_id).not.toBeNull();

    const res = await getTownMap(id, entity_id!);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain('rects');
    expect(JSON.parse(text)).toEqual({ error: 'no town map' });
  });

  it('400s a non-integer entity id', async () => {
    const id = newCampaign();
    const res = await getTownMap(id, 'abc');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad id' });
  });
});
