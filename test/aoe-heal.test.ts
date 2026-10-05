import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, createCompanion } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { addCombatant, startEncounter, useAction } from '../src/combat/engine.js';
import { getBattleState, listCombatants } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const MID_D20 = 0.5;

function makeCampaign(database: Db): number {
  const id = createCampaign(database, { name: 'AoE Heal', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
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

/** A level 5 caster with a level 3 slot for Fireball and a level 5 slot for Mass Cure Wounds. */
function makeHealer(): number {
  const id = createCompanion(db, {
    campaign_id: campaignId,
    name: 'Medic',
    source: { class: 'Wizard', species: 'Human', background: 'Sage' },
  }).companion!.id;
  db.prepare('UPDATE character SET level = 5, spells_json = ?, spell_slots_json = ? WHERE id = ?').run(
    JSON.stringify({
      cantrips: [],
      known: ['Mass Cure Wounds', 'Fireball'],
      prepared: ['Mass Cure Wounds', 'Fireball'],
      save_dc: 15,
      attack_bonus: 7,
    }),
    JSON.stringify({ '3': { max: 2, used: 0 }, '5': { max: 1, used: 0 } }),
    id,
  );
  return id;
}

async function ambush(enemies = 1): Promise<void> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: enemies }],
  });
  const state = getBattleState(db, campaignId)!;
  const rows = Array.from({ length: 14 }, () => '.'.repeat(60));
  const map: BattleMap = { w: 60, h: 14, rows, features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
}

const combatants = () => listCombatants(db, getBattleState(db, campaignId)!.encounter.id);

const ids = (): { pc: number; healer: number; enemy: number[] } => {
  const all = combatants();
  return {
    pc: all.find((c) => c.kind === 'pc')!.id,
    healer: all.find((c) => c.name === 'Medic')!.id,
    enemy: all.filter((c) => c.team === 'enemy').map((c) => c.id),
  };
};

const place = (id: number, x: number, y: number): void => {
  db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, id);
};

const hurt = (id: number, amount: number): void => {
  db.prepare('UPDATE combatant SET hp_current = MAX(1, hp_max - ?) WHERE id = ?').run(amount, id);
};

const hpOf = (id: number): number => combatants().find((c) => c.id === id)!.hp_current;
const maxHpOf = (id: number): number => combatants().find((c) => c.id === id)!.hp_max;

const startTurn = (id: number): void => {
  db.prepare(
    'UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?',
  ).run(id);
  db.prepare(
    "UPDATE combatant SET flags_json = json_remove(coalesce(flags_json, '{}'), '$.spent_slot_this_turn', '$.cast_levelled_spell', '$.quickened_this_turn') WHERE id = ?",
  ).run(id);
  const state = getBattleState(db, campaignId)!;
  const index = state.combatants.findIndex((c) => c.id === id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, state.encounter.id);
};

const targetIds = (cast: Awaited<ReturnType<typeof useAction>>): number[] =>
  cast.targets.map((t) => (t as { target_id: number }).target_id);

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = makeCampaign(db);
  Math.random = () => MID_D20;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('an area heal reaches allies only', () => {
  it('heals the injured ally and not the injured enemy inside the area', async () => {
    const healer = makeHealer();
    await ambush();
    const { pc, enemy } = ids();
    place(healer, 1, 5);
    place(pc, 10, 5);
    place(enemy[0]!, 12, 5);
    hurt(pc, 5);
    hurt(enemy[0]!, 3);
    const allyBefore = hpOf(pc);
    const enemyBefore = hpOf(enemy[0]!);
    startTurn(healer);

    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: healer,
      action_name: 'Mass Cure Wounds',
      spell: 'Mass Cure Wounds',
      point: { x: 11, y: 5 },
    });

    expect(targetIds(cast)).toEqual([pc]);
    expect(hpOf(pc)).toBeGreaterThan(allyBefore);
    expect(hpOf(enemy[0]!)).toBe(enemyBefore);
  });

  it('heals the caster too when the caster stands inside the area', async () => {
    const healer = makeHealer();
    await ambush();
    const { pc, enemy } = ids();
    place(healer, 10, 5);
    place(pc, 12, 5);
    place(enemy[0]!, 13, 5);
    hurt(healer, 4);
    hurt(pc, 4);
    hurt(enemy[0]!, 3);
    const healerBefore = hpOf(healer);
    const enemyBefore = hpOf(enemy[0]!);
    startTurn(healer);

    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: healer,
      action_name: 'Mass Cure Wounds',
      spell: 'Mass Cure Wounds',
      point: { x: 11, y: 5 },
    });

    expect(new Set(targetIds(cast))).toEqual(new Set([healer, pc]));
    expect(hpOf(healer)).toBeGreaterThan(healerBefore);
    expect(hpOf(enemy[0]!)).toBe(enemyBefore);
  });

  it('keeps only the six allies nearest the origin when the text caps the area', async () => {
    const healer = makeHealer();
    await ambush();
    for (let i = 0; i < 7; i++) {
      await addCombatant(db, { campaign_id: campaignId, creature: 'Commoner', name: `Ally ${i}`, team: 'party' });
    }
    const allies = combatants()
      .filter((c) => c.name.startsWith('Ally '))
      .sort((a, b) => Number(a.name.slice(5)) - Number(b.name.slice(5)));
    expect(allies).toHaveLength(7);
    allies.forEach((ally, i) => place(ally.id, 10 + i, 5));
    allies.forEach((ally) => hurt(ally.id, 2));
    place(healer, 1, 5); // 45 ft from the point, outside the 30 ft area
    startTurn(healer);

    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: healer,
      action_name: 'Mass Cure Wounds',
      spell: 'Mass Cure Wounds',
      point: { x: 10, y: 5 },
    });

    const healed = targetIds(cast);
    expect(healed).toHaveLength(6);
    // The farthest ally (x = 16) is the one left out.
    expect(healed).not.toContain(allies[6]!.id);
    for (const ally of allies.slice(0, 6)) {
      expect(hpOf(ally.id)).toBe(maxHpOf(ally.id));
    }
    expect(hpOf(allies[6]!.id)).toBeLessThan(maxHpOf(allies[6]!.id));
  });
});

describe('a damage area is unchanged', () => {
  it('still hits the enemy and the ally standing in it', async () => {
    const healer = makeHealer();
    await ambush();
    const { pc, enemy } = ids();
    place(healer, 1, 5);
    place(pc, 11, 5);
    place(enemy[0]!, 12, 5);
    startTurn(healer);

    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: healer,
      action_name: 'Fireball',
      spell: 'Fireball',
      point: { x: 11, y: 5 },
    });

    expect(new Set(targetIds(cast))).toEqual(new Set([pc, enemy[0]!]));
    for (const target of cast.targets) {
      expect((target as { damage: { applied: number } }).damage.applied).toBeGreaterThan(0);
    }
  });
});
