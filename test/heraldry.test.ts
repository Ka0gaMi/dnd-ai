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
const medium = JSON.parse(readFileSync(new URL('./fixtures/realm-medium.json', import.meta.url), 'utf8')) as unknown;
const large = JSON.parse(readFileSync(new URL('./fixtures/realm-large.json', import.meta.url), 'utf8')) as unknown;

const REALM_CHARGES = {
  theocracy: ['radiant sun', 'mitre', 'crossed keys'],
};

let db: Db;

let heraldryFor: (typeof import('../src/core/heraldry.js'))['heraldryFor'];
let chargePhrase: (typeof import('../src/core/heraldry.js'))['chargePhrase'];
let OUTLAW_CHARGES: (typeof import('../src/core/heraldry.js'))['OUTLAW_CHARGES'];
let ensureWorld: (typeof import('../src/core/world-seed.js'))['ensureWorld'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let currentGameDay: (typeof import('../src/core/world-store.js'))['currentGameDay'];
let insertFaction: (typeof import('../src/core/world-store.js'))['insertFaction'];
let listFactions: (typeof import('../src/core/world-store.js'))['listFactions'];
let getWorldState: (typeof import('../src/core/world-store.js'))['getWorldState'];
let saveWorldState: (typeof import('../src/core/world-store.js'))['saveWorldState'];
let factionFaith: (typeof import('../src/core/world-faith-store.js'))['factionFaith'];
let getFaith: (typeof import('../src/core/world-faith-store.js'))['getFaith'];

beforeAll(async () => {
  // With isolate: false a prior file in this worker may have cached dice.ts under its own mock, so
  // reload the modules here to get the real generator.
  vi.resetModules();
  ({ heraldryFor, chargePhrase, OUTLAW_CHARGES } = await import('../src/core/heraldry.js'));
  ({ ensureWorld } = await import('../src/core/world-seed.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ importRegion } = await import('../src/core/region.js'));
  ({ currentGameDay, insertFaction, listFactions, getWorldState, saveWorldState } =
    await import('../src/core/world-store.js'));
  ({ factionFaith, getFaith } = await import('../src/core/world-faith-store.js'));
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
const armsKey = (arms: { field: string; charge: string; charge_tincture: string }): string =>
  `${arms.field}|${arms.charge}|${arms.charge_tincture}`;

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
    // The dangerous island is a lone lordship with no houses, so the medium map stands in for it.
    for (const realm of [safe, medium]) {
      const { campaignId, factions } = withWorld(realm);
      const houses = factions.filter((faction) => faction.type === 'house');
      expect(houses.length).toBeGreaterThan(0);
      for (const house of houses) {
        const realmFaction = factions.find((faction) => faction.type === 'realm' && faction.realm_id === house.realm_id)!;
        expect(heraldryFor(db, campaignId, house)!.field).toBe(heraldryFor(db, campaignId, realmFaction)!.field);
      }
    }
  });

  it('picks a theocracy charge for the theocracy realm on the safe fixture', () => {
    const { campaignId, factions } = withWorld(safe);
    const realmFaction = factions.find((faction) => faction.type === 'realm')!;
    expect(REALM_CHARGES.theocracy).toContain(heraldryFor(db, campaignId, realmFaction)!.charge);
  });
});

describe('heraldryFor uniqueness', () => {
  it('gives every faction a distinct field, charge and tincture on safe, medium and large', () => {
    for (const realm of [safe, medium, large]) {
      const { campaignId, factions } = withWorld(realm);
      expect(factions.length).toBeGreaterThan(0);
      const keys = factions.map((faction) => armsKey(heraldryFor(db, campaignId, faction)!));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('leaves existing arms unchanged when a new faction is added', () => {
    const { campaignId, factions } = withWorld(large);
    const before = new Map(factions.map((faction) => [faction.id, heraldryFor(db, campaignId, faction)!]));

    insertFaction(db, campaignId, {
      name: 'The Ashen Heresy',
      type: 'church',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'open',
      resources: 2,
      capacities: {},
      created_day: currentGameDay(db, campaignId),
    });

    for (const faction of factions) {
      expect(heraldryFor(db, campaignId, faction)).toEqual(before.get(faction.id)!);
    }
  });
});

describe('heraldryFor faction identity', () => {
  it('keeps a house distinct from its realm beyond the shared field', () => {
    const { campaignId, factions } = withWorld(large);
    const houses = factions.filter((faction) => faction.type === 'house');
    expect(houses.length).toBeGreaterThan(0);
    for (const house of houses) {
      const arms = heraldryFor(db, campaignId, house)!;
      const realmFaction = factions.find((faction) => faction.type === 'realm' && faction.realm_id === house.realm_id)!;
      const realmArms = heraldryFor(db, campaignId, realmFaction)!;
      expect(arms.field).toBe(realmArms.field);
      expect(arms.charge === realmArms.charge && arms.charge_tincture === realmArms.charge_tincture).toBe(false);
    }
  });

  it("bears a church's faith symbol as its charge", () => {
    const { campaignId, factions } = withWorld(large);
    const churches = factions.filter((faction) => faction.type === 'church');
    expect(churches.length).toBeGreaterThan(0);
    for (const church of churches) {
      const faithId = factionFaith(db, campaignId, church.id).faith_id;
      expect(faithId).not.toBeNull();
      const faith = getFaith(db, campaignId, faithId!)!;
      expect(heraldryFor(db, campaignId, church)!.charge).toBe(faith.symbol);
    }
  });

  it('gives a lordship no crown', () => {
    const { campaignId, factions } = withWorld(large);
    const kindOf = db.prepare('SELECT kind FROM world_realm WHERE campaign_id = ? AND id = ?');
    const lordships = factions.filter(
      (faction) =>
        faction.type === 'realm' &&
        (kindOf.get(campaignId, faction.realm_id) as { kind: string } | undefined)?.kind === 'lordship',
    );
    expect(lordships.length).toBeGreaterThan(0);
    for (const lordship of lordships) {
      expect(heraldryFor(db, campaignId, lordship)!.charge).not.toBe('crown');
    }
  });

  it('gives bandits an outlaw badge, never a noble or off-map charge', () => {
    const { campaignId, factions } = withWorld(large);
    const bandits = factions.filter((faction) => faction.type === 'bandits');
    expect(bandits.length).toBeGreaterThan(0);
    for (const bandit of bandits) {
      const arms = heraldryFor(db, campaignId, bandit)!;
      expect(OUTLAW_CHARGES).toContain(arms.charge);
      expect(arms.emblem).toContain('outlaw badge');
      expect(['star', 'sea serpent']).not.toContain(arms.charge);
    }
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
