import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { addCombatant, attack, startEncounter, statBlockFor } from '../src/combat/engine.js';
import { actionsFor } from '../src/combat/actions.js';
import { getBattleState, listCombatants, type BattleState } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
import type { StatBlockAction } from '../src/srd/data.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const MID_D20 = 0.5;
const NAT_1 = 0;

const POISONED_BLADE: StatBlockAction = {
  name: 'Poisoned Blade',
  kind: 'melee_weapon_attack',
  attack_bonus: 6,
  reach_ft: 5,
  damage: [
    { dice: '2d8+4', type: 'bludgeoning' },
    { dice: '2d6', type: 'poison' },
  ],
  text: 'Melee Attack Roll: +6, reach 5 ft. 13 (2d8 + 4) Bludgeoning damage plus 7 (2d6) Poison damage.',
};

function makeCampaign(database: Db): number {
  const id = createCampaign(database, {
    name: 'Encounters',
    story_shape: 'sandbox',
    settings: { player_rolls: 'none' },
  }).campaign_id;
  createCharacter(database, {
    campaign_id: id,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
  return id;
}

const ids = (): { pc: number; enemy: number[] } => {
  const combatants = listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
  return {
    pc: combatants.find((c) => c.kind === 'pc')!.id,
    enemy: combatants.filter((c) => c.team === 'enemy').map((c) => c.id),
  };
};

const place = (id: number, x: number, y: number): void => {
  db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, id);
};

const giveTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  const index = state.combatants.findIndex((c) => c.id === id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, state.encounter.id);
};

/** A fresh turn for one combatant: the turn is theirs and the action economy is full again. */
const startTurn = (id: number): void => {
  db.prepare(
    'UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?',
  ).run(id);
  giveTurn(id);
};

function setMap(map: BattleMap): void {
  const encounterId = getBattleState(db, campaignId)!.encounter.id;
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), encounterId);
}

const plainMap = (rows: string[]): BattleMap => ({ w: rows[0]!.length, h: rows.length, rows, features: [] });

const combatant = (id: number): BattleState['combatants'][number] =>
  getBattleState(db, campaignId)!.combatants.find((c) => c.id === id)!;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = makeCampaign(db);
});

afterEach(() => {
  Math.random = realRandom;
});

describe('monster action overrides', () => {
  it('gives a named ogre a Poisoned Blade beside its stat block actions, dealing both damage parts', async () => {
    Math.random = () => MID_D20;
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Ogre', name: 'Ogre with Poisoned Blade', unique: true, actions: [POISONED_BLADE] }],
    });
    const { pc, enemy } = ids();
    const ogre = listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === enemy[0]!)!;
    expect(ogre.name).toBe('Ogre with Poisoned Blade');
    expect(ogre.stat_block!.actions.map((a) => a.name)).toEqual(['Greatclub', 'Javelin', 'Poisoned Blade']);
    expect(actionsFor(ogre, null).map((a) => a.name)).toContain('Poisoned Blade');

    setMap(plainMap(Array.from({ length: 8 }, () => '.'.repeat(14))));
    place(pc, 2, 3);
    place(enemy[0]!, 3, 3);
    startTurn(enemy[0]!);
    const hpBefore = combatant(pc).hp_current;
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: enemy[0]!,
      target_id: pc,
      action_name: 'Poisoned Blade',
      roll: { total: 25, natural: null },
    });
    expect(swing.hit).toBe(true);
    const parts = swing.log.filter((entry) => entry.kind === 'damage');
    expect(parts.map((entry) => (entry.payload as { type: string }).type)).toEqual(['bludgeoning', 'poison']);
    const applied = parts.reduce((sum, entry) => sum + (entry.payload as { applied: number }).applied, 0);
    expect(hpBefore - combatant(pc).hp_current).toBe(applied);
    expect(applied).toBeGreaterThan(0);
  });

  it('owes one concentration save for the whole multi-part blow', async () => {
    Math.random = () => MID_D20;
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Ogre', name: 'Ogre with Poisoned Blade', actions: [POISONED_BLADE] }],
    });
    const { pc, enemy } = ids();
    db.prepare('UPDATE combatant SET concentration_json = ? WHERE id = ?').run(JSON.stringify({ name: 'hexed' }), pc);
    setMap(plainMap(Array.from({ length: 8 }, () => '.'.repeat(14))));
    place(pc, 2, 3);
    place(enemy[0]!, 3, 3);
    startTurn(enemy[0]!);
    Math.random = () => NAT_1; // the concentration save fails
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: enemy[0]!,
      target_id: pc,
      action_name: 'Poisoned Blade',
      roll: { total: 25, natural: null },
    });
    expect(swing.log.filter((entry) => entry.kind === 'concentration')).toHaveLength(1);
    expect(listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === pc)!.concentration).toBeNull();
  });

  it('replaces a stat block action of the same name in place and keeps the rest', async () => {
    Math.random = () => MID_D20;
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [
        {
          creature: 'Ogre',
          actions: [{ name: 'Greatclub', kind: 'melee_weapon_attack', attack_bonus: 6, reach_ft: 5, damage: [{ dice: '3d6', type: 'FIRE' }], text: 'Melee Attack Roll: +6, reach 5 ft. It burns.' }],
        },
      ],
    });
    const { enemy } = ids();
    const ogre = listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === enemy[0]!)!;
    const names = ogre.stat_block!.actions.map((a) => a.name);
    expect(names.filter((name) => name === 'Greatclub')).toHaveLength(1);
    expect(names).toContain('Javelin');
    const greatclub = ogre.stat_block!.actions.find((a) => a.name === 'Greatclub')!;
    expect(greatclub.damage).toEqual([{ dice: '3d6', type: 'fire' }]);
    expect(ogre.stat_block!.hp).toBe(statBlockFor('Ogre').hp);
  });

  it('refuses a malformed override and leaves nothing behind', async () => {
    Math.random = () => MID_D20;
    await expect(
      startEncounter(db, {
        campaign_id: campaignId,
        seed: 7,
        terrain: 'road',
        size: 'small',
        enemies: [
          {
            creature: 'Ogre',
            name: 'Ogre with Poisoned Blade',
            actions: [
              { name: 'Poisoned Blade', kind: 'melee_weapon_attack', attack_bonus: 6, reach_ft: 5, damage: [{ dice: '2d', type: 'poison' }], text: 'Broken.' },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/Ogre with Poisoned Blade.*Poisoned Blade/);
    expect(getBattleState(db, campaignId)).toBeNull();
    expect(db.prepare('SELECT id FROM encounter WHERE campaign_id = ?').all(campaignId)).toHaveLength(0);
  });

  it('gives a late arrival its own actions too', async () => {
    Math.random = () => MID_D20;
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior' }],
    });
    const added = await addCombatant(db, {
      campaign_id: campaignId,
      creature: 'Ogre',
      name: 'Ogre with Poisoned Blade',
      actions: [POISONED_BLADE],
    });
    const ogre = listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === added.combatant_id)!;
    expect(ogre.stat_block!.actions.map((a) => a.name)).toEqual(['Greatclub', 'Javelin', 'Poisoned Blade']);
  });

  it('leaves an enemy without overrides on its stat block exactly', async () => {
    Math.random = () => MID_D20;
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior' }],
    });
    const { enemy } = ids();
    const goblin = listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === enemy[0]!)!;
    expect(goblin.stat_block!.actions).toEqual(statBlockFor('Goblin Warrior').actions);
  });
});
