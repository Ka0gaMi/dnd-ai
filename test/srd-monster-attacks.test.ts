import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { attack, startEncounter, statBlockFor } from '../src/combat/engine.js';
import { isAttack } from '../src/combat/actions.js';
import { getBattleState, listCombatants } from '../src/combat/state.js';
import * as srd from '../src/srd/data.js';

/** Every stat-block action whose SRD text opens with an attack roll, as the engine builds it. */
const attackActions = (): Array<{ creature: string; action: srd.StatBlockAction }> =>
  srd.creatures().flatMap((creature) => {
    const block = srd.creatureStatBlock(creature);
    return [...block.actions, ...block.bonus_actions, ...block.reactions, ...block.legendary_actions]
      .filter((action) => /^(Melee or Ranged|Melee|Ranged) Attack Roll:/.test(action.text))
      .map((action) => ({ creature: block.name, action }));
  });

/** One engine damage part written back the way the 2024 stat block prints it: "5 (1d4 + 3) Piercing damage". */
function printed(part: { dice: string; type: string | null }): string {
  const kind = part.type ? `${part.type[0]!.toUpperCase()}${part.type.slice(1)} damage` : 'damage of the type';
  const dice = /^(\d+)d(\d+)([+-]\d+)?$/.exec(part.dice);
  if (!dice) return `${part.dice} ${kind}`;
  const [count, faces, mod] = [Number(dice[1]), Number(dice[2]), Number(dice[3] ?? 0)];
  const average = Math.floor((count * (faces + 1)) / 2 + mod);
  return `${average} (${count}d${faces}${mod ? ` ${mod > 0 ? '+' : '-'} ${Math.abs(mod)}` : ''}) ${kind}`;
}

const stats = (creature: string, name: string): srd.StatBlockAction =>
  statBlockFor(creature).actions.find((action) => action.name === name)!;

describe('SRD stat-block attacks', () => {
  it('makes every action whose text is an attack roll an engine attack matching that text', () => {
    const actions = attackActions();
    expect(actions).toHaveLength(423);
    for (const { creature, action } of actions) {
      const label = `${creature}: ${action.name}`;
      const text = action.text;
      expect(isAttack(action), label).toBe(true);
      expect(action.kind, label).toBe(text.startsWith('Ranged') ? 'ranged_weapon_attack' : 'melee_weapon_attack');
      expect(action.attack_bonus, label).toBe(Number(/Attack Roll: ([+-]\d+)/.exec(text)![1]));
      const reach = /, reach (\d+) f/.exec(text);
      const range = /\brange (\d+)(?:\/(\d+))? f/.exec(text);
      expect(action.reach_ft, label).toBe(reach ? Number(reach[1]) : undefined);
      expect(action.range_ft, label).toBe(range ? Number(range[1]) : undefined);
      expect(action.long_range_ft, label).toBe(range?.[2] ? Number(range[2]) : undefined);
      // The base damage is the first the text prints and its riders follow it unbroken; "—or … if …—" is an alternative.
      const plain = text.replace(/—or [^—]*—/, ' ');
      const first = plain.search(/\d+(?: \([^)]*\))? (?:\w+ )?damage/);
      const damage = (action.damage ?? []).map(printed).join(' plus ');
      if (damage === '') {
        expect(first, label).toBe(-1);
        continue;
      }
      expect(plain.indexOf(damage), label).toBe(first);
      expect(plain.slice(first + damage.length), label).not.toMatch(/^ plus /);
    }
  });

  it('reads the attacks upstream has no row for, or a wrong one, from the text', () => {
    expect(stats('Giant Rat', 'Bite')).toMatchObject({
      kind: 'melee_weapon_attack',
      attack_bonus: 5,
      reach_ft: 5,
      damage: [{ dice: '1d4+3', type: 'piercing' }],
    });
    expect(stats('Bat', 'Bite').damage).toEqual([{ dice: '1', type: 'piercing' }]);
    expect(stats('Roper', 'Tentacle')).toMatchObject({ kind: 'melee_weapon_attack', attack_bonus: 7, reach_ft: 60, damage: [] });
    expect(stats('Sprite', 'Enchanting Bow')).toMatchObject({ kind: 'ranged_weapon_attack', range_ft: 40, long_range_ft: 160 });
    expect(stats('Jackal', 'Bite').damage).toEqual([{ dice: '1d4-1', type: 'piercing' }]);
    expect(stats('Adult Bronze Dragon', 'Rend').damage).toEqual([
      { dice: '2d8+7', type: 'slashing' },
      { dice: '1d10', type: 'lightning' },
    ]);
    expect(stats('Cultist', 'Ritual Sickle').damage).toEqual([
      { dice: '1d4+1', type: 'slashing' },
      { dice: '1', type: 'necrotic' },
    ]);
    expect(stats('Mimic', 'Bite').damage).toEqual([
      { dice: '1d8+3', type: 'piercing' },
      { dice: '1d8', type: 'acid' },
    ]);
    // "plus 2 (1d4) Slashing damage if the attack roll had Advantage" is conditional, so it stays the DM's call.
    expect(stats('Goblin Warrior', 'Scimitar').damage).toEqual([{ dice: '1d6+2', type: 'slashing' }]);
  });
});

describe('a Giant Rat in combat', () => {
  let db: Db;
  let campaignId: number;
  const realRandom = Math.random;

  beforeEach(() => {
    db = openDb(':memory:');
    campaignId = createCampaign(db, {
      name: 'Rats',
      story_shape: 'sandbox',
      settings: { player_rolls: 'none' },
    }).campaign_id;
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
  });

  afterEach(() => {
    Math.random = realRandom;
  });

  it('bites through the attack tool instead of being refused as no attack', async () => {
    Math.random = () => 0.5;
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Giant Rat' }],
    });
    const encounter = getBattleState(db, campaignId)!.encounter;
    const combatants = listCombatants(db, encounter.id);
    const pc = combatants.find((c) => c.kind === 'pc')!.id;
    const rat = combatants.find((c) => c.team === 'enemy')!.id;
    db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(
      JSON.stringify({ w: 8, h: 8, rows: Array.from({ length: 8 }, () => '.'.repeat(8)), features: [] }),
      encounter.id,
    );
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(2, 3, pc);
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(3, 3, rat);
    const turn = getBattleState(db, campaignId)!.combatants.findIndex((c) => c.id === rat);
    db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(turn, encounter.id);

    const bite = await attack(db, {
      campaign_id: campaignId,
      attacker_id: rat,
      target_id: pc,
      action_name: 'Bite',
      roll: { total: 25, natural: null },
    });
    expect(bite.hit).toBe(true);
    const damage = bite.log.filter((entry) => entry.kind === 'damage');
    expect(damage.map((entry) => (entry.payload as { type: string }).type)).toEqual(['piercing']);
  });
});
