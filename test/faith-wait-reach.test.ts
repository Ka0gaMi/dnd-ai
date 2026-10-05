// A day whose whole budget went to a map-wide timed-out win still counts as full, so waiting faith
// news (a lapse due before the next faith month) is retried instead of being dropped.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';
import type { WorldPlace } from '../src/core/region.js';

const large = JSON.parse(readFileSync(new URL('./fixtures/realm-large.json', import.meta.url), 'utf8')) as unknown;

/** A month day (the faith step runs on multiples of thirty) just before the waiting lapse. */
const MONTH_DAY = 300;

let db: Db;
let openDb: (typeof import('../src/db/connection.js'))['openDb'];
let campaign: typeof import('../src/core/campaign.js');
let region: typeof import('../src/core/region.js');
let settings: typeof import('../src/core/settings.js');
let seed: typeof import('../src/core/world-seed.js');
let store: typeof import('../src/core/world-store.js');
let news: typeof import('../src/core/world-news.js');
let faithStore: typeof import('../src/core/world-faith-store.js');
let tickTo: (typeof import('../src/core/world-tick.js'))['tickTo'];

beforeAll(async () => {
  // With isolate: false an earlier file may have cached a stubbed dice.ts, so import the world fresh.
  vi.resetModules();
  ({ openDb } = await import('../src/db/connection.js'));
  campaign = await import('../src/core/campaign.js');
  region = await import('../src/core/region.js');
  settings = await import('../src/core/settings.js');
  seed = await import('../src/core/world-seed.js');
  store = await import('../src/core/world-store.js');
  news = await import('../src/core/world-news.js');
  faithStore = await import('../src/core/world-faith-store.js');
  ({ tickTo } = await import('../src/core/world-tick.js'));
});

beforeEach(() => {
  db = openDb(':memory:');
});

/** A world on the given map, seeded under a pinned Math.random so the world is deterministic. */
function withWorld(realm: unknown): number {
  let state = 42;
  const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
  try {
    const campaignId = campaign.createCampaign(db, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
    region.importRegion(db, campaignId, realm, { source: 'generated' });
    seed.ensureWorld(db, campaignId);
    return campaignId;
  } finally {
    spy.mockRestore();
  }
}

function partyAt(campaignId: number, location: string): void {
  campaign.saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'They make camp.', scene_location: location });
}

function placeNamed(campaignId: number, name: string): WorldPlace {
  return region.getRegion(db, campaignId)!.places.find((place) => place.name === name)!;
}

/** A settlement far off every road, beyond even a severity-4 radius from the rest of the map. */
function addFarSettlement(campaignId: number): WorldPlace {
  db.prepare(
    `INSERT INTO world_place (campaign_id, kind, name, q, r, hexes_json, tags_json, info, link, seed, created_at)
     VALUES (?, 'settlement', 'Farhold', 100, 100, '["q100_r100"]', '{}', '', NULL, NULL, ?)`,
  ).run(campaignId, new Date().toISOString());
  return placeNamed(campaignId, 'Farhold');
}

function abandonSeeded(campaignId: number): void {
  for (const agenda of store.listAgendas(db, campaignId)) {
    store.updateAgenda(db, campaignId, agenda.id, { status: 'abandoned' });
  }
}

describe('faith news waiting behind a timed-out win', () => {
  it('retries waiting faith news after a day a map-wide timed-out win fills', () => {
    const campaignId = withWorld(large);
    settings.updateSettings(db, campaignId, { storyteller: 'calm' });
    const farhold = addFarSettlement(campaignId);
    partyAt(campaignId, farhold.name);
    abandonSeeded(campaignId);
    store.saveWorldState(db, campaignId, {
      ...store.getWorldState(db, campaignId)!,
      last_tick_day: MONTH_DAY - 1,
      quiet_until_day: 0,
    });

    // An excommunication due the day after the month day: it can only be spoken by faithOverdue,
    // which the tick runs on a later day only while every day since the month day was full.
    db.prepare('UPDATE world_faction SET faith_id = NULL, influence = NULL WHERE campaign_id = ?').run(campaignId);
    db.prepare('DELETE FROM world_faith WHERE campaign_id = ?').run(campaignId);
    const faith = faithStore.insertFaith(db, campaignId, {
      name: 'The Sunfather',
      aspect: 'sun',
      symbol: 'radiant sun',
      head_place_id: null,
      fervor: 60,
      heresy_of: null,
      last_heresy_day: null,
      created_day: 1,
    });
    const realm = db
      .prepare('SELECT id FROM world_realm WHERE campaign_id = ? ORDER BY id LIMIT 1')
      .get(campaignId) as { id: number };
    const crown = store.listFactions(db, campaignId).find((faction) => faction.type === 'realm');
    if (crown) faithStore.setFactionFaith(db, campaignId, crown.id, faith.id, 'dominant');
    faithStore.setExcommunicated(db, campaignId, realm.id, MONTH_DAY + 1);

    // A held irreversible clock the party has not heard of, timed out on the month day; its news
    // goes out at infinite reach, so it reaches even Farhold.
    const target = placeNamed(campaignId, 'Red Mill');
    db.prepare('UPDATE world_place SET known_to_party = 1 WHERE id = ?').run(target.id);
    expect(news.travelDays(region.getRegion(db, campaignId)!, target, farhold)).toBeGreaterThan(news.newsRadiusDays(4));

    const faction = store.listFactions(db, campaignId).find((entry) => entry.secrecy === 'open')!;
    store.insertAgenda(db, campaignId, {
      faction_id: faction.id,
      template: 'monsters_grow',
      target_kind: 'settlement',
      target_id: target.id,
      target_name: target.name,
      clock_size: 6,
      clock_filled: 6,
      portents: Array.from({ length: 5 }, (_, index) => ({ text: `Omen ${index}`, fired_day: MONTH_DAY - 30, heard: false })),
      status: 'held',
      started_day: MONTH_DAY - 30,
    });

    tickTo(db, campaignId, MONTH_DAY);
    tickTo(db, campaignId, MONTH_DAY + 1);

    const won = store.listEvents(db, campaignId).filter((event) => event.kind === 'agenda_won' && event.day === MONTH_DAY);
    expect(won).toHaveLength(1);
    const arrivals = db
      .prepare('SELECT place_id FROM world_packet_arrival a JOIN world_packet p ON p.id = a.packet_id WHERE p.event_id = ?')
      .all(won[0]!.id) as Array<{ place_id: number }>;
    expect(arrivals.some((row) => row.place_id === farhold.id)).toBe(true);

    expect(store.listEvents(db, campaignId).some((event) => event.kind === 'reconciled' && event.day === MONTH_DAY + 1)).toBe(
      true,
    );
  });
});
