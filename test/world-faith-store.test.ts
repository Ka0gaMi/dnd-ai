import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { findPlace, importRegion } from '../src/core/region.js';
import { insertFaction } from '../src/core/world-store.js';
import {
  addContest,
  excommunicatedUntil,
  factionFaith,
  getContest,
  getFaith,
  insertFaith,
  listFaiths,
  resetContest,
  setExcommunicated,
  setFactionFaith,
  updateFaith,
} from '../src/core/world-faith-store.js';
import { openDb, type Db } from '../src/db/connection.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

const safe = fixture('realm-safe.json');
const dangerous = fixture('realm-dangerous.json');

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(name = 'The Faithful Road'): number {
  return createCampaign(db, { name, story_shape: 'structured' }).campaign_id;
}

function redham(campaignId: number): number {
  importRegion(db, campaignId, safe, { source: 'generated' });
  return findPlace(db, campaignId, 'Redham')!.id;
}

/** A realm row to hang a contest on; the map layer owns real realms, tests only need an id. */
function newRealm(campaignId: number, name = 'Vane'): number {
  return Number(
    db
      .prepare('INSERT INTO world_realm (campaign_id, name, capital_place_id) VALUES (?, ?, NULL)')
      .run(campaignId, name).lastInsertRowid,
  );
}

function dawn(db: Db, campaignId: number, headPlaceId: number | null = null) {
  return insertFaith(db, campaignId, {
    name: 'The Dawnmother',
    aspect: 'dawn',
    symbol: 'a rising sun',
    head_place_id: headPlaceId,
    fervor: 60,
    heresy_of: null,
    last_heresy_day: null,
    created_day: 361,
  });
}

describe('faiths', () => {
  it('round-trips a faith, a heresy of it, and patches it', () => {
    const campaignId = newCampaign();
    const placeId = redham(campaignId);

    const faith = dawn(db, campaignId, placeId);
    expect(faith).toMatchObject({
      name: 'The Dawnmother',
      aspect: 'dawn',
      symbol: 'a rising sun',
      head_place_id: placeId,
      fervor: 60,
      heresy_of: null,
      last_heresy_day: null,
      created_day: 361,
    });
    expect(listFaiths(db, campaignId)).toEqual([faith]);
    expect(getFaith(db, campaignId, faith.id)).toEqual(faith);

    const heresy = insertFaith(db, campaignId, {
      name: 'The Dusk Sect',
      aspect: 'dusk',
      symbol: 'a setting sun',
      head_place_id: null,
      fervor: 40,
      heresy_of: faith.id,
      last_heresy_day: 390,
      created_day: 390,
    });
    expect(heresy.heresy_of).toBe(faith.id);
    expect(listFaiths(db, campaignId).map((f) => f.id)).toEqual([faith.id, heresy.id]);

    const patched = updateFaith(db, campaignId, faith.id, {
      fervor: 75,
      head_place_id: null,
      last_heresy_day: 400,
    });
    expect(patched).toMatchObject({ fervor: 75, head_place_id: null, last_heresy_day: 400 });
    expect(listFaiths(db, campaignId)[0]).toEqual(patched);

    expect(() => updateFaith(db, campaignId, 999, { fervor: 10 })).toThrow('No faith 999 in this campaign.');
  });

  it('clamps fervor to 0..100 on update', () => {
    const campaignId = newCampaign();
    const faith = dawn(db, campaignId);

    expect(updateFaith(db, campaignId, faith.id, { fervor: 150 }).fervor).toBe(100);
    expect(updateFaith(db, campaignId, faith.id, { fervor: -20 }).fervor).toBe(0);
    expect(updateFaith(db, campaignId, faith.id, { fervor: 30 }).fervor).toBe(30);
  });
});

describe('temple factions', () => {
  it('links a faction to a faith with an influence level and clears it again', () => {
    const campaignId = newCampaign();
    const placeId = redham(campaignId);
    const faith = dawn(db, campaignId);
    const temple = insertFaction(db, campaignId, {
      name: 'The Temple of Dawn',
      type: 'church',
      realm_id: null,
      county_id: null,
      place_id: placeId,
      secrecy: 'open',
      resources: 3,
      capacities: {},
      created_day: 361,
    });

    expect(factionFaith(db, campaignId, temple.id)).toEqual({ faith_id: null, influence: null });

    setFactionFaith(db, campaignId, temple.id, faith.id, 'dominant');
    expect(factionFaith(db, campaignId, temple.id)).toEqual({ faith_id: faith.id, influence: 'dominant' });

    setFactionFaith(db, campaignId, temple.id, faith.id, 'minor');
    expect(factionFaith(db, campaignId, temple.id)).toEqual({ faith_id: faith.id, influence: 'minor' });

    setFactionFaith(db, campaignId, temple.id, null, null);
    expect(factionFaith(db, campaignId, temple.id)).toEqual({ faith_id: null, influence: null });
  });
});

describe('church-versus-crown contests', () => {
  it('defaults to 0 of 6, upserts, clamps and resets', () => {
    const campaignId = newCampaign();
    const realmId = newRealm(campaignId);
    const faith = dawn(db, campaignId);

    expect(getContest(db, campaignId, realmId, faith.id)).toEqual({ filled: 0, size: 6 });

    expect(addContest(db, campaignId, realmId, faith.id, 2)).toBe(2);
    expect(getContest(db, campaignId, realmId, faith.id)).toEqual({ filled: 2, size: 6 });

    expect(addContest(db, campaignId, realmId, faith.id, 10)).toBe(6);
    expect(addContest(db, campaignId, realmId, faith.id, -20)).toBe(0);

    expect(addContest(db, campaignId, realmId, faith.id, 3)).toBe(3);
    resetContest(db, campaignId, realmId, faith.id);
    expect(getContest(db, campaignId, realmId, faith.id)).toEqual({ filled: 0, size: 6 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_contest').get()).toEqual({ n: 1 });
  });

  it('sets and clears a realm excommunication', () => {
    const campaignId = newCampaign();
    const realmId = newRealm(campaignId);

    expect(excommunicatedUntil(db, campaignId, realmId)).toBeNull();
    setExcommunicated(db, campaignId, realmId, 420);
    expect(excommunicatedUntil(db, campaignId, realmId)).toBe(420);
    setExcommunicated(db, campaignId, realmId, null);
    expect(excommunicatedUntil(db, campaignId, realmId)).toBeNull();
  });
});

describe('region replace with faiths', () => {
  it('clears the faith rows and swaps the map without breaking foreign keys', () => {
    const campaignId = newCampaign();
    const placeId = redham(campaignId);
    const realmId = newRealm(campaignId);
    const faith = dawn(db, campaignId, placeId);
    addContest(db, campaignId, realmId, faith.id, 3);
    const temple = insertFaction(db, campaignId, {
      name: 'The Temple of Dawn',
      type: 'church',
      realm_id: null,
      county_id: null,
      place_id: placeId,
      secrecy: 'open',
      resources: 3,
      capacities: {},
      created_day: 361,
    });
    setFactionFaith(db, campaignId, temple.id, faith.id, 'strong');

    expect(() => importRegion(db, campaignId, dangerous, { source: 'uploaded', replace: true })).not.toThrow();

    expect(db.prepare('SELECT COUNT(*) AS n FROM world_faith WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_contest WHERE campaign_id = ?').get(campaignId)).toEqual({
      n: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_faction WHERE campaign_id = ?').get(campaignId)).toEqual({
      n: 0,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
