// Replacing a region that already has a living world must clear the world's rows before the map's
// own rows go, or the old world's foreign keys block the swap.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { advanceTime } from '../src/core/calendar.js';
import { createCampaign } from '../src/core/campaign.js';
import { getRegion, importRegion } from '../src/core/region.js';
import { ensureWorld } from '../src/core/world-seed.js';
import { getWorldState, listFactions } from '../src/core/world-store.js';
import { openDb, type Db } from '../src/db/connection.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

const WORLD_TABLE_QUERIES: Record<string, string> = {
  world_packet_arrival:
    'SELECT COUNT(*) AS n FROM world_packet_arrival WHERE packet_id IN (SELECT id FROM world_packet WHERE campaign_id = ?)',
  world_packet: 'SELECT COUNT(*) AS n FROM world_packet WHERE campaign_id = ?',
  world_attitude: 'SELECT COUNT(*) AS n FROM world_attitude WHERE campaign_id = ?',
  world_event: 'SELECT COUNT(*) AS n FROM world_event WHERE campaign_id = ?',
  world_agenda: 'SELECT COUNT(*) AS n FROM world_agenda WHERE campaign_id = ?',
  world_faction: 'SELECT COUNT(*) AS n FROM world_faction WHERE campaign_id = ?',
  world_visit: 'SELECT COUNT(*) AS n FROM world_visit WHERE campaign_id = ?',
  world_state: 'SELECT COUNT(*) AS n FROM world_state WHERE campaign_id = ?',
};

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(): number {
  return createCampaign(db, { name: 'The Changing Map', story_shape: 'sandbox' }).campaign_id;
}

/** Imports the safe map and lets three days pass, which seeds the living world from it. */
function withTickedWorld(): number {
  const campaignId = newCampaign();
  importRegion(db, campaignId, safe, { source: 'generated' });
  advanceTime(db, campaignId, { days: 3 });
  return campaignId;
}

function countRows(sql: string, campaignId: number): number {
  return (db.prepare(sql).get(campaignId) as { n: number }).n;
}

describe('importRegion after the living world exists', () => {
  it('clears every world table child-first and swaps the map', () => {
    const campaignId = withTickedWorld();
    expect(getWorldState(db, campaignId)).not.toBeNull();

    expect(() => importRegion(db, campaignId, dangerous, { source: 'uploaded', replace: true })).not.toThrow();

    for (const [table, sql] of Object.entries(WORLD_TABLE_QUERIES)) {
      expect(countRows(sql, campaignId), table).toBe(0);
    }
    expect(getRegion(db, campaignId)!.name).toBe('Ta Isle');
  });

  it('re-seeds the world from the new map on next use', () => {
    const campaignId = withTickedWorld();
    importRegion(db, campaignId, dangerous, { source: 'uploaded', replace: true });

    expect(ensureWorld(db, campaignId)!.created).toBe(true);
    expect(listFactions(db, campaignId).map((faction) => faction.name)).toContain('Lordship of Crimson Wharf');
  });

  it('replaces a region that has never seeded a world', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });
    expect(getWorldState(db, campaignId)).toBeNull();

    expect(() => importRegion(db, campaignId, dangerous, { source: 'uploaded', replace: true })).not.toThrow();
    expect(getRegion(db, campaignId)!.name).toBe('Ta Isle');
  });
});
