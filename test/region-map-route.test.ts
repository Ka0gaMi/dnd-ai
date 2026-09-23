// The region-map route: the player-safe region map with the party's own position. Unknown campaigns
// and bad ids are refused, and nothing the party has not learned leaks into the reply.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;

let base: string;
let db: Db;
let stop: () => Promise<void>;
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let saveCheckpoint: (typeof import('../src/core/campaign.js'))['saveCheckpoint'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];

beforeAll(async () => {
  // Match the place-map route test's reset for consistency: the server is imported fresh after a reset.
  vi.resetModules();
  ({ createCampaign, saveCheckpoint } = await import('../src/core/campaign.js'));
  ({ importRegion } = await import('../src/core/region.js'));
  const { openDb } = await import('../src/db/connection.js');
  const { HOST, startHttpServer } = await import('../src/transport/http.js');
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'regionmap0123456789abcdef01234' });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

function newCampaign(name = 'Region Map Campaign'): number {
  return createCampaign(db, { name, story_shape: 'sandbox' }).campaign_id;
}

function getRegionMap(campaignId: number | string): Promise<Response> {
  return fetch(`${base}/api/campaigns/${campaignId}/region-map`);
}

describe('GET /api/campaigns/:id/region-map', () => {
  it('answers null before the campaign has a region', async () => {
    const res = await getRegionMap(newCampaign());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ map: null });
  });

  it('404s an unknown campaign', async () => {
    const res = await getRegionMap(999999);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such campaign' });
  });

  it('400s a non-integer id', async () => {
    const res = await getRegionMap('abc');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad id' });
  });

  it('shows an empty map when the party knows nothing', async () => {
    const id = newCampaign();
    importRegion(db, id, safe, { source: 'generated' });

    const res = await getRegionMap(id);
    expect(res.status).toBe(200);
    const { map } = (await res.json()) as { map: { hexes: unknown[]; places: unknown[] } };
    expect(map.hexes).toEqual([]);
    expect(map.places).toEqual([]);
  });

  it('reveals only the known place, never a place the party has not met', async () => {
    const id = newCampaign();
    importRegion(db, id, safe, { source: 'generated' });
    db.prepare('UPDATE world_place SET known_to_party = 1 WHERE campaign_id = ? AND name = ?').run(id, 'Redham');

    const res = await getRegionMap(id);
    const text = await res.text();
    const { map } = JSON.parse(text) as { map: { places: unknown[] } };
    expect(map.places).toEqual([{ name: 'Redham', kind: 'settlement', size: 'town', q: 6, r: 8 }]);
    expect(text).not.toContain('Stormcourtby');
    expect(text).not.toContain('Hotfield');
    expect(text).not.toContain('Coldwood');
  });

  it('marks the party where the current scene is', async () => {
    const id = newCampaign();
    importRegion(db, id, safe, { source: 'generated' });
    saveCheckpoint(db, { campaign_id: id, scene_location: 'Redham', scene_summary: 'The party arrives.' });

    const res = await getRegionMap(id);
    const { map } = (await res.json()) as { map: { party: { q: number; r: number } | null } };
    expect(map.party).toEqual({ q: 6, r: 8 });
  });

  it('falls back to the newest scene that named a location', async () => {
    const id = newCampaign();
    importRegion(db, id, safe, { source: 'generated' });
    saveCheckpoint(db, { campaign_id: id, scene_location: 'Redham', scene_summary: 'The party arrives.' });
    db.prepare('UPDATE campaign SET current_scene_id = NULL WHERE id = ?').run(id);

    const res = await getRegionMap(id);
    const { map } = (await res.json()) as { map: { party: { q: number; r: number } | null } };
    expect(map.party).toEqual({ q: 6, r: 8 });
  });
});

describe('GET /api/campaigns/:id/region-map party placement', () => {
  it('places no party marker for a scene naming an unknown place inside other text', async () => {
    const id = newCampaign();
    importRegion(db, id, safe, { source: 'generated' });
    saveCheckpoint(db, { campaign_id: id, scene_location: 'On the road to Hotfield', scene_summary: 'Travelling.' });

    const res = await getRegionMap(id);
    const { map } = (await res.json()) as { map: { party: unknown; hexes: unknown[] } };
    expect(map.party).toBeNull();
    expect(map.hexes).toEqual([]);
  });

  it('places the party at an exact named place even when it is unknown', async () => {
    const id = newCampaign();
    importRegion(db, id, safe, { source: 'generated' });
    saveCheckpoint(db, { campaign_id: id, scene_location: 'Hotfield', scene_summary: 'Arriving.' });

    const res = await getRegionMap(id);
    const { map } = (await res.json()) as { map: { party: { q: number; r: number } | null } };
    expect(map.party).toEqual({ q: 12, r: 11 });
  });

  it('places the party at a known place named inside a longer location', async () => {
    const id = newCampaign();
    importRegion(db, id, safe, { source: 'generated' });
    db.prepare('UPDATE world_place SET known_to_party = 1 WHERE campaign_id = ? AND name = ?').run(id, 'Redham');
    saveCheckpoint(db, {
      campaign_id: id,
      scene_location: 'The Gilded Goose in Redham',
      scene_summary: 'Drinking.',
    });

    const res = await getRegionMap(id);
    const { map } = (await res.json()) as { map: { party: { q: number; r: number } | null } };
    expect(map.party).toEqual({ q: 6, r: 8 });
  });
});
