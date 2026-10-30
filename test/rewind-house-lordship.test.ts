// Rewinding past a house's revolt drops the lordship it made, so the realms and the DM's region briefing read
// as before, while a realm the checkpoint already held stays even when nothing points at it.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';
import type { WorldAgenda, WorldFaction } from '../src/core/world-store.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;

const DAY = 1000;

let db: Db;
let openDb: (typeof import('../src/db/connection.js'))['openDb'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let region: typeof import('../src/core/region.js');
let politicsStore: typeof import('../src/core/politics-store.js');
let regionBriefing: (typeof import('../src/core/region-briefing.js'))['regionBriefing'];
let store: typeof import('../src/core/world-store.js');
let resolve: typeof import('../src/core/world-resolve.js');
let rewind: typeof import('../src/core/rewind.js');

beforeAll(async () => {
  // With isolate: false an earlier file may have cached a stubbed dice.ts, so import the world fresh on the real one.
  vi.resetModules();
  ({ openDb } = await import('../src/db/connection.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  region = await import('../src/core/region.js');
  politicsStore = await import('../src/core/politics-store.js');
  ({ regionBriefing } = await import('../src/core/region-briefing.js'));
  store = await import('../src/core/world-store.js');
  resolve = await import('../src/core/world-resolve.js');
  rewind = await import('../src/core/rewind.js');
});

beforeEach(() => {
  db = openDb(':memory:');
});

interface Crown {
  campaignId: number;
  crown: WorldFaction;
  house: WorldFaction;
}

/** Ficengwind holds its capital, Hotfield (seat of a house) and Southern Landing. */
function crown(): Crown {
  const campaignId = createCampaign(db, { name: 'The Rewound Revolt', story_shape: 'sandbox' }).campaign_id;
  region.importRegion(db, campaignId, safe, { source: 'generated' });
  const place = (name: string): number => region.findPlace(db, campaignId, name)!.id;
  const seat = { ficengwind: place('Ficengwind'), hotfield: place('Hotfield'), southernLanding: place('Southern Landing') };
  const stored = politicsStore.saveHierarchy(db, campaignId, {
    counties: {
      counties: [
        { name: 'County of Ficengwind', seat_place_id: seat.ficengwind, seat_kind: 'city', hexes: ['q0_r0'], village_place_ids: [], component: 0 },
        { name: 'County of Hotfield', seat_place_id: seat.hotfield, seat_kind: 'town', hexes: ['q1_r0'], village_place_ids: [], component: 0 },
        { name: 'County of Southern Landing', seat_place_id: seat.southernLanding, seat_kind: 'town', hexes: ['q2_r0'], village_place_ids: [], component: 0 },
      ],
      edges: [],
    },
    realms: {
      realms: [{ name: 'Kingdom of Ficengwind', kind: 'kingdom', capital_place_id: seat.ficengwind, off_map: false, liege: null }],
      county_realm: [0, 0, 0],
    },
    hierarchy: { duchies: [], county_duchy: [null, null, null], march_counties: [], claims: [] },
  });
  const [realm] = stored.realms.map((entry) => entry.id) as [number];
  const [ficengwind, hotfield] = stored.counties.map((entry) => entry.id) as [number, number, number];
  const faction = (extra: Partial<Omit<WorldFaction, 'id'>> & Pick<WorldFaction, 'name' | 'type'>): WorldFaction =>
    store.insertFaction(db, campaignId, {
      realm_id: realm,
      county_id: null,
      place_id: null,
      secrecy: 'open',
      resources: 3,
      capacities: {},
      created_day: DAY - 100,
      ...extra,
    });
  return {
    campaignId,
    crown: faction({ name: 'Kingdom of Ficengwind', type: 'realm', county_id: ficengwind, place_id: seat.ficengwind, resources: 5 }),
    house: faction({ name: 'House of Hotfield', type: 'house', county_id: hotfield, place_id: seat.hotfield }),
  };
}

function revolt(world: Crown): WorldAgenda {
  return store.insertAgenda(db, world.campaignId, {
    faction_id: world.house.id,
    template: 'revolt',
    target_kind: 'rival_faction',
    target_id: world.crown.id,
    target_name: world.crown.name,
    clock_size: 8,
    clock_filled: 8,
    portents: [{ text: 'Something stirs.', fired_day: DAY - 10, heard: false }],
    status: 'active',
    started_day: DAY - 50,
  });
}

describe("rewinding past a house's revolt", () => {
  it('drops the lordship it made, so the realms and the region briefing read as before', () => {
    const world = crown();
    const { campaignId } = world;
    const finished = revolt(world);
    const politicsBefore = politicsStore.getPolitics(db, campaignId)!;
    const briefingBefore = regionBriefing(db, campaignId, null);
    rewind.captureCheckpoint(db, campaignId, null);

    resolve.resolveAgenda(db, campaignId, finished, DAY, 11);
    const briefingWon = regionBriefing(db, campaignId, null);
    expect(politicsStore.getPolitics(db, campaignId)!.realms).toHaveLength(politicsBefore.realms.length + 1);
    expect(briefingWon).toContain('Lordship of Hotfield');
    expect(briefingWon).toContain('vassal of Kingdom of Ficengwind');

    rewind.rewindToCheckpoint(db, campaignId);

    expect(politicsStore.getPolitics(db, campaignId)).toEqual(politicsBefore);
    expect(regionBriefing(db, campaignId, null)).toBe(briefingBefore);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // Winning again after the rewind makes the lordship afresh.
    const again = store.listAgendas(db, campaignId).find((entry) => entry.id === finished.id)!;
    resolve.resolveAgenda(db, campaignId, again, DAY, 11);
    expect(regionBriefing(db, campaignId, null)).toBe(briefingWon);
  });

  it('keeps a realm the checkpoint held even when nothing points at it', () => {
    const world = crown();
    const { campaignId } = world;
    db.prepare("INSERT INTO world_realm (campaign_id, name, kind, off_map) VALUES (?, 'The Kingdom beyond the Sea', 'kingdom', 1)").run(
      campaignId,
    );
    const before = politicsStore.getPolitics(db, campaignId)!;
    rewind.captureCheckpoint(db, campaignId, null);

    resolve.resolveAgenda(db, campaignId, revolt(world), DAY, 11);
    rewind.rewindToCheckpoint(db, campaignId);

    expect(politicsStore.getPolitics(db, campaignId)).toEqual(before);
  });
});
