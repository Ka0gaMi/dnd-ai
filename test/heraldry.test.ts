// The heraldry a living world's factions wear: replay from one seed, metal-on-colour contrast and
// the blazon helper's phrasing. The real dice module is used; heraldry never calls randomSeed.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import type { WorldFaction } from '../src/core/world-store.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

const REALM_CHARGES = {
  theocracy: ['radiant sun', 'mitre', 'crossed keys'],
};

let db: Db;

let heraldryFor: (typeof import('../src/core/heraldry.js'))['heraldryFor'];
let chargePhrase: (typeof import('../src/core/heraldry.js'))['chargePhrase'];
let ensureWorld: (typeof import('../src/core/world-seed.js'))['ensureWorld'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let listFactions: (typeof import('../src/core/world-store.js'))['listFactions'];
let getWorldState: (typeof import('../src/core/world-store.js'))['getWorldState'];
let saveWorldState: (typeof import('../src/core/world-store.js'))['saveWorldState'];

beforeAll(async () => {
  // With isolate: false a prior file in this worker may have cached dice.ts under its own mock, so
  // reload the modules here to get the real generator.
  vi.resetModules();
  ({ heraldryFor, chargePhrase } = await import('../src/core/heraldry.js'));
  ({ ensureWorld } = await import('../src/core/world-seed.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ importRegion } = await import('../src/core/region.js'));
  ({ listFactions, getWorldState, saveWorldState } = await import('../src/core/world-store.js'));
});

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(target: Db = db): number {
  return createCampaign(target, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
}

function withWorld(realm: unknown, target: Db = db): { campaignId: number; factions: WorldFaction[] } {
  const campaignId = newCampaign(target);
  importRegion(target, campaignId, realm, { source: 'generated' });
  ensureWorld(target, campaignId);
  return { campaignId, factions: listFactions(target, campaignId) };
}

const isMetal = (tincture: string): boolean => tincture === 'gold' || tincture === 'silver';

describe('heraldryFor determinism', () => {
  it('returns the same heraldry for the same faction on repeated calls', () => {
    const { campaignId, factions } = withWorld(safe);
    for (const faction of factions) {
      const first = heraldryFor(db, campaignId, faction);
      expect(first).not.toBeNull();
      expect(heraldryFor(db, campaignId, faction)).toEqual(first);
    }
  });

  it('replays identically across two databases with the same world seed', () => {
    const first = openDb(':memory:');
    const second = openDb(':memory:');
    const a = withWorld(safe, first);
    const b = withWorld(safe, second);
    for (const [target, campaignId] of [
      [first, a.campaignId],
      [second, b.campaignId],
    ] as const) {
      saveWorldState(target, campaignId, { ...getWorldState(target, campaignId)!, seed: 4242 });
    }

    const byName = (target: Db, campaignId: number, factions: WorldFaction[]): Record<string, unknown> =>
      Object.fromEntries(factions.map((faction) => [faction.name, heraldryFor(target, campaignId, faction)]));

    expect(byName(first, a.campaignId, a.factions)).toEqual(byName(second, b.campaignId, b.factions));
    first.close();
    second.close();
  });
});

describe('heraldryFor tinctures', () => {
  it('sets the charge in the other class from the field on both fixtures', () => {
    for (const realm of [safe, dangerous]) {
      const { campaignId, factions } = withWorld(realm);
      expect(factions.length).toBeGreaterThan(0);
      for (const faction of factions) {
        const heraldry = heraldryFor(db, campaignId, faction)!;
        expect(isMetal(heraldry.field)).not.toBe(isMetal(heraldry.charge_tincture));
      }
    }
  });

  it("borrows a house's field from its realm's faction", () => {
    for (const realm of [safe, dangerous]) {
      const { campaignId, factions } = withWorld(realm);
      const realmFaction = factions.find((faction) => faction.type === 'realm')!;
      const houses = factions.filter((faction) => faction.type === 'house');
      expect(houses.length).toBeGreaterThan(0);
      const realmField = heraldryFor(db, campaignId, realmFaction)!.field;
      for (const house of houses) {
        expect(heraldryFor(db, campaignId, house)!.field).toBe(realmField);
      }
    }
  });

  it('picks a theocracy charge for the theocracy realm on the safe fixture', () => {
    const { campaignId, factions } = withWorld(safe);
    const realmFaction = factions.find((faction) => faction.type === 'realm')!;
    expect(REALM_CHARGES.theocracy).toContain(heraldryFor(db, campaignId, realmFaction)!.charge);
  });
});

describe('chargePhrase', () => {
  it('inserts the tincture after a leading number word', () => {
    expect(chargePhrase('silver', 'three coins')).toBe('three silver coins');
    expect(chargePhrase('gold', 'three stars')).toBe('three gold stars');
    expect(chargePhrase('red', 'three roses')).toBe('three red roses');
  });

  it('drops the article for a plural, counted or conjoined charge', () => {
    expect(chargePhrase('silver', 'crossed keys')).toBe('silver crossed keys');
    expect(chargePhrase('gold', 'clasped hands')).toBe('gold clasped hands');
    expect(chargePhrase('silver', 'hammer and tongs')).toBe('silver hammer and tongs');
    expect(chargePhrase('gold', 'balance scales')).toBe('gold balance scales');
  });

  it('keeps the article for a single charge', () => {
    expect(chargePhrase('gold', 'tower')).toBe('a gold tower');
    expect(chargePhrase('silver', 'boar')).toBe('a silver boar');
  });
});

describe('heraldryFor blazon and emblem', () => {
  it('writes the blazon from the capitalised field and the shared phrase', () => {
    const { campaignId, factions } = withWorld(safe);
    for (const faction of factions) {
      const heraldry = heraldryFor(db, campaignId, faction)!;
      const field = heraldry.field.charAt(0).toUpperCase() + heraldry.field.slice(1);
      expect(heraldry.blazon).toBe(`${field}, ${chargePhrase(heraldry.charge_tincture, heraldry.charge)}`);
      expect(heraldry.emblem).toContain(chargePhrase(heraldry.charge_tincture, heraldry.charge));
    }
  });
});

describe('heraldryFor without a world', () => {
  it('returns null when the campaign has no world state', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, safe, { source: 'generated' });
    const faction: WorldFaction = {
      id: 1,
      name: 'Nowhere',
      type: 'realm',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'open',
      resources: 3,
      capacities: {},
      entity_id: null,
      created_day: 1,
    };
    expect(getWorldState(db, campaignId)).toBeNull();
    expect(heraldryFor(db, campaignId, faction)).toBeNull();
  });
});
