import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { attack, startEncounter } from '../src/combat/engine.js';
import { legalActions, sheetActions, weaponProficient } from '../src/combat/actions.js';
import { combatSheet } from '../src/combat/sheet.js';
import { findEquipment } from '../src/srd/lookup.js';
import { getBattleState, listCombatants, type BattleState } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const MID_D20 = 0.5;
const hit = { total: 25, natural: 12 };

function makeCampaign(database: Db): number {
  const id = createCampaign(database, { name: 'Weapons', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
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

const arm = (...items: string[]): void => {
  db.prepare('UPDATE character SET inventory_json = ? WHERE campaign_id = ? AND is_pc = 1').run(
    JSON.stringify(items.map((name) => ({ name, qty: 1, equipped: true }))),
    campaignId,
  );
};

async function ambush(): Promise<BattleState> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior' }],
  });
  const state = getBattleState(db, campaignId)!;
  const rows = Array.from({ length: 14 }, () => '.'.repeat(60));
  const map: BattleMap = { w: 60, h: 14, rows, features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
  return getBattleState(db, campaignId)!;
}

const ids = (): { pc: number; enemy: number } => {
  const combatants = listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
  return {
    pc: combatants.find((c) => c.kind === 'pc')!.id,
    enemy: combatants.find((c) => c.team === 'enemy')!.id,
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
    'UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?',
  ).run(id);
  giveTurn(id);
};

const pcSheet = () =>
  combatSheet(db, (db.prepare('SELECT id FROM character WHERE campaign_id = ? AND is_pc = 1').get(campaignId) as { id: number }).id);

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = makeCampaign(db);
  Math.random = () => MID_D20;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('weapon ranges and reach', () => {
  it('gives every ranged weapon its own range instead of 80/320', () => {
    arm('Longbow', 'Dart', 'Sling', 'Hand Crossbow', 'Heavy Crossbow');
    const actions = sheetActions(pcSheet());
    const ranges = Object.fromEntries(
      actions.filter((a) => a.kind === 'ranged_weapon_attack').map((a) => [a.name, [a.range_ft, a.long_range_ft]]),
    );
    expect(ranges).toMatchObject({
      Longbow: [150, 600],
      Dart: [20, 60],
      Sling: [30, 120],
      'Hand Crossbow': [30, 120],
      'Heavy Crossbow': [100, 400],
    });
  });

  it('reaches 10 ft with a glaive and 5 ft with a longsword', () => {
    arm('Glaive', 'Longsword');
    const actions = sheetActions(pcSheet());
    expect(actions.find((a) => a.name === 'Glaive')!.reach_ft).toBe(10);
    expect(actions.find((a) => a.name === 'Longsword')!.reach_ft).toBe(5);
  });

  it('throws a dagger at its thrown range as a second action', () => {
    arm('Dagger');
    const actions = sheetActions(pcSheet());
    const thrown = actions.find((a) => a.name === 'Dagger (thrown)')!;
    expect(thrown.kind).toBe('ranged_weapon_attack');
    expect([thrown.range_ft, thrown.long_range_ft]).toEqual([20, 60]);
    expect(actions.find((a) => a.name === 'Dagger')!.reach_ft).toBe(5);
  });

  it('shoots at long range with disadvantage and refuses anything beyond it', async () => {
    arm('Dart');
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy, 7, 5); // 30 ft: past the dart's 20 ft normal range, inside its 60 ft long range
    giveTurn(pc);
    const far = await attack(db, { campaign_id: campaignId, attacker_id: pc, target_id: enemy, action_name: 'Dart', roll: hit });
    expect(far.advantage).toBe('disadvantage');
    expect(far.notes.join()).toContain('long range');

    startTurn(pc);
    place(enemy, 20, 5); // 95 ft, past the long range
    await expect(
      attack(db, { campaign_id: campaignId, attacker_id: pc, target_id: enemy, action_name: 'Dart', roll: hit }),
    ).rejects.toThrow(/beyond the 60 ft long range/);
  });

  it('gives a rushed shot disadvantage when an enemy is in the archer’s face', async () => {
    arm('Shortbow');
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 5, 5);
    place(enemy, 6, 5);
    giveTurn(pc);
    const rushed = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy,
      action_name: 'Shortbow',
      roll: hit,
    });
    expect(rushed.advantage).toBe('disadvantage');
    expect(rushed.notes.join()).toContain('within 5 ft');
  });
});

describe('weapon proficiency', () => {
  it('adds the proficiency bonus only for weapons the sheet covers', () => {
    arm('Longsword');
    const sheet = pcSheet();
    expect(weaponProficient(sheet, findEquipment('Longsword')!)).toBe(true);
    // A fighter knows martial weapons; strip that and the bonus goes with it.
    db.prepare('UPDATE character SET proficiencies_json = ? WHERE campaign_id = ? AND is_pc = 1').run(
      JSON.stringify({ armor: ['Light Armor', 'Medium Armor', 'Heavy Armor', 'Shields'], weapons: ['Simple Weapons'], tools: [], languages: ['Common'] }),
      campaignId,
    );
    const unskilled = pcSheet();
    expect(weaponProficient(unskilled, findEquipment('Longsword')!)).toBe(false);
    expect(sheetActions(sheet).find((a) => a.name === 'Longsword')!.attack_bonus).toBe(5);
    expect(sheetActions(unskilled).find((a) => a.name === 'Longsword')!.attack_bonus).toBe(3);
  });

  it('matches a proficiency named in the singular or by the weapon itself', () => {
    arm('Longsword');
    db.prepare('UPDATE character SET proficiencies_json = ? WHERE campaign_id = ? AND is_pc = 1').run(
      JSON.stringify({ armor: [], weapons: ['longswords'], tools: [], languages: [] }),
      campaignId,
    );
    expect(weaponProficient(pcSheet(), findEquipment('Longsword')!)).toBe(true);
    db.prepare('UPDATE character SET proficiencies_json = ? WHERE campaign_id = ? AND is_pc = 1').run(
      JSON.stringify({ armor: [], weapons: ['Martial Weapon'], tools: [], languages: [] }),
      campaignId,
    );
    expect(weaponProficient(pcSheet(), findEquipment('Longsword')!)).toBe(true);
  });

  it('still lists a weapon it is not proficient with, and says so', async () => {
    arm('Longsword');
    db.prepare('UPDATE character SET proficiencies_json = ? WHERE campaign_id = ? AND is_pc = 1').run(
      JSON.stringify({ armor: [], weapons: ['Simple Weapons'], tools: [], languages: [] }),
      campaignId,
    );
    const state = await ambush();
    const pc = listCombatants(db, state.encounter.id).find((c) => c.kind === 'pc')!;
    const actions = legalActions(pc, pcSheet());
    const longsword = actions.find((a) => a.id === 'attack:Longsword')!;
    expect(longsword.hint).toContain('+3 to hit');
    expect(longsword.hint).toContain('Not proficient');
  });
});

describe('weapon properties', () => {
  it('swings a versatile weapon two-handed when no shield is in the way', () => {
    arm('Longsword');
    expect(sheetActions(pcSheet()).find((a) => a.name === 'Longsword')!.damage![0]!.dice).toBe('1d10+3');
    arm('Longsword', 'Shield');
    expect(sheetActions(pcSheet()).find((a) => a.name === 'Longsword')!.damage![0]!.dice).toBe('1d8+3');
  });

  it('takes the smaller die when a versatile weapon is swung one-handed', async () => {
    arm('Longsword');
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy, 2, 5);
    giveTurn(pc);
    const oneHanded = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy,
      action_name: 'Longsword',
      roll: hit,
      grip: 'one_hand',
    });
    expect(oneHanded.damage[0]!.expr).toBe('1d8+3');

    startTurn(pc);
    const twoHanded = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy,
      action_name: 'Longsword',
      roll: hit,
    });
    expect(twoHanded.damage[0]!.expr).toBe('1d10+3');

    arm('Longsword', 'Shield');
    db.prepare('UPDATE combatant SET hp_current = hp_max, alive = 1 WHERE id = ?').run(enemy);
    startTurn(pc);
    await expect(
      attack(db, {
        campaign_id: campaignId,
        attacker_id: pc,
        target_id: enemy,
        action_name: 'Longsword',
        roll: hit,
        grip: 'two_hands',
      }),
    ).rejects.toThrow(/shield in the other hand/);
  });

  it('says in the legal actions that a versatile weapon can be gripped either way', async () => {
    arm('Longsword');
    const state = await ambush();
    const pc = listCombatants(db, state.encounter.id).find((c) => c.kind === 'pc')!;
    const hint = legalActions(pc, pcSheet()).find((a) => a.id === 'attack:Longsword')!.hint;
    expect(hint).toContain('grip: "one_hand"');
  });

  it('gives disadvantage with a heavy weapon to anyone under the score it asks for', async () => {
    arm('Greatsword');
    db.prepare("UPDATE character SET abilities_json = json_set(abilities_json, '$.str.score', 10, '$.str.mod', 0) WHERE campaign_id = ? AND is_pc = 1").run(
      campaignId,
    );
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy, 2, 5);
    giveTurn(pc);
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy,
      action_name: 'Greatsword',
      roll: hit,
    });
    expect(swing.advantage).toBe('disadvantage');
    expect(swing.notes.join()).toContain('heavy');
  });
});
