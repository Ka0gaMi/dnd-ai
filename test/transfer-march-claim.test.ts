// A county transfer recomputes marches from the counties' legal claims, so bounding counties to the land
// they hold never cuts a border and wrongly clears or sets a march.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { StoredCounty, StoredPolitics } from '../src/core/politics-store.js';

const large = JSON.parse(readFileSync(new URL('./fixtures/realm-large.json', import.meta.url), 'utf8')) as unknown;

let openDb: (typeof import('../src/db/connection.js'))['openDb'];
let campaign: typeof import('../src/core/campaign.js');
let region: typeof import('../src/core/region.js');
let ensureWorld: (typeof import('../src/core/world-seed.js'))['ensureWorld'];
let getPolitics: (typeof import('../src/core/politics-store.js'))['getPolitics'];
let transferCounty: (typeof import('../src/core/world-place-state.js'))['transferCounty'];
let hexNeighbours: (typeof import('../src/core/politics.js'))['hexNeighbours'];
let parseHex: (typeof import('../src/core/region-graph.js'))['parseHex'];

beforeAll(async () => {
  vi.resetModules();
  ({ openDb } = await import('../src/db/connection.js'));
  campaign = await import('../src/core/campaign.js');
  region = await import('../src/core/region.js');
  ({ ensureWorld } = await import('../src/core/world-seed.js'));
  ({ getPolitics } = await import('../src/core/politics-store.js'));
  ({ transferCounty } = await import('../src/core/world-place-state.js'));
  ({ hexNeighbours } = await import('../src/core/politics.js'));
  ({ parseHex } = await import('../src/core/region-graph.js'));
});

const claimOf = (county: StoredCounty): string[] => county.claim_hexes ?? county.hexes;

/** Counties whose claims share a land border with this one. */
function claimNeighbours(politics: StoredPolitics, county: StoredCounty): number[] {
  const hexCounty = new Map<string, number>();
  for (const entry of politics.counties) for (const hex of claimOf(entry)) hexCounty.set(hex, entry.id);
  const around = new Set<number>();
  for (const hex of claimOf(county)) {
    const { q, r } = parseHex(hex);
    for (const step of hexNeighbours(q, r)) {
      const other = hexCounty.get(`q${step.q}_r${step.r}`);
      if (other !== undefined && other !== county.id) around.add(other);
    }
  }
  return [...around];
}

describe('county transfer on bounded counties', () => {
  it('recomputes marches for the claim neighbours, by the claim', () => {
    const db = openDb(':memory:');
    const campaignId = campaign.createCampaign(db, { name: 'Marches', story_shape: 'sandbox' }).campaign_id;
    region.importRegion(db, campaignId, large, { source: 'generated' });
    ensureWorld(db, campaignId);
    const before = getPolitics(db, campaignId)!;
    // Bounded counties hold less than they claim, which is what the old held-hex adjacency missed.
    expect(before.counties.some((county) => claimOf(county).length > county.hexes.length)).toBe(true);

    // Every transfer the rules allow, each rolled back, so a held-hex adjacency slip shows on some pair.
    let checked = 0;
    for (const county of before.counties) {
      for (const realm of before.realms) {
        db.exec('SAVEPOINT transfer');
        try {
          transferCounty(db, campaignId, county.id, realm.id);
        } catch {
          db.exec('ROLLBACK TO transfer');
          db.exec('RELEASE transfer');
          continue;
        }
        const after = getPolitics(db, campaignId)!;
        const realms = new Map(after.realms.map((entry) => [entry.id, entry]));
        const byId = new Map(after.counties.map((entry) => [entry.id, entry]));
        for (const id of [county.id, ...claimNeighbours(after, byId.get(county.id)!)]) {
          const entry = byId.get(id)!;
          const around = claimNeighbours(after, entry);
          const foreign = around.filter((other) => byId.get(other)!.realm_id !== entry.realm_id).length;
          const march =
            realms.get(entry.realm_id)?.kind === 'kingdom' && around.length > 0 && foreign / around.length >= 0.4;
          expect(entry.is_march, `${county.name} to ${realm.name}: ${entry.name}`).toBe(march);
        }
        checked += 1;
        db.exec('ROLLBACK TO transfer');
        db.exec('RELEASE transfer');
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});
