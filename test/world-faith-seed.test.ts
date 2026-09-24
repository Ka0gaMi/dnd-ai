// The faiths a living world's first day implies: the region-wide faith, the odd realm's own and the
// influence each temple holds. The real dice module is used; nothing here stubs randomness.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

let db: Db;

let ensureFaiths: (typeof import('../src/core/world-faith-seed.js'))['ensureFaiths'];
let ensureWorld: (typeof import('../src/core/world-seed.js'))['ensureWorld'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let listFaiths: (typeof import('../src/core/world-faith-store.js'))['listFaiths'];
let factionFaith: (typeof import('../src/core/world-faith-store.js'))['factionFaith'];
let listFactions: (typeof import('../src/core/world-store.js'))['listFactions'];
let getWorldState: (typeof import('../src/core/world-store.js'))['getWorldState'];
let saveWorldState: (typeof import('../src/core/world-store.js'))['saveWorldState'];

beforeAll(async () => {
  // With isolate: false a prior file in this worker may have cached dice.ts under its own mock, so
  // reload the modules here to get the real generator.
  vi.resetModules();
  ({ ensureFaiths } = await import('../src/core/world-faith-seed.js'));
  ({ ensureWorld } = await import('../src/core/world-seed.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ importRegion } = await import('../src/core/region.js'));
  ({ listFaiths, factionFaith } = await import('../src/core/world-faith-store.js'));
  ({ listFactions, getWorldState, saveWorldState } = await import('../src/core/world-store.js'));
});

beforeEach(() => {
  db = openDb(':memory:');
});

function withWorld(realm: unknown, target: Db = db): number {
  const campaignId = createCampaign(target, { name: 'The Faithful Road', story_shape: 'structured' }).campaign_id;
  importRegion(target, campaignId, realm, { source: 'generated' });
  ensureWorld(target, campaignId);
  return campaignId;
}

function realmRows(target: Db, campaignId: number): Array<{ id: number; government: string | null; capital_place_id: number | null; faith: string | null }> {
  return target
    .prepare('SELECT id, government, capital_place_id, faith FROM world_realm WHERE campaign_id = ? ORDER BY id')
    .all(campaignId) as Array<{ id: number; government: string | null; capital_place_id: number | null; faith: string | null }>;
}

/** Strips the faiths and their links so ensureFaiths can be replayed on a fixed seed. */
function clearFaiths(target: Db, campaignId: number): void {
  target.prepare('UPDATE world_faction SET faith_id = NULL, influence = NULL WHERE campaign_id = ?').run(campaignId);
  target.prepare('DELETE FROM world_faith WHERE campaign_id = ?').run(campaignId);
  target.prepare('UPDATE world_realm SET faith = NULL WHERE campaign_id = ?').run(campaignId);
}

describe('ensureFaiths on the theocracy realm', () => {
  it('links the realm faction dominant to a faith headed at its capital', () => {
    const campaignId = withWorld(safe);
    const faiths = listFaiths(db, campaignId);
    expect(faiths).toHaveLength(1);
    const faith = faiths[0]!;

    const realm = realmRows(db, campaignId)[0]!;
    expect(realm.government).toBe('theocracy');
    expect(faith.head_place_id).toBe(realm.capital_place_id);
    expect(faith.head_place_id).not.toBeNull();

    const crown = listFactions(db, campaignId).find(
      (faction) => faction.type === 'realm' && faction.realm_id === realm.id,
    )!;
    expect(factionFaith(db, campaignId, crown.id)).toEqual({ faith_id: faith.id, influence: 'dominant' });
  });
});

describe('ensureFaiths on the non-theocracy realm', () => {
  it('links the temple with a minor or strong influence', () => {
    const campaignId = withWorld(dangerous);
    const faith = listFaiths(db, campaignId)[0]!;
    const temples = listFactions(db, campaignId).filter((faction) => faction.type === 'church');
    expect(temples.length).toBeGreaterThan(0);
    for (const temple of temples) {
      const link = factionFaith(db, campaignId, temple.id);
      expect(link.faith_id).toBe(faith.id);
      expect(['minor', 'strong']).toContain(link.influence);
    }
  });
});

describe('ensureFaiths across both fixtures', () => {
  it('gives every realm a faith through its temple or realm faction', () => {
    for (const realm of [safe, dangerous]) {
      const campaignId = withWorld(realm);
      const factions = listFactions(db, campaignId);
      for (const row of realmRows(db, campaignId)) {
        const linked = factions
          .filter((faction) => (faction.type === 'realm' || faction.type === 'church') && faction.realm_id === row.id)
          .some((faction) => factionFaith(db, campaignId, faction.id).faith_id !== null);
        expect(linked).toBe(true);
      }
    }
  });

  it("writes each realm's faith name onto the realm row", () => {
    for (const realm of [safe, dangerous]) {
      const campaignId = withWorld(realm);
      const names = listFaiths(db, campaignId).map((faith) => faith.name);
      const rows = realmRows(db, campaignId);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(names).toContain(row.faith);
    }
  });
});

describe('ensureFaiths idempotence', () => {
  it('creates nothing on a second call and leaves the rows unchanged', () => {
    const campaignId = withWorld(safe);
    const faithsBefore = listFaiths(db, campaignId);
    const linksBefore = listFactions(db, campaignId).map(
      (faction) => [faction.id, factionFaith(db, campaignId, faction.id)] as const,
    );

    expect(ensureFaiths(db, campaignId)).toBe(0);
    expect(ensureFaiths(db, campaignId)).toBe(0);

    expect(listFaiths(db, campaignId)).toEqual(faithsBefore);
    expect(
      listFactions(db, campaignId).map((faction) => [faction.id, factionFaith(db, campaignId, faction.id)] as const),
    ).toEqual(linksBefore);
  });
});

describe('ensureFaiths determinism', () => {
  it('replays identical faiths and links from the same world seed', () => {
    const first = openDb(':memory:');
    const second = openDb(':memory:');
    const a = withWorld(safe, first);
    const b = withWorld(safe, second);
    for (const [target, campaignId] of [
      [first, a],
      [second, b],
    ] as const) {
      saveWorldState(target, campaignId, { ...getWorldState(target, campaignId)!, seed: 4242 });
      clearFaiths(target, campaignId);
      expect(ensureFaiths(target, campaignId)).toBeGreaterThan(0);
    }

    const faithShape = (target: Db, campaignId: number): unknown[] =>
      listFaiths(target, campaignId).map((faith) => ({
        name: faith.name,
        aspect: faith.aspect,
        symbol: faith.symbol,
        head_place_id: faith.head_place_id,
        fervor: faith.fervor,
        created_day: faith.created_day,
      }));
    const linkShape = (target: Db, campaignId: number): unknown[] => {
      const names = new Map(listFaiths(target, campaignId).map((faith) => [faith.id, faith.name]));
      return listFactions(target, campaignId).map((faction) => {
        const link = factionFaith(target, campaignId, faction.id);
        return {
          name: faction.name,
          type: faction.type,
          faith: link.faith_id !== null ? names.get(link.faith_id) : null,
          influence: link.influence,
        };
      });
    };

    expect(faithShape(first, a)).toEqual(faithShape(second, b));
    expect(linkShape(first, a)).toEqual(linkShape(second, b));
    first.close();
    second.close();
  });
});

describe('ensureFaiths on a world seeded before faiths', () => {
  it('adds them on the next ensureWorld', () => {
    const campaignId = withWorld(safe);
    clearFaiths(db, campaignId);
    expect(listFaiths(db, campaignId)).toHaveLength(0);

    ensureWorld(db, campaignId);

    const faiths = listFaiths(db, campaignId);
    expect(faiths).toHaveLength(1);
    const crown = listFactions(db, campaignId).find((faction) => faction.type === 'realm')!;
    expect(factionFaith(db, campaignId, crown.id)).toEqual({ faith_id: faiths[0]!.id, influence: 'dominant' });
  });
});
