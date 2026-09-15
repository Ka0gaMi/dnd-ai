import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, createCompanion } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { spellFill, startEncounter, useAction } from '../src/combat/engine.js';
import { combatSheet } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, type BattleState } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';

let db: Db;
let campaignId: number;
let wizardId: number;
const realRandom = Math.random;
const MID_D20 = 0.5;

function makeCampaign(database: Db): number {
  const id = createCampaign(database, { name: 'Spells', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
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

/** A level 5 wizard with the slots and the spell list this file needs, set straight on the row. */
function makeWizard(slots: Record<string, { max: number; used: number }> = { '1': { max: 4, used: 0 }, '2': { max: 3, used: 0 }, '3': { max: 2, used: 0 } }): number {
  const id = createCompanion(db, {
    campaign_id: campaignId,
    name: 'Zel',
    source: { class: 'Wizard', species: 'Human', background: 'Sage' },
  }).companion!.id;
  db.prepare('UPDATE character SET level = 5, spells_json = ?, spell_slots_json = ?, inventory_json = ? WHERE id = ?').run(
    JSON.stringify({
      cantrips: ['Fire Bolt'],
      known: ['Fireball', 'Hold Person', 'Cure Wounds'],
      prepared: ['Fireball', 'Hold Person'],
      save_dc: 14,
      attack_bonus: 6,
    }),
    JSON.stringify(slots),
    JSON.stringify([]),
    id,
  );
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
  const state = getBattleState(db, campaignId)!;
  const rows = Array.from({ length: 14 }, () => '.'.repeat(60));
  const map: BattleMap = { w: 60, h: 14, rows, features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
  return getBattleState(db, campaignId)!;
}

const ids = (): { pc: number; zel: number; enemy: number[] } => {
  const combatants = listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
  return {
    pc: combatants.find((c) => c.kind === 'pc')!.id,
    zel: combatants.find((c) => c.name === 'Zel')!.id,
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
    'UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?',
  ).run(id);
  giveTurn(id);
};

const slotsOf = (id: number): Record<string, { max: number; used: number }> => combatSheet(db, id).spell_slots;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = makeCampaign(db);
  Math.random = () => MID_D20;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('reading a spell off its SRD entry', () => {
  it('fills in the dice, the type, the save, the DC, the area, the range and the duration', () => {
    wizardId = makeWizard();
    const sheet = combatSheet(db, wizardId);
    const fireball = spellFill('Fireball', sheet)!;
    expect(fireball).toMatchObject({
      level: 3,
      slot_level: 3,
      damage_expr: '8d6',
      damage_type: 'fire',
      save_ability: 'dex',
      save_dc: 14,
      half_on_save: true,
      concentration: false,
      range_ft: 150,
    });
    expect(fireball.shape).toEqual({ kind: 'sphere', size_ft: 20 });

    const hold = spellFill('Hold Person', sheet)!;
    expect(hold).toMatchObject({ save_ability: 'wis', concentration: true, duration_rounds: 10, range_ft: 60 });

    const cure = spellFill('Cure Wounds', sheet)!;
    expect(cure.heal_expr).toBe('2d8');
    expect(cure.damage_expr).toBeUndefined();
  });

  it('upcasts the plain "+1dX per slot level" pattern and says when it cannot', () => {
    wizardId = makeWizard();
    const sheet = combatSheet(db, wizardId);
    expect(spellFill('Fireball', sheet, 5)!.damage_expr).toBe('10d6');
    expect(spellFill('Fireball', sheet, 5)!.notes.join()).toContain('upcast to level 5: +2d6');

    // Scorching Ray's rays each take their own attack roll, so the engine still leaves that to the DM.
    const rays = spellFill('Scorching Ray', sheet, 3)!;
    expect(rays.damage_expr).toBe('2d6');
    expect(rays.notes.join()).toContain('does not scale that');
  });

  it('fires every Magic Missile dart at the target: three at level 1, one more per slot level above', () => {
    wizardId = makeWizard();
    const sheet = combatSheet(db, wizardId);
    const missile = spellFill('Magic Missile', sheet)!;
    expect(missile.damage_expr).toBe('3d4 + 3');
    expect(missile.notes.join()).toContain('3 darts x (1d4 + 1)');
    expect(spellFill('Magic Missile', sheet, 2)!.damage_expr).toBe('4d4 + 4');
    expect(spellFill('Magic Missile', sheet, 3)!.damage_expr).toBe('5d4 + 5');
  });

  it('grows a cantrip with the caster level at the 2024 tiers', () => {
    wizardId = makeWizard();
    expect(spellFill('Fire Bolt', combatSheet(db, wizardId))!.damage_expr).toBe('2d10'); // level 5
    db.prepare('UPDATE character SET level = 11 WHERE id = ?').run(wizardId);
    expect(spellFill('Fire Bolt', combatSheet(db, wizardId))!.damage_expr).toBe('3d10');
    db.prepare('UPDATE character SET level = 1 WHERE id = ?').run(wizardId);
    expect(spellFill('Fire Bolt', combatSheet(db, wizardId))!.damage_expr).toBe('1d10');
    expect(spellFill('Fire Bolt', combatSheet(db, wizardId))!.slot_level).toBeNull();
  });

  it('reads the casting time off the entry and says what it costs', () => {
    wizardId = makeWizard();
    const sheet = combatSheet(db, wizardId);
    expect(spellFill('Fireball', sheet)).toMatchObject({ casting_time: 'action', economy: 'action' });
    expect(spellFill('Healing Word', sheet)).toMatchObject({ casting_time: 'bonus-action', economy: 'bonus_action' });
    expect(spellFill('Shield', sheet)).toMatchObject({ casting_time: 'reaction', economy: 'reaction' });
    expect(spellFill('Find Familiar', sheet)).toMatchObject({ casting_time: '1hour', economy: 'long' });
  });

  it('refuses a slot below the spell level', () => {
    wizardId = makeWizard();
    expect(() => spellFill('Fireball', combatSheet(db, wizardId), 2)).toThrow(/cannot be cast with a level 2 slot/);
  });
});

describe('casting through use_action', () => {
  it('spends the slot, fills the parameters in and logs both', async () => {
    wizardId = makeWizard();
    await ambush(2);
    const { zel, enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 6, 5);
    place(enemy[1]!, 7, 5);
    giveTurn(zel);

    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: zel,
      action_name: 'Fireball',
      spell: 'Fireball',
      point: { x: 6, y: 5 },
    });
    expect(slotsOf(wizardId)['3']).toEqual({ max: 2, used: 1 });
    const slotEntry = cast.log.find((entry) => entry.kind === 'spell_slot')!;
    expect(slotEntry.text).toContain('spends a level 3 slot on Fireball (1 left');
    expect(cast.targets).toHaveLength(2); // the 20 ft sphere came from the entry
    const first = cast.targets[0] as { save: { ability: string; dc: number }; damage: { applied: number } };
    expect(first.save).toMatchObject({ ability: 'dex', dc: 14 });
    expect(first.damage.applied).toBeGreaterThan(0);
  });

  it('upcasts with slot_level and takes the slot it was cast with', async () => {
    wizardId = makeWizard({ '3': { max: 1, used: 0 }, '4': { max: 1, used: 0 } });
    await ambush();
    const { zel, enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 3, 5);
    giveTurn(zel);

    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: zel,
      action_name: 'Fireball',
      spell: 'Fireball',
      slot_level: 4,
      target_id: enemy[0]!,
    });
    expect(slotsOf(wizardId)['4']).toEqual({ max: 1, used: 1 });
    expect(slotsOf(wizardId)['3']).toEqual({ max: 1, used: 0 });
    const spell = (cast as unknown as { spell: { damage_expr: string } }).spell;
    expect(spell.damage_expr).toBe('9d6');
  });

  it('casts Magic Missile through use_action: four darts at slot 2, and only that slot spent', async () => {
    wizardId = makeWizard();
    db.prepare('UPDATE character SET spells_json = ? WHERE id = ?').run(
      JSON.stringify({
        cantrips: ['Fire Bolt'],
        known: ['Magic Missile'],
        prepared: ['Magic Missile'],
        save_dc: 14,
        attack_bonus: 6,
      }),
      wizardId,
    );
    await ambush();
    const { zel, enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 4, 5);
    giveTurn(zel);

    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: zel,
      action_name: 'Magic Missile',
      spell: 'Magic Missile',
      slot_level: 2,
      target_id: enemy[0]!,
    });
    expect((cast as unknown as { spell: { damage_expr: string } }).spell.damage_expr).toBe('4d4 + 4');
    expect(slotsOf(wizardId)['2']).toEqual({ max: 3, used: 1 });
    expect(slotsOf(wizardId)['1']).toEqual({ max: 4, used: 0 });
    const first = cast.targets[0] as { damage: { rolled: number } };
    expect(first.damage.rolled).toBeGreaterThanOrEqual(8);
    expect(first.damage.rolled).toBeLessThanOrEqual(20);
  });

  it('refuses to cast with no slot left and names what is still there', async () => {
    wizardId = makeWizard({ '1': { max: 2, used: 1 }, '3': { max: 1, used: 1 } });
    await ambush();
    const { zel, enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 3, 5);
    giveTurn(zel);
    await expect(
      useAction(db, {
        campaign_id: campaignId,
        actor_id: zel,
        action_name: 'Fireball',
        spell: 'Fireball',
        target_id: enemy[0]!,
      }),
    ).rejects.toThrow(/no level 3 spell slot left for Fireball\. Slots remaining: level 1 \(1 left\)/);
  });

  it('spends nothing on a cantrip and rolls its spell attack', async () => {
    wizardId = makeWizard();
    await ambush();
    const { zel, enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 6, 5);
    giveTurn(zel);

    const bolt = await useAction(db, {
      campaign_id: campaignId,
      actor_id: zel,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: enemy[0]!,
      roll: { total: 22, natural: 16 },
    });
    expect(slotsOf(wizardId)['1']).toEqual({ max: 4, used: 0 });
    expect(bolt.log.some((entry) => entry.kind === 'spell_slot')).toBe(false);
    const first = bolt.targets[0] as { attack: { hit: boolean; ac: number } | null; damage: { rolled: number } | null };
    expect(first.attack!.hit).toBe(true);
    expect(first.damage!.rolled).toBeGreaterThan(0);
  });

  it('does no damage when the spell attack misses', async () => {
    wizardId = makeWizard();
    await ambush();
    const { zel, enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 6, 5);
    giveTurn(zel);
    const bolt = await useAction(db, {
      campaign_id: campaignId,
      actor_id: zel,
      action_name: 'Fire Bolt',
      spell: 'Fire Bolt',
      target_id: enemy[0]!,
      roll: { total: 4, natural: 3 },
    });
    const first = bolt.targets[0] as { attack: { hit: boolean }; damage: unknown };
    expect(first.attack.hit).toBe(false);
    expect(first.damage).toBeNull();
  });

  it('refuses a target beyond the spell range', async () => {
    wizardId = makeWizard();
    await ambush();
    const { zel, enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 45, 5); // 220 ft, past Fireball's 150 ft
    giveTurn(zel);
    await expect(
      useAction(db, {
        campaign_id: campaignId,
        actor_id: zel,
        action_name: 'Fireball',
        spell: 'Fireball',
        target_id: enemy[0]!,
      }),
    ).rejects.toThrow(/reaches 150 ft/);
  });

  it('ends the concentration it was holding when a second concentration spell goes up', async () => {
    wizardId = makeWizard();
    await ambush(2);
    const { zel, enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 3, 5);
    place(enemy[1]!, 4, 5);
    giveTurn(zel);
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: zel,
      action_name: 'Hold Person',
      spell: 'Hold Person',
      target_id: enemy[0]!,
      effect: { name: 'paralyzed', kind: 'condition', tick: 'start' },
    });
    expect(getBattleState(db, campaignId)!.effects).toHaveLength(1);
    const held = getBattleState(db, campaignId)!.combatants.find((c) => c.id === enemy[0])!;
    expect(held.conditions).toContain('paralyzed');

    startTurn(zel);
    const second = await useAction(db, {
      campaign_id: campaignId,
      actor_id: zel,
      action_name: 'Hold Person',
      spell: 'Hold Person',
      target_id: enemy[1]!,
      effect: { name: 'paralyzed', kind: 'condition', tick: 'start' },
    });
    expect(second.log.some((entry) => entry.kind === 'effect_end')).toBe(true);
    const state = getBattleState(db, campaignId)!;
    expect(state.effects).toHaveLength(1);
    expect(state.combatants.find((c) => c.id === enemy[0])!.conditions).not.toContain('paralyzed');
    expect(state.combatants.find((c) => c.id === enemy[1])!.conditions).toContain('paralyzed');
  });
});

describe('what a casting time costs the turn', () => {
  const combatant = (id: number) => listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === id)!;

  it('spends the bonus action on a bonus-action spell and leaves the Action alone', async () => {
    wizardId = makeWizard();
    await ambush();
    const { zel, enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 3, 5);
    startTurn(zel);
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: zel,
      action_name: 'Healing Word',
      spell: 'Healing Word',
      target_id: zel,
    });
    expect(combatant(zel).bonus_used).toBe(true);
    expect(combatant(zel).action_used).toBe(false);
    // One bonus action a turn, and the slot is spent before the second is refused.
    await expect(
      useAction(db, {
        campaign_id: campaignId,
        actor_id: zel,
        action_name: 'Healing Word',
        spell: 'Healing Word',
        target_id: zel,
      }),
    ).rejects.toThrow(/already used their bonus action/i);
  });

  it('needs out_of_turn for a reaction spell and refuses one that takes an hour', async () => {
    wizardId = makeWizard();
    await ambush();
    const { zel, enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 3, 5);
    startTurn(zel);
    await expect(
      useAction(db, { campaign_id: campaignId, actor_id: zel, action_name: 'Shield', spell: 'Shield' }),
    ).rejects.toThrow(/cast as a Reaction/i);
    await expect(
      useAction(db, { campaign_id: campaignId, actor_id: zel, action_name: 'Find Familiar', spell: 'Find Familiar' }),
    ).rejects.toThrow(/not in a fight/i);
    // Neither refusal cost a slot or the turn.
    expect(slotsOf(wizardId)['1']).toEqual({ max: 4, used: 0 });
    expect(combatant(zel).action_used).toBe(false);
  });
});

describe('surprise', () => {
  it('rolls initiative with disadvantage for whoever the ambush caught', async () => {
    const pc = (db.prepare('SELECT id FROM character WHERE campaign_id = ? AND is_pc = 1').get(campaignId) as { id: number })
      .id;
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior' }],
      surprised_ids: [pc],
    });
    const state = getBattleState(db, campaignId)!;
    const rolled = state.log_tail.filter((entry) => entry.kind === 'initiative');
    const borg = rolled.find((entry) => entry.text.startsWith('Borg'))!;
    expect(borg.text).toContain('surprised, so with disadvantage');
    expect((borg.payload as { surprised: boolean }).surprised).toBe(true);
    const goblin = rolled.find((entry) => entry.text.startsWith('Goblin'))!;
    expect((goblin.payload as { surprised: boolean }).surprised).toBe(false);
  });
});
