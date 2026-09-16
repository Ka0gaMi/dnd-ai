// Audit P2: the 2024 condition table and the engine readers that missed it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, heal as healPc } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import {
  activeEncounter,
  getBattleState,
  listCombatants,
  type BattleState,
} from '../src/combat/state.js';
import {
  applyEffect,
  attack,
  damageCombatant,
  moveToken,
  setCombatCondition,
  startEncounter,
} from '../src/combat/engine.js';
import {
  conditionDamageResistances,
  conditionImmunitiesFrom,
} from '../src/combat/conditions.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const MID_D20 = 0.5;

function makeCampaign(database: Db): number {
  const id = createCampaign(database, { name: 'Audit P2', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
    .campaign_id;
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

async function ambush(enemies = 1): Promise<BattleState> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: enemies }],
  });
  return getBattleState(db, campaignId)!;
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

const startTurn = (id: number): void => {
  db.prepare(
    'UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed, flags_json = NULL WHERE id = ?',
  ).run(id);
  giveTurn(id);
};

const combatantOf = (id: number): BattleState['combatants'][number] =>
  getBattleState(db, campaignId)!.combatants.find((c) => c.id === id)!;

const hit = { total: 25, natural: 12 };

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = makeCampaign(db);
  Math.random = () => MID_D20;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('defect 1: Stunned carries no Speed 0 in 2024', () => {
  it('lets a stunned combatant move', async () => {
    await ambush();
    const { pc } = ids();
    place(pc, 1, 5);
    giveTurn(pc);
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'stunned', active: true });
    // The 2024 Stunned text has three clauses and no Speed 0, so the move is refused only by movement.
    expect(() => moveToken(db, { campaign_id: campaignId, combatant_id: pc, to: { x: 3, y: 5 } })).not.toThrow();
    expect(combatantOf(pc).movement_left).toBeLessThan(combatantOf(pc).speed);
  });
});

describe('defect 2: Unconscious brings Prone and ending it leaves Prone', () => {
  it('drops a monster unconscious and prone, and ending the Unconscious leaves the Prone', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    db.prepare('UPDATE combatant SET hp_current = 1 WHERE id = ?').run(enemy[0]!);
    startTurn(pc);
    await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Unarmed Strike',
      roll: hit,
    });
    expect(combatantOf(enemy[0]!).conditions).toContain('unconscious');
    expect(combatantOf(enemy[0]!).conditions).toContain('prone');

    setCombatCondition(db, { campaign_id: campaignId, combatant_id: enemy[0]!, condition: 'unconscious', active: false });
    const ended = combatantOf(enemy[0]!);
    expect(ended.conditions).not.toContain('unconscious');
    expect(ended.conditions).toContain('prone');
  });

  it('leaves a knocked-out player character prone when healing wakes them', async () => {
    await ambush();
    const { pc, enemy } = ids();
    const characterId = combatantOf(pc).character_id!;
    db.prepare('UPDATE character SET hp_current = 1, stable = 1 WHERE id = ?').run(characterId);
    db.prepare('UPDATE combatant SET hp_current = 1 WHERE id = ?').run(pc);
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    startTurn(enemy[0]!);

    await attack(db, {
      campaign_id: campaignId,
      attacker_id: enemy[0]!,
      target_id: pc,
      action_name: 'Scimitar',
      knock_out: true,
      roll: hit,
    });
    expect(combatantOf(pc).conditions).toContain('unconscious');
    expect(combatantOf(pc).conditions).toContain('prone');

    healPc(db, { campaign_id: campaignId, amount: 5 });
    const woken = combatantOf(pc);
    expect(woken.conditions).not.toContain('unconscious');
    expect(woken.conditions).toContain('prone');
  });
});

describe('defect 3: Petrified resists all damage and shrugs off Poisoned', () => {
  it('halves every damage type against a Petrified target', async () => {
    await ambush();
    const { enemy } = ids();
    const encounter = activeEncounter(db, campaignId)!;
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: enemy[0]!, condition: 'petrified', active: true });
    db.prepare('UPDATE combatant SET hp_current = 30 WHERE id = ?').run(enemy[0]!);
    const target = listCombatants(db, encounter.id).find((c) => c.id === enemy[0]!)!;
    const before = target.hp_current;

    damageCombatant(db, encounter, target, { amount: 10, type: 'fire' });
    expect(before - combatantOf(enemy[0]!).hp_current).toBe(5);
  });

  it('refuses the Poisoned condition on a Petrified creature', async () => {
    await ambush();
    const { enemy } = ids();
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: enemy[0]!, condition: 'petrified', active: true });
    expect(() =>
      applyEffect(db, {
        campaign_id: campaignId,
        target_id: enemy[0]!,
        name: 'poisoned',
        kind: 'condition',
        tick: 'end',
        ends: 'manual',
      }),
    ).toThrow(/immune to the poisoned condition/);
    expect(combatantOf(enemy[0]!).conditions).not.toContain('poisoned');
  });
});

describe('defect 4: Charmed cannot attack its charmer', () => {
  it('refuses a swing at the source of the Charmed condition', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    applyEffect(db, {
      campaign_id: campaignId,
      target_id: pc,
      source_id: enemy[0]!,
      name: 'charmed',
      kind: 'condition',
      tick: 'end',
      ends: 'manual',
    });
    giveTurn(pc);
    await expect(
      attack(db, { campaign_id: campaignId, attacker_id: pc, target_id: enemy[0]!, action_name: 'Unarmed Strike' }),
    ).rejects.toThrow(/charmed/);
  });
});

describe('defect 5: Incapacitated and Invisible move Initiative', () => {
  const setPcConditions = (conditions: string[]): void => {
    const characterId = (db.prepare('SELECT id FROM character WHERE campaign_id = ? AND is_pc = 1').get(campaignId) as {
      id: number;
    }).id;
    db.prepare('UPDATE character SET conditions_json = ? WHERE id = ?').run(JSON.stringify(conditions), characterId);
  };

  const borgInitiative = (): { roll: string } => {
    const entry = getBattleState(db, campaignId)!.log_tail.find(
      (e) => e.kind === 'initiative' && e.text.startsWith('Borg'),
    )!;
    return entry.payload as { roll: string };
  };

  it('rolls an Incapacitated creature with Disadvantage', async () => {
    setPcConditions(['incapacitated']);
    await ambush();
    expect(borgInitiative().roll).toContain('2d20');
  });

  it('rolls an Invisible creature with Advantage', async () => {
    setPcConditions(['invisible']);
    await ambush();
    expect(borgInitiative().roll).toContain('2d20');
  });
});

describe('defect 3: the Petrified table entry', () => {
  it('expresses the Petrified resistances and immunity in the table', () => {
    expect(conditionDamageResistances(['petrified'])).toEqual(['all']);
    expect(conditionImmunitiesFrom(['petrified'])).toEqual(['poisoned']);
  });
});
