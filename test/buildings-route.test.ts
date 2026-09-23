// The buildings route: a revealed settlement's known buildings for the player's window, with secret
// rooms stripped. A hidden place, an unknown entity and an unknown campaign all answer an empty list.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const planTavern = JSON.parse(
  readFileSync(new URL('./fixtures/plan-tavern.json', import.meta.url), 'utf8'),
) as unknown;
const planGothic = JSON.parse(
  readFileSync(new URL('./fixtures/plan-gothic.json', import.meta.url), 'utf8'),
) as unknown;

let base: string;
let db: Db;
let stop: () => Promise<void>;
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let findPlace: (typeof import('../src/core/region.js'))['findPlace'];
let revealPlace: (typeof import('../src/core/region-reveal.js'))['revealPlace'];
let saveBuilding: (typeof import('../src/core/building.js'))['saveBuilding'];
let listBuildings: (typeof import('../src/core/building.js'))['listBuildings'];
let revealBuilding: (typeof import('../src/core/building.js'))['revealBuilding'];
let upsertEntity: (typeof import('../src/core/codex.js'))['upsertEntity'];

beforeAll(async () => {
  // Match the place-map route test's reset: the server is imported fresh after a reset.
  vi.resetModules();
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ importRegion, findPlace } = await import('../src/core/region.js'));
  ({ revealPlace } = await import('../src/core/region-reveal.js'));
  ({ saveBuilding, listBuildings, revealBuilding } = await import('../src/core/building.js'));
  ({ upsertEntity } = await import('../src/core/codex.js'));
  const { openDb } = await import('../src/db/connection.js');
  const { HOST, startHttpServer } = await import('../src/transport/http.js');
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'buildings0123456789abcdef012' });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

function newCampaign(name = 'Buildings Campaign'): number {
  return createCampaign(db, { name, story_shape: 'sandbox' }).campaign_id;
}

function getBuildings(campaignId: number, eid: number | string): Promise<Response> {
  return fetch(`${base}/api/campaigns/${campaignId}/entities/${eid}/buildings`);
}

interface BuildingBody {
  buildings: Array<{ id: number; name: string; kind: string; plan: { floors: Array<{ rooms: Array<{ name?: string }> }> } }>;
}

function roomNames(plan: { floors: Array<{ rooms: Array<{ name?: string }> }> }): string[] {
  return plan.floors.flatMap((floor) => floor.rooms.map((room) => room.name ?? ''));
}

describe('GET /api/campaigns/:id/entities/:eid/buildings', () => {
  it('serves only the known buildings, with secret rooms removed from the plan', async () => {
    const id = newCampaign();
    importRegion(db, id, safe, { source: 'generated' });
    const redham = findPlace(db, id, 'Redham')!;
    saveBuilding(db, id, redham.id, {
      name: 'The Gilded Goose',
      kind: 'tavern',
      seed: 777,
      url: 'https://watabou.github.io/dwellings/?seed=777',
      raw: planTavern,
    });
    const chapel = saveBuilding(db, id, redham.id, {
      name: 'Chapel of Dawn',
      kind: 'temple',
      seed: 778,
      url: 'https://watabou.github.io/dwellings/?seed=778',
      raw: planGothic,
    });
    revealBuilding(db, id, chapel.id);
    const { entity_id } = revealPlace(db, id, 'Redham');
    expect(entity_id).not.toBeNull();

    const res = await getBuildings(id, entity_id!);
    expect(res.status).toBe(200);
    const body = (await res.json()) as BuildingBody;
    expect(body.buildings).toHaveLength(1);
    expect(body.buildings[0]!.name).toBe('Chapel of Dawn');
    expect(body.buildings[0]!.kind).toBe('temple');
    expect(roomNames(body.buildings[0]!.plan)).not.toContain('Secret passage');

    const stored = listBuildings(db, id, redham.id).find((b) => b.name === 'Chapel of Dawn')!;
    expect(roomNames(stored.raw as BuildingBody['buildings'][number]['plan'])).toContain('Secret passage');
  });

  it('serves both known buildings in id order once both are revealed', async () => {
    const id = newCampaign('Two Buildings');
    importRegion(db, id, safe, { source: 'generated' });
    const redham = findPlace(db, id, 'Redham')!;
    const tavern = saveBuilding(db, id, redham.id, {
      name: 'The Gilded Goose',
      kind: 'tavern',
      seed: 777,
      url: 'https://watabou.github.io/dwellings/?seed=777',
      raw: planTavern,
    });
    const chapel = saveBuilding(db, id, redham.id, {
      name: 'Chapel of Dawn',
      kind: 'temple',
      seed: 778,
      url: 'https://watabou.github.io/dwellings/?seed=778',
      raw: planGothic,
    });
    revealBuilding(db, id, tavern.id);
    revealBuilding(db, id, chapel.id);
    const { entity_id } = revealPlace(db, id, 'Redham');

    const res = await getBuildings(id, entity_id!);
    const body = (await res.json()) as BuildingBody;
    expect(body.buildings.map((b) => b.name)).toEqual(['The Gilded Goose', 'Chapel of Dawn']);
    expect(body.buildings.map((b) => b.id)).toEqual([tavern.id, chapel.id]);
  });

  it('answers an empty list for an unrevealed settlement, an unrelated entity and an unknown id', async () => {
    const id = newCampaign('Hidden Buildings');
    importRegion(db, id, safe, { source: 'generated' });
    const redham = findPlace(db, id, 'Redham')!;
    saveBuilding(db, id, redham.id, {
      name: 'The Gilded Goose',
      kind: 'tavern',
      seed: 777,
      url: 'https://watabou.github.io/dwellings/?seed=777',
      raw: planTavern,
    });

    const unrelated = upsertEntity(db, { campaign_id: id, kind: 'npc', name: 'A Bystander' }).entity.id;
    const byUnrelated = await getBuildings(id, unrelated);
    expect(byUnrelated.status).toBe(200);
    expect(await byUnrelated.json()).toEqual({ buildings: [] });

    const byUnknown = await getBuildings(id, 999999);
    expect(byUnknown.status).toBe(200);
    expect(await byUnknown.json()).toEqual({ buildings: [] });
  });

  it('400s a non-integer entity id', async () => {
    const id = newCampaign();
    const res = await getBuildings(id, 'abc');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad id' });
  });
});
