import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { templatesFor } from '../src/core/agenda-templates.js';
import { createCampaign } from '../src/core/campaign.js';
import { insertFaction, listFactions, updateFaction, type WorldFaction } from '../src/core/world-store.js';
import { migrate, openDb, type Db } from '../src/db/connection.js';

const migrationsDir = fileURLToPath(new URL('../src/db/migrations/', import.meta.url));
const REBUILD = '032_world_faction_rebuild.sql';
const OLD_COLUMNS =
  'id, campaign_id, name, type, realm_id, county_id, place_id, secrecy, resources, capacities_json, entity_id, created_day, faith_id, influence';

/** A database migrated up to, not including, the rebuild, recorded the way the runner records it. */
function preRebuildDb(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE schema_migration (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && file < REBUILD)
    .sort();
  for (const file of files) {
    db.transaction(() => {
      db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
      db.prepare('INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)').run(file, 'test');
    })();
  }
  return db;
}

const insertId = (db: Db, sql: string, ...params: unknown[]): number =>
  Number(db.prepare(sql).run(...params).lastInsertRowid);

function faction(name: string, type: string, extra: Partial<Omit<WorldFaction, 'id'>> = {}): Omit<WorldFaction, 'id'> {
  return {
    name,
    type,
    realm_id: null,
    county_id: null,
    place_id: null,
    secrecy: 'open',
    resources: 3,
    capacities: {},
    entity_id: null,
    created_day: 361,
    ...extra,
  };
}

describe('the world_faction rebuild migration', () => {
  it('keeps every faction, id, agenda, event and foreign key', () => {
    const db = preRebuildDb();
    const campaignId = insertId(
      db,
      "INSERT INTO campaign (name, story_shape, created_at) VALUES ('Ashfall', 'sandbox', 'now')",
    );
    const faithId = insertId(
      db,
      "INSERT INTO world_faith (campaign_id, name, aspect, symbol, created_day) VALUES (?, 'the Ember', 'fire', 'flame', 361)",
      campaignId,
    );
    const entityId = insertId(
      db,
      "INSERT INTO entity (campaign_id, kind, name, created_at, updated_at) VALUES (?, 'faction', 'The Grey Temple', 'now', 'now')",
      campaignId,
    );
    const addFaction = db.prepare(
      `INSERT INTO world_faction (campaign_id, name, type, secrecy, resources, capacities_json, entity_id, created_day, faith_id, influence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    addFaction.run(campaignId, 'The Crown of Ash', 'realm', 'open', 5, '{"levies":2}', null, 361, null, null);
    addFaction.run(campaignId, 'The Grey Temple', 'church', 'discreet', 3, '{}', entityId, 362, faithId, 'strong');
    addFaction.run(campaignId, 'The Red Hand', 'gang', 'secret', 1, '{}', null, 363, null, null);
    addFaction.run(campaignId, 'The Forgotten', 'off_map', 'open', 2, '{}', null, 364, null, null);
    // A deleted last faction leaves the AUTOINCREMENT counter above the highest id still held.
    db.prepare("DELETE FROM world_faction WHERE name = 'The Forgotten'").run();
    const agendaId = insertId(
      db,
      `INSERT INTO world_agenda (campaign_id, faction_id, template, target_kind, target_name, clock_size, portents_json, started_day)
       VALUES (?, 3, 'raid', 'settlement', 'Redham', 4, '[]', 361)`,
      campaignId,
    );
    const addEvent = db.prepare(
      `INSERT INTO world_event (campaign_id, day, kind, text, severity, faction_id, agenda_id)
       VALUES (?, 362, ?, ?, 2, ?, ?)`,
    );
    addEvent.run(campaignId, 'portent', 'Tracks near Redham.', 3, agendaId);
    addEvent.run(campaignId, 'sermon', 'The Grey Temple preaches.', 2, null);
    addEvent.run(campaignId, 'weather', 'A storm.', null, null);

    const factionsBefore = db.prepare(`SELECT ${OLD_COLUMNS} FROM world_faction ORDER BY id`).all();
    const agendasBefore = db.prepare('SELECT * FROM world_agenda ORDER BY id').all();
    const eventsBefore = db.prepare('SELECT * FROM world_event ORDER BY id').all();
    expect(factionsBefore).toHaveLength(3);

    expect(migrate(db)).toContain(REBUILD);

    expect(db.prepare(`SELECT ${OLD_COLUMNS} FROM world_faction ORDER BY id`).all()).toEqual(factionsBefore);
    expect(db.prepare('SELECT ended_day FROM world_faction').all()).toEqual([
      { ended_day: null },
      { ended_day: null },
      { ended_day: null },
    ]);
    expect(db.prepare('SELECT * FROM world_agenda ORDER BY id').all()).toEqual(agendasBefore);
    expect(db.prepare('SELECT * FROM world_event ORDER BY id').all()).toEqual(eventsBefore);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('defer_foreign_keys', { simple: true })).toBe(0);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name IN ('world_faction_old', 'world_faction_seq')")
        .all(),
    ).toEqual([]);

    // The agendas and events still point at the rebuilt table, so it cannot lose a faction they need.
    expect(() => db.prepare('DELETE FROM world_faction WHERE id = 3').run()).toThrow(/FOREIGN KEY/);
    expect(() => insertFaction(db, campaignId, faction('the red hand', 'gang'))).toThrow(/UNIQUE/);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'world_faction'").all(),
    ).toEqual([{ name: 'idx_world_faction_name' }]);

    // The counter survives the drop, so the next faction does not reuse the deleted one's id.
    expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'world_faction'").get()).toEqual({ seq: 4 });
    expect(insertFaction(db, campaignId, faction('The Ash Wolves', 'bandits')).id).toBe(5);
  });

  it('rebuilds a table no faction was ever written to without inventing a counter', () => {
    const db = preRebuildDb();
    const campaignId = insertId(
      db,
      "INSERT INTO campaign (name, story_shape, created_at) VALUES ('Ashfall', 'sandbox', 'now')",
    );
    migrate(db);
    expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'world_faction'").get()).toBeUndefined();
    expect(insertFaction(db, campaignId, faction('The Ash Wolves', 'bandits')).id).toBe(1);
  });
});

describe('bandit factions', () => {
  it('stores a bandits faction and still refuses an unknown type', () => {
    const db = openDb(':memory:');
    const campaignId = createCampaign(db, { name: 'Ashfall', story_shape: 'structured' }).campaign_id;
    const bandits = insertFaction(db, campaignId, faction('The Ash Wolves', 'bandits', { secrecy: 'discreet' }));
    expect(bandits).toMatchObject({ name: 'The Ash Wolves', type: 'bandits', secrecy: 'discreet', ended_day: null });
    expect(listFactions(db, campaignId)).toEqual([bandits]);
    expect(() => insertFaction(db, campaignId, faction('The Sea Dogs', 'pirates'))).toThrow(/CHECK/);
  });

  it('run the raid agenda and nothing else', () => {
    expect(templatesFor('bandits').map((template) => template.id)).toEqual(['raid']);
  });
});

describe('ended factions', () => {
  it('are hidden from listFactions unless ended ones are asked for', () => {
    const db = openDb(':memory:');
    const campaignId = createCampaign(db, { name: 'Ashfall', story_shape: 'structured' }).campaign_id;
    const crown = insertFaction(db, campaignId, faction('The Crown of Ash', 'realm'));
    const wolves = insertFaction(db, campaignId, faction('The Ash Wolves', 'bandits'));
    const fallen = insertFaction(db, campaignId, faction('The Old Guild', 'guild', { ended_day: 300 }));
    expect(fallen.ended_day).toBe(300);

    const ended = updateFaction(db, campaignId, wolves.id, { ended_day: 400 });
    expect(ended.ended_day).toBe(400);

    expect(listFactions(db, campaignId).map((entry) => entry.id)).toEqual([crown.id]);
    expect(listFactions(db, campaignId, { includeEnded: true })).toEqual([crown, ended, fallen]);
  });
});
