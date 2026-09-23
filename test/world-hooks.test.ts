// The living world advances when in-game days pass: a bounded catch-up, then news at the party's place.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { advanceTime } from '../src/core/calendar.js';
import { createCampaign, saveCheckpoint } from '../src/core/campaign.js';
import { findPlace, importRegion } from '../src/core/region.js';
import { ensureWorld } from '../src/core/world-seed.js';
import { currentGameDay, getWorldState } from '../src/core/world-store.js';
import { openDb, type Db } from '../src/db/connection.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function withWorld(): number {
  const campaignId = createCampaign(db, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
  importRegion(db, campaignId, safe, { source: 'generated' });
  ensureWorld(db, campaignId);
  return campaignId;
}

describe('onDayChange', () => {
  it('advances the world to the new day when days pass', () => {
    const campaignId = withWorld();
    expect(getWorldState(db, campaignId)!.last_tick_day).toBe(currentGameDay(db, campaignId));

    advanceTime(db, campaignId, { days: 10 });

    expect(getWorldState(db, campaignId)!.last_tick_day).toBe(currentGameDay(db, campaignId));
  });

  it('leaves the world alone when only minutes pass within a day', () => {
    const campaignId = withWorld();
    const before = getWorldState(db, campaignId)!.last_tick_day;

    advanceTime(db, campaignId, { minutes: 30 });

    expect(getWorldState(db, campaignId)!.last_tick_day).toBe(before);
  });

  it('advances a campaign with no region without error and seeds no world', () => {
    const campaignId = createCampaign(db, { name: 'Nowhere', story_shape: 'sandbox' }).campaign_id;

    expect(() => advanceTime(db, campaignId, { days: 5 })).not.toThrow();
    expect(getWorldState(db, campaignId)).toBeNull();
  });

  it('catches the world up fully over a long advance', () => {
    const campaignId = withWorld();

    advanceTime(db, campaignId, { days: 200 });

    expect(getWorldState(db, campaignId)!.last_tick_day).toBe(currentGameDay(db, campaignId));
  });

  it('delivers the news that reached the party settlement', () => {
    const campaignId = withWorld();
    saveCheckpoint(db, {
      campaign_id: campaignId,
      scene_summary: 'They arrive at the town walls.',
      scene_location: 'Redham',
    });
    const place = findPlace(db, campaignId, 'Redham')!;

    advanceTime(db, campaignId, { days: 120 });
    const today = currentGameDay(db, campaignId);

    const unheard = db
      .prepare(
        `SELECT COUNT(*) AS n FROM world_packet_arrival a
           JOIN world_packet p ON p.id = a.packet_id
          WHERE p.campaign_id = ? AND a.place_id = ? AND a.day <= ? AND a.heard = 0`,
      )
      .get(campaignId, place.id, today) as { n: number };
    expect(unheard.n).toBe(0);

    const rumours = db
      .prepare("SELECT COUNT(*) AS n FROM rumour WHERE campaign_id = ? AND source_kind = 'world'")
      .get(campaignId) as { n: number };
    expect(rumours.n).toBeGreaterThan(0);
  });
});
