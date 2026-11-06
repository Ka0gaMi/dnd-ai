// The playtest scenarios that start mid-adventure: each seed must leave a campaign the DM can load.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot } from '../src/core/campaign.js';
import { findFaction, partyPlace } from '../src/core/deeds.js';
import { getRegion } from '../src/core/region.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { XP_THRESHOLDS } from '../src/core/rules.js';
import { SCENARIOS, scriptedTurns } from '../scripts/playtest/scenarios.mjs';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'playtest-scenarios-'));
  db = openDb(join(dir, 'game.sqlite'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('playtest scenarios', () => {
  it('keeps first-session unseeded', () => {
    expect(SCENARIOS['first-session']!.seed).toBeUndefined();
  });

  it.each([
    ['ambush', 3],
    ['dungeon', 5],
  ])('%s seeds a loadable campaign with a level %i party', async (name, level) => {
    const scenario = SCENARIOS[name]!;
    expect(scenario.goal.length).toBeGreaterThan(0);
    expect([...scriptedTurns(name, 99)].every((line) => line.trim().length > 0)).toBe(true);
    expect([...scriptedTurns(name, 99)].length).toBeGreaterThan(0);

    const campaignId = scenario.seed!(db);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'load_campaign', arguments: { campaign_id: campaignId } });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>).map((c) => c.text).join(' ');
    expect(text).toContain('Bram');
    expect(text).toContain('Sister Elowen');

    const people = db
      .prepare('SELECT name, is_pc, role, level, class FROM character WHERE campaign_id = ? ORDER BY id')
      .all(campaignId) as Array<{ name: string; is_pc: number; role: string; level: number; class: string }>;
    expect(people).toHaveLength(2);
    expect(people[0]).toMatchObject({ name: 'Bram', is_pc: 1, class: 'Fighter', level });
    expect(people[1]).toMatchObject({ is_pc: 0, role: 'companion', class: 'Cleric', level });
    const scene = db
      .prepare('SELECT s.location_name FROM campaign c JOIN scene s ON s.id = c.current_scene_id WHERE c.id = ?')
      .get(campaignId) as { location_name: string };
    expect(scene.location_name.length).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM quest WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 1 });
  });
});

describe('playtest scenarios: the region map', () => {
  const homes: Array<[scenario: string, town: string]> = [
    ['ambush', 'Ashford'],
    ['dungeon', 'Thornhill'],
    ['resume', 'Redham'],
    ['town', 'Quillmere'],
    ['journey', 'Greywater Crossing'],
    ['act', 'Tallowmere'],
  ];

  it('gives every seeded scenario a home town', () => {
    const seeded = Object.keys(SCENARIOS).filter((name) => SCENARIOS[name]!.seed);
    expect(seeded.sort()).toEqual(homes.map(([name]) => name).sort());
  });

  it.each(homes)('%s seeds a region with the party standing in %s, and its living world', (name, town) => {
    const id = SCENARIOS[name]!.seed!(db);
    const view = getRegion(db, id)!;
    expect(view.places.find((place) => place.name === town)?.kind).toBe('settlement');
    // The renamed settlement leaves no area behind under its old name; journey's travel area is renamed to Whitlow Moor.
    expect(view.places.filter((place) => place.kind === 'area').map((place) => place.name).sort()).toEqual([
      name === 'journey' ? 'Whitlow Moor' : 'Coldwood',
      'Ironfall Fens',
      'Raven Marshes',
    ].sort());
    expect(partyPlace(db, id)?.name).toBe(town);
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_state WHERE campaign_id = ?').get(id)).toEqual({ n: 1 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM world_faction WHERE campaign_id = ?').get(id) as { n: number }).n).toBeGreaterThan(0);
  });
});

describe('playtest scenarios: resume, town, journey', () => {
  const count = (table: string, campaignId: number, where = '1 = 1') =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE campaign_id = ? AND ${where}`).get(campaignId) as { n: number }).n;
  const load = async (campaignId: number) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
    return client.callTool({ name: 'load_campaign', arguments: { campaign_id: campaignId } });
  };

  it.each(['resume', 'town', 'journey'])('%s yields its scripted lines up to the turn limit', (name) => {
    expect(SCENARIOS[name]!.goal.length).toBeGreaterThan(0);
    const all = [...scriptedTurns(name, 99)];
    expect(all.length).toBeGreaterThan(5);
    expect(all.every((line) => line.trim().length > 0)).toBe(true);
    expect([...scriptedTurns(name, 3)]).toEqual(all.slice(0, 3));
  });

  it('resume seeds a busy save the DM can load', async () => {
    const id = SCENARIOS.resume!.seed!(db);
    expect(count('character', id, 'level = 4')).toBe(2);
    expect(count('quest', id, "status = 'open'")).toBe(6);
    expect(count('canon_fact', id)).toBeGreaterThanOrEqual(20);
    expect(count('rumour', id)).toBe(12);
    expect(count('world_faction', id)).toBeGreaterThan(0);
    expect(count('world_agenda', id)).toBeGreaterThan(0);
    expect(count('entity', id, "kind = 'npc'")).toBeGreaterThanOrEqual(5);
    expect(count('chapter', id, "status = 'open'")).toBe(1);
    const dead = db.prepare("SELECT name FROM entity WHERE campaign_id = ? AND status = 'dead'").all(id) as Array<{ name: string }>;
    expect(dead).toEqual([{ name: 'Tobias Marrowgate' }]);
    expect(count('canon_fact', id, "subject = 'Tobias Marrowgate' AND fact LIKE '%drowned%'")).toBe(1);
    expect(db.prepare('SELECT recap_text FROM session WHERE campaign_id = ? AND number = 1').get(id)).toMatchObject({ recap_text: expect.stringContaining('Brindle weir') });

    const result = await load(id);
    expect(result.isError).toBeFalsy();
    expect((result.content as Array<{ text: string }>).map((c) => c.text).join(' ')).toContain('Bram');
  });

  it('town seeds distinct named NPCs, a faction, rumours and a quest giver', async () => {
    const id = SCENARIOS.town!.seed!(db);
    const names = (db.prepare("SELECT name FROM entity WHERE campaign_id = ? AND kind = 'npc'").all(id) as Array<{ name: string }>).map((r) => r.name);
    expect(names).toHaveLength(5);
    expect(new Set(names.map((n) => n.split(' ')[0]!.slice(0, 3))).size).toBe(5);
    expect(names).toContain('Ildric Vane');
    expect(count('entity', id, "kind = 'faction'")).toBe(1);
    expect(count('rumour', id)).toBe(5);
    expect((await load(id)).isError).toBeFalsy();
  });

  it('seeds each central faction as a world faction a deed can target', () => {
    for (const [name, faction] of [['resume', "The Lamplighters' Guild"], ['town', "The Eelwrights' Compact"], ['act', "The Chandlers' Guild"]]) {
      const id = SCENARIOS[name!]!.seed!(db);
      const row = db.prepare('SELECT entity_id FROM world_faction WHERE campaign_id = ? AND name = ?').get(id, faction) as { entity_id: number } | undefined;
      expect(row?.entity_id, `${name}: ${faction}`).toBeGreaterThan(0);
      expect(findFaction(db, id, faction)?.name).toBe(faction);
    }
    expect(count('entity', SCENARIOS.town!.seed!(db), "kind = 'faction'")).toBe(1);
  });

  it('journey puts Harrowgate and the Whitlow Moor on its region map', () => {
    const id = SCENARIOS.journey!.seed!(db);
    const places = getRegion(db, id)!.places;
    expect(places.find((place) => place.name === 'Harrowgate')?.kind).toBe('settlement');
    expect(places.find((place) => place.name === 'Whitlow Moor')?.kind).toBe('area');
  });

  it('journey leaves the party one level-up away', () => {
    const id = SCENARIOS.journey!.seed!(db);
    const people = db.prepare('SELECT level, xp FROM character WHERE campaign_id = ?').all(id) as Array<{ level: number; xp: number }>;
    expect(people).toHaveLength(2);
    for (const p of people) {
      expect(p.level).toBe(3);
      expect(p.xp).toBeGreaterThanOrEqual(XP_THRESHOLDS[3]!);
    }
  });
});

describe('playtest scenario: act', () => {
  const all = <T,>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[];
  const hiddenNotes = (campaignId: number, name: string) =>
    (db.prepare('SELECT hidden_notes FROM entity WHERE campaign_id = ? AND name = ?').get(campaignId, name) as { hidden_notes: string }).hidden_notes;

  it('briefs the Claude player for a long act and breaks it into sessions', () => {
    const act = SCENARIOS.act!;
    for (const aim of [/clues/, /Wren Hollis/, /Hobb's Sundries/, /rest/, /level-up/, /in character/, /do not rush/]) expect(act.playerBrief).toMatch(aim);
    expect(act.sessionEvery).toBeGreaterThanOrEqual(30);
    expect(act.sessionEvery).toBeLessThanOrEqual(40);
    const lines = [...scriptedTurns('act', 99)];
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.every((line) => line.trim().length > 0)).toBe(true);
    expect(lines.at(-1)).toMatch(/save/i);
  });

  it('seeds a level 1 hub town with a hidden culprit, clues at several places, fights, a companion candidate and gold', async () => {
    const id = SCENARIOS.act!.seed!(db);
    expect(all('SELECT name, is_pc, level, xp, gold FROM character WHERE campaign_id = ?', id)).toEqual([
      { name: 'Bram', is_pc: 1, level: 1, xp: 0, gold: 78 },
    ]);
    const places = all<{ name: string }>("SELECT name FROM entity WHERE campaign_id = ? AND kind = 'place'", id).map((p) => p.name);
    expect(places.length).toBeGreaterThanOrEqual(6);
    expect(places).toEqual(expect.arrayContaining(['Tallowmere', 'The Wick and Whistle', "Hobb's Sundries"]));
    expect(all("SELECT name FROM entity WHERE campaign_id = ? AND kind = 'npc'", id).length).toBeGreaterThanOrEqual(5);
    expect(hiddenNotes(id, 'Wren Hollis')).toMatch(/create_companion/);
    expect(hiddenNotes(id, 'Osgar Penhallow')).toMatch(/culprit/);

    const clues = all<{ text: string; hidden: number }>('SELECT text, hidden FROM clue WHERE campaign_id = ?', id);
    expect(clues.length).toBeGreaterThanOrEqual(3);
    expect(clues.every((c) => c.hidden === 1)).toBe(true);
    const where = clues.map((c) => places.find((p) => c.text.startsWith(`${p}:`)));
    expect(where.every(Boolean)).toBe(true);
    expect(new Set(where).size).toBe(clues.length);

    expect(all("SELECT title FROM quest WHERE campaign_id = ? AND status = 'open'", id)).toHaveLength(4);
    const secret = (db.prepare('SELECT secret_notes FROM story_outline WHERE campaign_id = ?').get(id) as { secret_notes: string }).secret_notes;
    expect(secret).toMatch(/^Culprit: Guildmaster Osgar Penhallow/);
    expect(/Likely fights: (.*)/.exec(secret)![1]!.split(';').length).toBeGreaterThanOrEqual(3);
    expect(secret).toMatch(/level 2 .* level 3/);

    const shown = JSON.stringify(campaignSnapshot(db, id, { forPlayer: true }));
    for (const hidden of [...secret.split('\n'), hiddenNotes(id, 'Osgar Penhallow'), ...clues.map((c) => c.text)]) expect(shown).not.toContain(hidden);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
    expect((await client.callTool({ name: 'load_campaign', arguments: { campaign_id: id } })).isError).toBeFalsy();
  });

  it('seeds the same campaign every time', () => {
    const rows = (d: Db) => {
      const id = SCENARIOS.act!.seed!(d);
      return [
        d.prepare('SELECT name, level, xp, gold, hp_max, ac FROM character WHERE campaign_id = ?').all(id),
        d.prepare('SELECT kind, name, summary, hidden_notes, status FROM entity WHERE campaign_id = ? ORDER BY id').all(id),
        d.prepare('SELECT text, hidden FROM clue WHERE campaign_id = ? ORDER BY id').all(id),
        d.prepare('SELECT title, kind, summary FROM quest WHERE campaign_id = ? ORDER BY id').all(id),
        d.prepare('SELECT text, scope, truth FROM rumour WHERE campaign_id = ? ORDER BY id').all(id),
      ];
    };
    const other = openDb(join(dir, 'other.sqlite'));
    try {
      expect(rows(other)).toEqual(rows(db));
    } finally {
      other.close();
    }
  });
});
