// The playtest scenarios that start mid-adventure: each seed must leave a campaign the DM can load.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
