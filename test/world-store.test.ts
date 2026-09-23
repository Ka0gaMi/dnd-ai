import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { findPlace, importRegion } from '../src/core/region.js';
import {
  currentGameDay,
  gameDay,
  getWorldState,
  insertAgenda,
  insertEvent,
  insertFaction,
  listAgendas,
  listEvents,
  listFactions,
  saveWorldState,
  updateAgenda,
  updateFaction,
} from '../src/core/world-store.js';
import { openDb, type Db } from '../src/db/connection.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

const safe = fixture('realm-safe.json');

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(name = 'The Ashfall Road'): number {
  return createCampaign(db, { name, story_shape: 'structured' }).campaign_id;
}

function redham(campaignId: number): number {
  importRegion(db, campaignId, safe, { source: 'generated' });
  return findPlace(db, campaignId, 'Redham')!.id;
}

describe('gameDay', () => {
  it('numbers consecutive days by one across a month end and a year end', () => {
    expect(gameDay({ year: 1, month: 1, day: 1 })).toBe(361);
    expect(gameDay({ year: 1, month: 1, day: 2 }) - gameDay({ year: 1, month: 1, day: 1 })).toBe(1);
    expect(gameDay({ year: 1, month: 2, day: 1 }) - gameDay({ year: 1, month: 1, day: 30 })).toBe(1);
    expect(gameDay({ year: 2, month: 1, day: 1 }) - gameDay({ year: 1, month: 12, day: 30 })).toBe(1);
  });

  it('reads the campaign calendar through currentGameDay', () => {
    const campaignId = newCampaign();
    expect(currentGameDay(db, campaignId)).toBe(gameDay({ year: 1, month: 1, day: 1 }));
  });
});

describe('world state', () => {
  it('is null before anything is saved', () => {
    expect(getWorldState(db, newCampaign())).toBeNull();
  });

  it('upserts and reads back', () => {
    const campaignId = newCampaign();
    saveWorldState(db, campaignId, { seed: 42, last_tick_day: 361, quiet_until_day: 0 });
    expect(getWorldState(db, campaignId)).toEqual({ seed: 42, last_tick_day: 361, quiet_until_day: 0 });

    saveWorldState(db, campaignId, { seed: 7, last_tick_day: 400, quiet_until_day: 410 });
    expect(getWorldState(db, campaignId)).toEqual({ seed: 7, last_tick_day: 400, quiet_until_day: 410 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_state').get()).toEqual({ n: 1 });
  });
});

describe('factions', () => {
  it('round-trips a faction and patches it', () => {
    const campaignId = newCampaign();
    const placeId = redham(campaignId);

    const faction = insertFaction(db, campaignId, {
      name: 'The Gilded Hand',
      type: 'guild',
      realm_id: null,
      county_id: null,
      place_id: placeId,
      secrecy: 'discreet',
      resources: 5,
      capacities: { coin: 3, spies: 1 },
      created_day: 361,
    });
    expect(faction).toMatchObject({
      name: 'The Gilded Hand',
      type: 'guild',
      place_id: placeId,
      secrecy: 'discreet',
      resources: 5,
      capacities: { coin: 3, spies: 1 },
      entity_id: null,
      created_day: 361,
    });
    expect(listFactions(db, campaignId)).toEqual([faction]);

    const patched = updateFaction(db, campaignId, faction.id, { resources: 2, secrecy: 'secret' });
    expect(patched).toMatchObject({
      id: faction.id,
      resources: 2,
      secrecy: 'secret',
      capacities: { coin: 3, spies: 1 },
    });
    expect(listFactions(db, campaignId)).toEqual([patched]);

    expect(() => updateFaction(db, campaignId, 999, { resources: 1 })).toThrow('No faction 999 in this campaign.');
  });
});

describe('agendas', () => {
  it('round-trips an agenda, patches it and filters the list', () => {
    const campaignId = newCampaign();
    const placeId = redham(campaignId);
    const faction = insertFaction(db, campaignId, {
      name: 'The Gilded Hand',
      type: 'guild',
      realm_id: null,
      county_id: null,
      place_id: placeId,
      secrecy: 'open',
      resources: 3,
      capacities: {},
      created_day: 361,
    });
    const other = insertFaction(db, campaignId, {
      name: 'House Vane',
      type: 'house',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'discreet',
      resources: 4,
      capacities: { levies: 2 },
      created_day: 361,
    });

    const agenda = insertAgenda(db, campaignId, {
      faction_id: faction.id,
      template: 'seize_port',
      target_kind: 'place',
      target_id: placeId,
      target_name: 'Redham',
      clock_size: 6,
      clock_filled: 0,
      portents: [{ text: 'Ships gather in the bay', fired_day: null, heard: false }],
      status: 'active',
      started_day: 361,
    });
    expect(agenda).toMatchObject({
      faction_id: faction.id,
      template: 'seize_port',
      target_id: placeId,
      target_name: 'Redham',
      clock_size: 6,
      clock_filled: 0,
      portents: [{ text: 'Ships gather in the bay', fired_day: null, heard: false }],
      status: 'active',
      known_to_party: false,
      resolved_day: null,
    });

    const won = insertAgenda(db, campaignId, {
      faction_id: other.id,
      template: 'marry_heir',
      target_kind: 'faction',
      target_id: faction.id,
      target_name: 'The Gilded Hand',
      clock_size: 4,
      clock_filled: 4,
      portents: [],
      status: 'won',
      known_to_party: true,
      started_day: 350,
    });

    expect(listAgendas(db, campaignId).map((a) => a.id)).toEqual([agenda.id, won.id]);
    expect(listAgendas(db, campaignId, { status: 'active' }).map((a) => a.id)).toEqual([agenda.id]);
    expect(listAgendas(db, campaignId, { factionId: other.id }).map((a) => a.id)).toEqual([won.id]);

    const patched = updateAgenda(db, campaignId, agenda.id, {
      clock_filled: 2,
      status: 'held',
      known_to_party: true,
      portents: [{ text: 'Ships gather in the bay', fired_day: 370, heard: true }],
    });
    expect(patched).toMatchObject({
      clock_filled: 2,
      status: 'held',
      known_to_party: true,
      portents: [{ text: 'Ships gather in the bay', fired_day: 370, heard: true }],
      resolved_day: null,
    });

    const resolved = updateAgenda(db, campaignId, agenda.id, { status: 'lost', resolved_day: 372 });
    expect(resolved).toMatchObject({ status: 'lost', resolved_day: 372 });

    expect(() => updateAgenda(db, campaignId, 999, { clock_filled: 1 })).toThrow('No agenda 999 in this campaign.');
  });
});

describe('events', () => {
  it('round-trips events and filters the ledger by day, place and severity', () => {
    const campaignId = newCampaign();
    const placeId = redham(campaignId);
    const faction = insertFaction(db, campaignId, {
      name: 'The Ashen Band',
      type: 'gang',
      realm_id: null,
      county_id: null,
      place_id: placeId,
      secrecy: 'secret',
      resources: 2,
      capacities: {},
      created_day: 361,
    });

    const raid = insertEvent(db, campaignId, {
      day: 361,
      kind: 'raid',
      text: 'Bandits burn a mill outside the walls.',
      severity: 3,
      place_id: placeId,
      faction_id: faction.id,
      agenda_id: null,
      causes: [],
      effects: { unrest: 1 },
      visibility: 'public',
    });
    const rumour = insertEvent(db, campaignId, {
      day: 361,
      kind: 'rumour',
      text: 'A whisper moves through the port.',
      severity: 1,
      place_id: null,
      faction_id: null,
      agenda_id: null,
      causes: [raid.id],
      effects: {},
      visibility: 'discreet',
    });
    const battle = insertEvent(db, campaignId, {
      day: 370,
      kind: 'battle',
      text: 'The keep falls before dawn.',
      severity: 5,
      place_id: placeId,
      faction_id: faction.id,
      agenda_id: null,
      causes: [],
      effects: { control: 'faction' },
      visibility: 'secret',
    });

    expect(raid).toMatchObject({
      day: 361,
      severity: 3,
      causes: [],
      effects: { unrest: 1 },
      visibility: 'public',
    });
    expect(rumour.causes).toEqual([raid.id]);
    expect(battle.effects).toEqual({ control: 'faction' });

    expect(listEvents(db, campaignId).map((e) => e.id)).toEqual([raid.id, rumour.id, battle.id]);
    expect(listEvents(db, campaignId, { fromDay: 362 }).map((e) => e.id)).toEqual([battle.id]);
    expect(listEvents(db, campaignId, { toDay: 361 }).map((e) => e.id)).toEqual([raid.id, rumour.id]);
    expect(listEvents(db, campaignId, { fromDay: 361, toDay: 361 }).map((e) => e.id)).toEqual([raid.id, rumour.id]);
    expect(listEvents(db, campaignId, { placeId }).map((e) => e.id)).toEqual([raid.id, battle.id]);
    expect(listEvents(db, campaignId, { minSeverity: 3 }).map((e) => e.id)).toEqual([raid.id, battle.id]);
  });
});

describe('living world migration', () => {
  it('creates the tables and adds the realm government columns', () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((t) => t.name);
    for (const table of [
      'world_state',
      'world_faction',
      'world_agenda',
      'world_event',
      'world_packet',
      'world_packet_arrival',
      'world_attitude',
      'world_visit',
    ]) {
      expect(tables).toContain(table);
    }

    const columns = (db.prepare('PRAGMA table_info(world_realm)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    for (const column of ['government', 'realm_title', 'ruler_title', 'faith']) {
      expect(columns).toContain(column);
    }
  });
});
