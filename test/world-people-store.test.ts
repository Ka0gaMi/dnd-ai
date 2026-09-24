// The people of the world and their realm's court: storage, aging, and the region and campaign
// cleanups that must reach the new tables.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { deleteCampaign } from '../src/core/campaign-delete.js';
import { upsertEntity } from '../src/core/codex.js';
import { getPolitics, savePolitics } from '../src/core/politics-store.js';
import { importRegion } from '../src/core/region.js';
import {
  ageOf,
  getPerson,
  getRealmCourt,
  insertPerson,
  listPeople,
  setRealmCourt,
  updatePerson,
} from '../src/core/world-people-store.js';
import { openDb, type Db } from '../src/db/connection.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

const EMPTY_COURT = {
  succession_law: null,
  ruler_person_id: null,
  heir_person_id: null,
  regent_person_id: null,
  council: false,
};

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

/** A campaign with one imported region and one realm to hang people off. */
function campaignWithRealm(): { campaignId: number; realmId: number } {
  const campaignId = createCampaign(db, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
  importRegion(db, campaignId, safe, { source: 'generated' });
  const stored = savePolitics(db, campaignId, {
    realms: [{ name: 'Realm of Ash', capital_place_id: null }],
    counties: [],
  });
  return { campaignId, realmId: stored.realms[0]!.id };
}

describe('migration 031', () => {
  it('adds the people and tribal tables and the court columns', () => {
    expect(db.prepare("SELECT name FROM schema_migration WHERE name = '031_people_and_tribes.sql'").get()).toBeDefined();

    const realmColumns = (db.prepare('PRAGMA table_info(world_realm)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(realmColumns).toEqual(
      expect.arrayContaining(['succession_law', 'ruler_person_id', 'heir_person_id', 'regent_person_id', 'council']),
    );

    const countyColumns = (db.prepare('PRAGMA table_info(world_county)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(countyColumns).toContain('tribal_heritage');

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((table) => table.name);
    expect(tables).toEqual(expect.arrayContaining(['world_person', 'world_tribal_land']));
  });
});

describe('people', () => {
  it('inserts, reads and filters people by realm and life', () => {
    const { campaignId, realmId } = campaignWithRealm();
    const ruler = insertPerson(db, campaignId, {
      name: 'Queen Mira',
      house: 'House Ash',
      sex: 'female',
      birth_day: 100,
      traits: ['stern', 'just'],
      epithet: 'the Elder',
      role: 'ruler',
      realm_id: realmId,
      created_day: 361,
    });
    const heir = insertPerson(db, campaignId, {
      name: 'Prince Tor',
      sex: 'male',
      birth_day: 500,
      role: 'heir',
      realm_id: realmId,
      parent_id: ruler.id,
      created_day: 361,
    });
    insertPerson(db, campaignId, { name: 'Baron Vell', sex: 'male', birth_day: 400, role: 'rival', created_day: 361 });

    expect(ruler).toMatchObject({
      name: 'Queen Mira',
      house: 'House Ash',
      sex: 'female',
      traits: ['stern', 'just'],
      epithet: 'the Elder',
      role: 'ruler',
      realm_id: realmId,
      death_day: null,
      died_how: null,
      faction_id: null,
      entity_id: null,
      parent_id: null,
      spouse_id: null,
      created_day: 361,
    });
    expect(getPerson(db, campaignId, heir.id)).toEqual(heir);
    expect(listPeople(db, campaignId).map((person) => person.name)).toEqual(['Queen Mira', 'Prince Tor', 'Baron Vell']);
    expect(listPeople(db, campaignId, { realmId }).map((person) => person.name)).toEqual(['Queen Mira', 'Prince Tor']);
    expect(listPeople(db, campaignId, { alive: true })).toHaveLength(3);

    updatePerson(db, campaignId, heir.id, { death_day: 420, died_how: 'a duel' });

    expect(listPeople(db, campaignId, { alive: false }).map((person) => person.name)).toEqual(['Prince Tor']);
    expect(listPeople(db, campaignId, { alive: true }).map((person) => person.name)).toEqual(['Queen Mira', 'Baron Vell']);
  });

  it('updates the mutable fields and refuses an unknown person', () => {
    const { campaignId, realmId } = campaignWithRealm();
    const person = insertPerson(db, campaignId, {
      name: 'Chief Ora',
      sex: 'female',
      birth_day: 50,
      role: 'elder',
      realm_id: realmId,
      created_day: 361,
    });
    const spouse = insertPerson(db, campaignId, {
      name: 'Chief Bran',
      sex: 'male',
      birth_day: 60,
      role: 'elder',
      realm_id: realmId,
      created_day: 361,
    });
    const entity = upsertEntity(db, { campaign_id: campaignId, kind: 'npc', name: 'Chief Ora' }).entity;

    const updated = updatePerson(db, campaignId, person.id, {
      death_day: 700,
      died_how: 'old age',
      epithet: 'the Wise',
      role: 'dowager',
      spouse_id: spouse.id,
      entity_id: entity.id,
      realm_id: null,
    });

    expect(updated).toMatchObject({
      death_day: 700,
      died_how: 'old age',
      epithet: 'the Wise',
      role: 'dowager',
      spouse_id: spouse.id,
      entity_id: entity.id,
      realm_id: null,
    });
    expect(() => updatePerson(db, campaignId, 999999, { role: 'rival' })).toThrow(/No person 999999/);
  });

  it('ages a person in whole 360-day years', () => {
    const person = { birth_day: 361 };
    expect(ageOf(person, 361)).toBe(0);
    expect(ageOf(person, 720)).toBe(0);
    expect(ageOf(person, 721)).toBe(1);
    expect(ageOf(person, 1081)).toBe(2);
  });
});

describe('realm court', () => {
  it('reads defaults and writes a partial patch', () => {
    const { campaignId, realmId } = campaignWithRealm();
    expect(getRealmCourt(db, campaignId, realmId)).toEqual(EMPTY_COURT);

    const ruler = insertPerson(db, campaignId, {
      name: 'Queen Mira',
      sex: 'female',
      birth_day: 100,
      role: 'ruler',
      realm_id: realmId,
      created_day: 361,
    });
    setRealmCourt(db, campaignId, realmId, { succession_law: 'primogeniture', ruler_person_id: ruler.id, council: true });
    expect(getRealmCourt(db, campaignId, realmId)).toEqual({
      succession_law: 'primogeniture',
      ruler_person_id: ruler.id,
      heir_person_id: null,
      regent_person_id: null,
      council: true,
    });

    setRealmCourt(db, campaignId, realmId, { ruler_person_id: null, council: false });
    expect(getRealmCourt(db, campaignId, realmId)).toEqual({
      succession_law: 'primogeniture',
      ruler_person_id: null,
      heir_person_id: null,
      regent_person_id: null,
      council: false,
    });
  });

  it('returns defaults for an unknown realm', () => {
    const { campaignId } = campaignWithRealm();
    expect(getRealmCourt(db, campaignId, 999999)).toEqual(EMPTY_COURT);
  });
});

describe('region replacement with people and tribal land', () => {
  it('clears people and tribal lands and swaps the map', () => {
    const { campaignId, realmId } = campaignWithRealm();
    const chief = insertPerson(db, campaignId, {
      name: 'Chief Ora',
      sex: 'female',
      birth_day: 50,
      role: 'elder',
      realm_id: realmId,
      created_day: 361,
    });
    setRealmCourt(db, campaignId, realmId, { ruler_person_id: chief.id, council: true });
    db.prepare(
      'INSERT INTO world_tribal_land (campaign_id, realm_id, name, hexes_json, component, frontier) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(campaignId, realmId, 'The Wilds', JSON.stringify(['q6_r8']), 0, 1);

    expect(() => importRegion(db, campaignId, dangerous, { source: 'uploaded', replace: true })).not.toThrow();

    expect(getPolitics(db, campaignId)).toBeNull();
    expect(listPeople(db, campaignId)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_tribal_land WHERE campaign_id = ?').get(campaignId)).toEqual({
      n: 0,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('deleteCampaign', () => {
  it('removes people and tribal lands with the campaign', () => {
    const { campaignId, realmId } = campaignWithRealm();
    insertPerson(db, campaignId, {
      name: 'Chief Ora',
      sex: 'female',
      birth_day: 50,
      role: 'elder',
      realm_id: realmId,
      created_day: 361,
    });
    db.prepare(
      'INSERT INTO world_tribal_land (campaign_id, realm_id, name, hexes_json, component, frontier) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(campaignId, realmId, 'The Wilds', JSON.stringify(['q6_r8']), 0, 0);

    deleteCampaign(db, campaignId);

    expect(db.prepare('SELECT COUNT(*) AS n FROM world_person WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_tribal_land WHERE campaign_id = ?').get(campaignId)).toEqual({
      n: 0,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});