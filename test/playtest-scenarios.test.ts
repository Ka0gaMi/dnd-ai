// The playtest scenarios that start mid-adventure: each seed must leave a campaign the DM can load.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
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
