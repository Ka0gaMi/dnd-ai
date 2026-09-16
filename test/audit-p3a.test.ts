// The three damage-maths defects of audit package P3a: Resistance and Vulnerability on one type,
// one damage roll for a save-or-area spell, and one concentration save per instance of damage.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, createCompanion } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { attack, damageCombatant, startEncounter, useAction } from '../src/combat/engine.js';
import { activeEncounter, getBattleState, listCombatants, type Combatant } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const MID_D20 = 0.5;

function makeCampaign(database: Db): number {
  const id = createCampaign(database, { name: 'P3a', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
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
  // Everyone stands in reach of everyone else, so nothing is refused for distance.
  let x = 3;
  for (const c of listCombatants(db, state.encounter.id)) {
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, 5, c.id);
    x += 1;
  }
}

const encounterId = (): number => getBattleState(db, campaignId)!.encounter.id;
const combatants = (): Combatant[] => listCombatants(db, encounterId());
const foe = (n = 0): Combatant => combatants().filter((c) => c.team === 'enemy')[n]!;

const place = (id: number, x: number, y: number): void => {
  db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, id);
};

const startTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?').run(id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === id),
    state.encounter.id,
  );
};

const arm = (id: number, ...items: string[]): void => {
  db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(
    JSON.stringify(items.map((name) => ({ name, qty: 1, equipped: true }))),
    id,
  );
};

/** A level 5 wizard with the slots and the spell list this file needs, set straight on the row. */
function makeWizard(): number {
  const id = createCompanion(db, {
    campaign_id: campaignId,
    name: 'Zel',
    source: { class: 'Wizard', species: 'Human', background: 'Sage' },
  }).companion!.id;
  db.prepare('UPDATE character SET level = 5, spells_json = ?, spell_slots_json = ?, inventory_json = ? WHERE id = ?').run(
    JSON.stringify({ cantrips: [], known: ['Fireball'], prepared: ['Fireball'], save_dc: 14, attack_bonus: 6 }),
    JSON.stringify({ '3': { max: 2, used: 0 } }),
    JSON.stringify([]),
    id,
  );
  return id;
}

interface FeatureEffect {
  feature: string;
  damage?: number;
}
const featuresOf = (result: unknown): FeatureEffect[] => (result as { features?: FeatureEffect[] }).features ?? [];

/** A deterministic but varying RNG, so two rolls of the same dice come out different. */
function varyRolls(): void {
  let seed = 1;
  Math.random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = makeCampaign(db);
  Math.random = () => MID_D20;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('Resistance and Vulnerability on the same damage type', () => {
  it('halves and rounds down first, then doubles, when a creature has both', async () => {
    await ambush();
    const goblin = foe();
    db.prepare('UPDATE combatant SET stat_block_json = ? WHERE id = ?').run(
      JSON.stringify({ ...goblin.stat_block!, damage_resistances: 'fire', damage_vulnerabilities: 'fire' }),
      goblin.id,
    );
    const encounter = activeEncounter(db, campaignId)!;

    const odd = damageCombatant(db, encounter, combatants().find((c) => c.id === goblin.id)!, { amount: 15, type: 'fire' });
    expect(odd.resistance).toBe('resistant and vulnerable');
    // floor(15 / 2) = 7, then doubled: 14, not the 15 a single multiplier would leave.
    expect(odd.applied).toBe(14);

    const even = damageCombatant(db, encounter, combatants().find((c) => c.id === goblin.id)!, { amount: 10, type: 'fire' });
    expect(even.applied).toBe(10);
  });

  it('still halves for Resistance alone and doubles for Vulnerability alone', async () => {
    await ambush(2);
    db.prepare('UPDATE combatant SET stat_block_json = ? WHERE id = ?').run(
      JSON.stringify({ ...foe(0).stat_block!, damage_resistances: 'fire' }),
      foe(0).id,
    );
    db.prepare('UPDATE combatant SET stat_block_json = ? WHERE id = ?').run(
      JSON.stringify({ ...foe(1).stat_block!, damage_vulnerabilities: 'fire' }),
      foe(1).id,
    );
    const encounter = activeEncounter(db, campaignId)!;

    const halved = damageCombatant(db, encounter, combatants().find((c) => c.id === foe(0).id)!, { amount: 15, type: 'fire' });
    expect(halved.resistance).toBe('resistant');
    expect(halved.applied).toBe(7);

    const doubled = damageCombatant(db, encounter, combatants().find((c) => c.id === foe(1).id)!, { amount: 15, type: 'fire' });
    expect(doubled.resistance).toBe('vulnerable');
    expect(doubled.applied).toBe(30);
  });
});

describe('one damage roll for every target of a save spell', () => {
  it('rolls Fireball once and reads the same numbers for each creature', async () => {
    const zel = makeWizard();
    await ambush(2);
    const caster = combatants().find((c) => c.character_id === zel)!.id;
    place(combatants().find((c) => c.kind === 'pc')!.id, 1, 14);
    place(caster, 1, 5);
    place(foe(0).id, 30, 5);
    place(foe(1).id, 31, 5);
    startTurn(caster);
    varyRolls();

    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: caster,
      action_name: 'Fireball',
      spell: 'Fireball',
      point: { x: 30, y: 5 },
      // The two saves are forced apart, so one target halves and the other does not.
      rolls: { [String(foe(0).id)]: { total: 20, natural: 18 }, [String(foe(1).id)]: { total: 2, natural: 2 } },
    });
    expect(cast.targets).toHaveLength(2);

    const damage = cast.log.filter((entry) => entry.kind === 'damage');
    expect(damage).toHaveLength(2);
    const rolls = damage.map((entry) => /\(([^)]*)\) - \d+\/\d+ HP\.$/.exec(entry.text)?.[1]);
    expect(rolls.every((roll) => roll !== undefined)).toBe(true);
    // Independent rolls gave different totals; one shared roll reads the same on every target.
    expect(new Set(rolls).size).toBe(1);

    const results = cast.targets as Array<{ save: { success: boolean }; damage: { rolled: number; applied: number } }>;
    const failed = results.find((entry) => !entry.save.success)!;
    const saved = results.find((entry) => entry.save.success)!;
    const shared = failed.damage.rolled;
    // Both read the same roll, but each target's own save still decides whether it halves.
    expect(saved.damage.applied).toBe(Math.floor(shared / 2));
    expect(failed.damage.applied).toBe(shared);
  });
});

describe('one concentration save per instance of damage', () => {
  it('makes a single save at DC from weapon plus Sneak Attack, not one save per fragment', async () => {
    const sly = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Sly',
      source: { class: 'Rogue', species: 'Human', background: 'Soldier' },
    }).companion!.id;
    arm(sly, 'Rapier');
    // A Dexterity a level 1 sheet would not roll, so the hit clears the DC 10 floor and the summed
    // damage is what the save is measured against.
    const row = db.prepare('SELECT abilities_json FROM character WHERE id = ?').get(sly) as { abilities_json: string };
    const abilities = JSON.parse(row.abilities_json) as Record<string, { score: number; mod: number }>;
    abilities.dex = { score: 50, mod: 20 };
    db.prepare('UPDATE character SET abilities_json = ? WHERE id = ?').run(JSON.stringify(abilities), sly);

    await ambush();
    const striker = combatants().find((c) => c.character_id === sly)!;
    const goblin = foe();
    db.prepare('UPDATE combatant SET hp_max = 200, hp_current = 200, concentration_json = ? WHERE id = ?').run(
      JSON.stringify({ name: 'Hex' }),
      goblin.id,
    );
    startTurn(striker.id);
    Math.random = () => 0.9; // damage dice up near their faces, so the sum is well clear of the floor

    const hit = await attack(db, {
      campaign_id: campaignId,
      attacker_id: striker.id,
      target_id: goblin.id,
      action_name: 'Rapier',
      roll: { total: 30, natural: 12 },
      advantage: 'advantage',
    });
    const sneak = featuresOf(hit).find((feature) => feature.feature === 'Sneak Attack')?.damage ?? 0;
    expect(sneak).toBeGreaterThan(0);
    const total = hit.damage.reduce((sum, part) => sum + part.applied, 0) + sneak;
    expect(total).toBeGreaterThan(20); // above the floor, so the DC is the sum's own

    const saves = hit.log.filter((entry) => entry.kind === 'concentration');
    expect(saves).toHaveLength(1);
    const payload = saves[0]!.payload as { save: { dc: number } };
    expect(payload.save.dc).toBe(Math.max(10, Math.floor(total / 2)));
  });
});
