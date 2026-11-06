// PF3: use_action Multiattack on a stat block declares the Attack action and rolls nothing; each swing
// it allows is then made with attack. The swing count is read off the SRD's Multiattack wording.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { addCombatant, attack, startEncounter, undoLastCombatAction, useAction } from '../src/combat/engine.js';
import type { BattleMap } from '../src/combat/map.js';
import { attacksAllowed } from '../src/combat/resources.js';
import {
  getBattleState,
  listCombatants,
  type BattleState,
  type Combatant,
  type CombatLogEntry,
} from '../src/combat/state.js';
import { creatures, creatureStatBlock } from '../src/srd/data.js';

let db: Db;
let campaignId: number;
let randomCalls = 0;
const realRandom = Math.random;

/** The act-run call: a Bandit Captain whose Multiattack names a Hand Crossbow the DM added. */
const SELA_ACTIONS = [
  {
    name: 'Multiattack',
    kind: 'action' as const,
    text: 'Sela makes two attacks, using Scimitar and Hand Crossbow in any combination.',
  },
  {
    name: 'Hand Crossbow',
    kind: 'ranged_weapon_attack' as const,
    text: 'Ranged Attack Roll: +5, range 30/120 ft. 6 (1d6 + 3) Piercing damage.',
    attack_bonus: 5,
    range_ft: 30,
    long_range_ft: 120,
    damage: [{ dice: '1d6+3', type: 'piercing' }],
  },
];

const MISS = { total: 3, natural: 3 };
const HIT = { total: 25, natural: 12 };

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'PF3 multiattack', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
    .campaign_id;
  createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
  randomCalls = 0;
  Math.random = () => {
    randomCalls += 1;
    return 0.5;
  };
});

afterEach(() => {
  Math.random = realRandom;
});

const plainMap = (rows: string[]): BattleMap => ({ w: rows[0]!.length, h: rows.length, rows, features: [] });

/** Borg against Sela Graveney, side by side on an open field, and Sela's turn with a full economy. */
async function selaVsBorg(): Promise<{ sela: number; borg: number }> {
  const { monster, borg } = await monsterVsBorg('Bandit Captain', 'Sela Graveney', SELA_ACTIONS);
  return { sela: monster, borg };
}

/** Borg against one added monster, side by side on an open field, and the monster's turn with a full economy. */
async function monsterVsBorg(
  creature: string,
  name: string,
  actions?: typeof SELA_ACTIONS,
): Promise<{ monster: number; borg: number }> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior' }],
  });
  const added = await addCombatant(db, {
    campaign_id: campaignId,
    creature,
    name,
    team: 'enemy',
    ...(actions ? { actions } : {}),
  });
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(
    JSON.stringify(plainMap(Array.from({ length: 10 }, () => '.'.repeat(14)))),
    state.encounter.id,
  );
  const combatants = listCombatants(db, state.encounter.id);
  const borg = combatants.find((c) => c.kind === 'pc')!.id;
  const goblin = combatants.find((c) => c.id !== added.combatant_id && c.team === 'enemy')!.id;
  const monster = added.combatant_id;
  const place = (id: number, x: number, y: number): void => {
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, id);
  };
  place(borg, 5, 5);
  place(monster, 6, 5);
  place(goblin, 12, 1);
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?').run(
    monster,
  );
  const index = listCombatants(db, state.encounter.id).findIndex((c) => c.id === monster);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, state.encounter.id);
  return { monster, borg };
}

const view = (id: number): BattleState['combatants'][number] =>
  getBattleState(db, campaignId)!.combatants.find((c) => c.id === id)!;

const swing = (sela: number, borg: number, weapon: string, roll = MISS) =>
  attack(db, { campaign_id: campaignId, attacker_id: sela, target_id: borg, action_name: weapon, roll });

interface Declared {
  log: CombatLogEntry[];
  action: string;
  attacks_allowed: number;
  attacks_left: number;
  attack_names: string[];
}

const declare = async (sela: number): Promise<Declared> =>
  (await useAction(db, { campaign_id: campaignId, actor_id: sela, action_name: 'Multiattack' })) as unknown as Declared;

const count = (table: 'combat_log' | 'combat_undo'): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** What a refused call must leave exactly as it found it. */
const selaRow = (sela: number) => db.prepare('SELECT * FROM combatant WHERE id = ?').get(sela);

describe('use_action Multiattack on a stat block', () => {
  it('declares the attacks without rolling, then lets exactly that many through attack (the act-run sequence)', async () => {
    const { sela, borg } = await selaVsBorg();
    const borgHp = view(borg).hp_current;
    randomCalls = 0;

    const declared = await declare(sela);

    expect(randomCalls).toBe(0);
    expect(view(borg).hp_current).toBe(borgHp);
    const lines = declared.log;
    expect(lines.map((entry) => entry.kind)).toEqual(['action']);
    expect(lines[0]!.text).toBe('Sela Graveney uses Multiattack.');
    const note = (lines[0]!.payload as { dm_note?: string }).dm_note ?? '';
    expect(note).toMatch(/2 attacks/);
    expect(note).toMatch(/attack \{attacker_id: \d+, target_id, action_name/);
    expect(note).toContain('"Scimitar"');
    expect(note).toContain('"Hand Crossbow"');
    expect(declared).toMatchObject({ action: 'Multiattack', attacks_allowed: 2, attacks_left: 2 });
    expect(declared.attack_names).toEqual(['Scimitar', 'Hand Crossbow']);

    const first = await swing(sela, borg, 'Scimitar');
    expect(first.attacks_used).toBe(1);
    expect(first.attacks_per_action).toBe(2);
    const second = await swing(sela, borg, 'Hand Crossbow');
    expect(second.attacks_used).toBe(2);
    await expect(swing(sela, borg, 'Scimitar')).rejects.toThrow(/has taken all 2 attacks of their Attack action/);
  });

  it('keeps the player log free of the DM-only call it names', async () => {
    const { sela } = await selaVsBorg();
    await declare(sela);
    const event = db
      .prepare("SELECT payload_json AS p FROM event WHERE campaign_id = ? AND kind = 'combat' ORDER BY id DESC LIMIT 1")
      .get(campaignId) as { p: string };
    const playerLog = JSON.stringify((JSON.parse(event.p) as { log: unknown }).log);
    expect(playerLog).toContain('Sela Graveney uses Multiattack.');
    expect(playerLog).not.toContain('dm_note');
    expect(playerLog).not.toContain('Hand Crossbow');
  });

  it('says how many swings are left when the Attack action is already open', async () => {
    const { sela, borg } = await selaVsBorg();
    await swing(sela, borg, 'Scimitar');

    const declared = await declare(sela);

    expect(declared).toMatchObject({ attacks_allowed: 2, attacks_left: 1 });
    expect(declared.log[0]!.payload).toMatchObject({ dm_note: expect.stringMatching(/1 of 2 attacks/) });
    expect((await swing(sela, borg, 'Hand Crossbow')).attacks_used).toBe(2);
    await expect(swing(sela, borg, 'Scimitar')).rejects.toThrow(/has taken all 2 attacks/);
  });
});

describe('attack without the declaration', () => {
  it('works exactly as before: two swings, then a refusal', async () => {
    const { sela, borg } = await selaVsBorg();
    const first = await swing(sela, borg, 'Scimitar');
    expect(first).toMatchObject({ attacks_used: 1, attacks_per_action: 2 });
    expect(view(sela).action_used).toBe(true);
    expect((await swing(sela, borg, 'Scimitar')).attacks_used).toBe(2);
    await expect(swing(sela, borg, 'Hand Crossbow')).rejects.toThrow(/has taken all 2 attacks of their Attack action/);
  });
});

describe('a refused declaration', () => {
  it('is refused after another Action and costs nothing', async () => {
    const { sela } = await selaVsBorg();
    await useAction(db, { campaign_id: campaignId, actor_id: sela, action_name: 'dash' });
    const before = { row: selaRow(sela), log: count('combat_log'), undo: count('combat_undo') };

    await expect(declare(sela)).rejects.toThrow(
      /Sela Graveney has already taken their Action this turn \(Multiattack would be a second one\)/,
    );

    expect(selaRow(sela)).toEqual(before.row);
    expect(count('combat_log')).toBe(before.log);
    expect(count('combat_undo')).toBe(before.undo);
  });

  it('is refused once every swing is taken, and costs nothing', async () => {
    const { sela, borg } = await selaVsBorg();
    await declare(sela);
    await swing(sela, borg, 'Scimitar');
    await swing(sela, borg, 'Scimitar');
    const before = { row: selaRow(sela), log: count('combat_log'), undo: count('combat_undo') };

    await expect(declare(sela)).rejects.toThrow(/has taken all 2 attacks of their Attack action/);

    expect(selaRow(sela)).toEqual(before.row);
    expect(count('combat_log')).toBe(before.log);
    expect(count('combat_undo')).toBe(before.undo);
  });
});

describe('undo_last_combat_action around a Multiattack', () => {
  it('takes back the declaration and leaves the turn as it was', async () => {
    const { sela, borg } = await selaVsBorg();
    const before = selaRow(sela);
    await declare(sela);

    undoLastCombatAction(db, campaignId);

    expect(selaRow(sela)).toEqual(before);
    await swing(sela, borg, 'Scimitar');
    expect((await swing(sela, borg, 'Hand Crossbow')).attacks_used).toBe(2);
    await expect(swing(sela, borg, 'Scimitar')).rejects.toThrow(/has taken all 2 attacks/);
  });

  it('takes back a swing, its damage and its count, and the swing can be made again', async () => {
    const { sela, borg } = await selaVsBorg();
    const borgHp = view(borg).hp_current;
    await declare(sela);
    const afterDeclaring = selaRow(sela);
    const hit = await swing(sela, borg, 'Scimitar', HIT);
    expect(hit.hit).toBe(true);
    expect(view(borg).hp_current).toBeLessThan(borgHp);

    undoLastCombatAction(db, campaignId);

    expect(view(borg).hp_current).toBe(borgHp);
    expect(selaRow(sela)).toEqual(afterDeclaring);
    expect((await swing(sela, borg, 'Scimitar')).attacks_used).toBe(1);
    expect((await swing(sela, borg, 'Hand Crossbow')).attacks_used).toBe(2);
    await expect(swing(sela, borg, 'Scimitar')).rejects.toThrow(/has taken all 2 attacks/);
  });
});

describe('the turn view of a monster mid-Multiattack', () => {
  it('keeps listing its attacks while swings remain, and drops them after the last', async () => {
    const { sela, borg } = await selaVsBorg();
    const attacks = () => getBattleState(db, campaignId)!.legal_actions.filter((a) => a.id.startsWith('attack:'));
    const offered = (): string[] => attacks().map((a) => a.id);
    const all = ['attack:Scimitar', 'attack:Pistol', 'attack:Hand Crossbow'];
    expect(offered()).toEqual(all);
    // A stat block's swings are its Multiattack, never a sheet's Extra Attack.
    expect(attacks()[0]!.hint).toContain('Multiattack: 2 attacks with one Attack action.');
    expect(attacks()[0]!.hint).not.toContain('Extra Attack');

    await swing(sela, borg, 'Scimitar');
    expect(offered()).toEqual(all);
    expect(attacks()[0]!.hint).toContain('Multiattack: 1 of 2 attacks left.');

    await swing(sela, borg, 'Hand Crossbow');
    expect(offered()).toEqual([]);
  });
});

/** Every SRD stat block with a Multiattack, by name, with the swings one Attack action buys it. */
function srdSwings(): Map<string, number> {
  return new Map(
    creatures()
      .map((entry) => creatureStatBlock(entry))
      .filter((block) => block.actions.some((a) => a.name.toLowerCase() === 'multiattack'))
      .map((block) => [block.name, attacksAllowed({ stat_block: block } as Combatant, null)] as const),
  );
}

describe('the Multiattack swing count on every SRD stat block', () => {
  it('reads 1 to 6 swings, and 1 only where one attack comes with something that is not an attack', () => {
    const swings = srdSwings();
    expect(swings.size).toBeGreaterThan(150);
    for (const [name, count] of swings) {
      expect(count, name).toBeGreaterThanOrEqual(1);
      expect(count, name).toBeLessThanOrEqual(6);
    }
    expect([...swings].filter(([, count]) => count === 1).map(([name]) => name).sort()).toEqual([
      'Behir',
      'Dryad',
      'Giant Constrictor Snake',
      'Mummy Lord',
      'Rust Monster',
      'Succubus',
    ]);
  });

  it.each([
    ['Bandit Captain', 2],
    ['Brown Bear', 2],
    ['Balor', 2],
    ['Chimera', 3],
    ['Otyugh', 3],
    ['Cloaker', 3],
    ['Bone Devil', 3],
    ['Giant Scorpion', 3],
    ['Pit Fiend', 4],
    ['Tarrasque', 4],
    ['Xorn', 4],
    ['Roper', 4],
    ['Hydra', 5],
    ['Marilith', 6],
    // The first of two ways it may go: the other is "or it makes" instead.
    ['Barbed Devil', 2],
    ['Medusa', 3],
    ['Clay Golem', 2],
    // "Uses X" is not a swing.
    ['Behir', 1],
    ['Aboleth', 2],
    ['Planetar', 3],
    // A later sentence only swaps an attack for something else.
    ['Adult Red Dragon', 3],
    ['Young Brass Dragon', 3],
    ['Assassin', 3],
  ])('%s makes %i attacks', (name, count) => {
    expect(srdSwings().get(name)).toBe(count);
  });

  it('lets a Brown Bear make its Bite and its Claw directly, then stops', async () => {
    const { monster: bear, borg } = await monsterVsBorg('Brown Bear', 'Brown Bear');
    expect(await swing(bear, borg, 'Bite')).toMatchObject({ attacks_used: 1, attacks_per_action: 2 });
    expect((await swing(bear, borg, 'Claw')).attacks_used).toBe(2);
    await expect(swing(bear, borg, 'Bite')).rejects.toThrow(/has taken all 2 attacks of their Attack action/);
  });
});
