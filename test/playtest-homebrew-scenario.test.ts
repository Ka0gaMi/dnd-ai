// The homebrew playtest scenario: its seed must carry homebrew the engine runs, and the judge must be asked to check it.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attack, endEncounter, startEncounter } from '../src/combat/engine.js';
import { getBattleState, listCombatants } from '../src/combat/state.js';
import { rest } from '../src/core/character.js';
import { classifyClause, type Clause } from '../src/core/mechanics.js';
import { boonsThisChapter, getHomebrew } from '../src/core/progression.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { buildBundle, JUDGE_PROMPT } from '../scripts/playtest/judge.mjs';
import { engineRun, SCENARIOS, scriptedTurns } from '../scripts/playtest/scenarios.mjs';
import { replyData } from './helpers/reply.js';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'playtest-homebrew-'));
  db = openDb(join(dir, 'game.sqlite'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Row = { features_json: string; inventory_json: string };
type SheetFeature = { name: string; source: string; mechanics?: { homebrew_id?: number; used?: number; max?: number } };
type SheetItem = { name: string; equipped?: boolean; magic?: { attunement?: unknown; mechanics?: { clauses?: Clause[] } } };

const bramOf = (id: number) => db.prepare('SELECT id, features_json, inventory_json FROM character WHERE campaign_id = ? AND is_pc = 1').get(id) as Row & { id: number };
const tempered = (id: number) => (JSON.parse(bramOf(id).features_json) as SheetFeature[]).find((f) => f.name === 'Forge-Tempered')!;
const cinderbrand = (id: number) => (JSON.parse(bramOf(id).inventory_json) as SheetItem[]).find((i) => i.name === 'Cinderbrand')!;

describe('playtest scenario: homebrew', () => {
  it('asks both players for a new ability, its acceptance, a fight, a short rest and a save', () => {
    const scenario = SCENARIOS.homebrew!;
    for (const aim of [/teach/, /new ability/, /accept/, /Cinderbrand/, /Forge-Tempered/, /short rest/, /save/]) expect(scenario.goal).toMatch(aim);
    const lines = [...scriptedTurns('homebrew', 99)];
    expect(lines.length).toBeGreaterThanOrEqual(8);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.every((line) => line.trim().length > 0)).toBe(true);
    for (const step of [/new ability/, /accepts/, /attacks/, /short rest/]) expect(lines.some((line) => step.test(line))).toBe(true);
    expect(lines.at(-1)).toMatch(/save/i);
  });

  it('refuses a clause the engine only reminds about', () => {
    expect(() => engineRun('Gloom', [{ when: 'roll', if: { light: 'dim' }, do: [{ kind: 'advantage' }] }])).toThrow(/Gloom.*reminds/);
  });

  it('seeds a level 4 party, a homebrew item and a short-rest feature whose clauses the engine runs', async () => {
    const id = SCENARIOS.homebrew!.seed!(db);
    expect(db.prepare('SELECT name, class, level FROM character WHERE campaign_id = ? ORDER BY id').all(id)).toEqual([
      { name: 'Bram', class: 'Fighter', level: 4 },
      { name: 'Sister Elowen', class: 'Cleric', level: 4 },
    ]);

    const rows = db.prepare('SELECT id, kind, name, power_label, created_by FROM homebrew WHERE campaign_id = ?').all(id) as Array<{ id: number }>;
    expect(rows).toEqual([{ id: expect.any(Number), kind: 'feature', name: 'Forge-Tempered', power_label: 'within', created_by: 'player' }]);
    const feature = getHomebrew(db, rows[0]!.id)!;
    expect(feature.clauses).toHaveLength(1);
    expect(feature.clauses[0]).toMatchObject({ when: 'damage_taken', uses: { per: 'short', count: 1 } });
    expect(tempered(id)).toMatchObject({ source: 'homebrew', mechanics: { homebrew_id: feature.id } });
    // An earlier chapter's boon: the DM's new proposal is not a second one this chapter.
    expect(boonsThisChapter(db, id)).toBe(0);

    const item = cinderbrand(id);
    expect(item).toMatchObject({ equipped: true, magic: { attunement: false } });
    expect(item.magic!.mechanics!.clauses).toEqual([expect.objectContaining({ when: 'hit', uses: 'once_per_turn' })]);
    expect((JSON.parse(bramOf(id).inventory_json) as SheetItem[]).some((i) => i.name === 'Greatsword')).toBe(false);
    for (const clause of [...feature.clauses, ...item.magic!.mechanics!.clauses!]) expect(classifyClause(clause).status).toBe('runs');

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
    expect((await client.callTool({ name: 'load_campaign', arguments: { campaign_id: id } })).isError).toBeFalsy();
    for (const [text, clauses] of [
      [String(feature.schema.text), feature.clauses],
      ['Cinderbrand', item.magic!.mechanics!.clauses!],
    ] as const) {
      const checked = replyData<{ clauses: Array<{ status: string }> }>(
        await client.callTool({ name: 'check_mechanics', arguments: { campaign_id: id, text, clauses } }),
      );
      expect(checked.clauses.map((c) => c.status)).toEqual(['runs']);
    }
  });

  it('fires both clauses in a fight and gives the feature its use back on a short rest', async () => {
    const id = SCENARIOS.homebrew!.seed!(db);
    updateSettings(db, id, { player_rolls: 'none' });
    await startEncounter(db, { campaign_id: id, seed: 7, terrain: 'road', size: 'small', enemies: [{ creature: 'Gnoll Warrior', count: 1 }] });
    const encounter = getBattleState(db, id)!.encounter.id;
    const pc = () => listCombatants(db, encounter).find((c) => c.kind === 'pc')!;
    const foe = () => listCombatants(db, encounter).find((c) => c.team === 'enemy')!;
    const turnOf = (who: number) => {
      db.prepare('UPDATE combatant SET action_used = 0 WHERE id = ?').run(who);
      db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(getBattleState(db, id)!.combatants.findIndex((c) => c.id === who), encounter);
    };
    db.prepare("UPDATE combatant SET hp_max = 200, hp_current = 200 WHERE team = 'enemy'").run();
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(pc().x, pc().y + 1, foe().id);
    const hit = { total: 30, natural: 12 };

    turnOf(pc().id);
    await attack(db, { campaign_id: id, attacker_id: pc().id, target_id: foe().id, action_name: 'Greatsword', roll: hit });
    turnOf(foe().id);
    await attack(db, { campaign_id: id, attacker_id: foe().id, target_id: pc().id, action_name: 'Rend', roll: hit });
    expect(pc().temp_hp).toBeGreaterThan(0);
    expect(tempered(id).mechanics).toMatchObject({ used: 1, max: 1 });
    const log = (db.prepare('SELECT kind, text FROM combat_log WHERE encounter_id = ?').all(encounter) as Array<{ kind: string; text: string }>).map((l) => `${l.kind}: ${l.text}`);
    expect(log).toEqual(expect.arrayContaining([expect.stringMatching(/^feature_damage: Cinderbrand: Extra 1d4 fire damage/), expect.stringMatching(/^feature_resource: Bram spends 1 Forge-Tempered/)]));

    endEncounter(db, { campaign_id: id, outcome: 'victory' });
    const rested = rest(db, { campaign_id: id, character_id: bramOf(id).id, kind: 'short' }) as { features_restored?: string[] };
    expect(rested.features_restored).toContain('Forge-Tempered');
    expect(tempered(id).mechanics).toMatchObject({ used: 0 });
  });

  it('puts the homebrew on the sheets into the judge bundle and the homebrew rubric into the prompt', () => {
    const id = SCENARIOS.homebrew!.seed!(db);
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ scenario: 'homebrew', campaign_id: id, player: 'scripted', turns_played: 0 }));
    const bundle = buildBundle(dir);
    expect(bundle).toMatch(/### Homebrew \(1\)\n\n- .*"name":"Forge-Tempered".*"created_by":"player".*"damage_taken"/);
    expect(bundle).toMatch(/### Homebrew features on the sheets \(1\)\n\n- .*"character":"Bram","feature":"Forge-Tempered"/);
    expect(bundle).toMatch(/### Homebrew items carried \(1\)\n\n- .*"item":"Cinderbrand","equipped":1.*"extra_damage"/);
    for (const check of ['check_mechanics before every propose', 'decision asked and honoured', 'combat log', 'recharged by the engine', 'by hand']) {
      expect(JUDGE_PROMPT).toContain(check);
    }
  });
});
