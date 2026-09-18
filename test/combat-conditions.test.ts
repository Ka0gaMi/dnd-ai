import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import { createCharacter, createCompanion, deathSave, setExhaustion } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import {
  advanceTurn,
  applyEffect,
  attack,
  damageCombatant,
  endEncounter,
  moveToken,
  setCombatCondition,
  startEncounter,
  useAction,
} from '../src/combat/engine.js';
import { legalActions } from '../src/combat/actions.js';
import { CONDITIONS, exhaustionPenalty, exhaustionSpeedPenalty, isIncapacitated } from '../src/combat/conditions.js';
import { combatSheet } from '../src/combat/sheet.js';
import {
  activeEncounter,
  getBattleState,
  getCombatant,
  listCombatants,
  type BattleState,
} from '../src/combat/state.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const MID_D20 = 0.5;

function makeCampaign(database: Db): number {
  const id = createCampaign(database, { name: 'Conditions', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
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

/** Replaces the generated map with a hand-built one, so what can be seen is exactly known. */
const setMap = (rows: string[]): void => {
  const encounterId = getBattleState(db, campaignId)!.encounter.id;
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(
    JSON.stringify({ w: rows[0]!.length, h: rows.length, rows, features: [] }),
    encounterId,
  );
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

describe('the condition table', () => {
  it('carries the 2024 conditions with their mechanics', () => {
    expect(Object.keys(CONDITIONS).sort()).toEqual([
      'blinded', 'charmed', 'deafened', 'frightened', 'grappled', 'incapacitated', 'invisible',
      'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious',
    ]);
    expect(CONDITIONS.paralyzed).toMatchObject({ incapacitated: true, speed_zero: true, crit_within_5ft: true });
    expect(CONDITIONS.paralyzed!.auto_fail_saves).toEqual(['str', 'dex']);
    expect(isIncapacitated(['poisoned', 'stunned'])).toBe(true);
    expect(isIncapacitated(['poisoned'])).toBe(false);
  });

  it('prices exhaustion the 2024 way: -2 a level on the die and -5 ft of speed', () => {
    expect(exhaustionPenalty(3)).toBe(-6);
    expect(exhaustionPenalty(0)).toBe(0);
    expect(exhaustionSpeedPenalty(2)).toBe(10);
  });
});

describe('conditions on the attack roll', () => {
  it('gives advantage against a prone target within 5 ft and disadvantage from further away', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: enemy[0]!, condition: 'prone', active: true });

    giveTurn(pc);
    const close = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Unarmed Strike',
      roll: hit,
    });
    expect(close.advantage).toBe('advantage');
    expect(close.notes.join()).toContain('is prone');

    startTurn(pc);
    place(enemy[0]!, 6, 5);
    const far = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Shortbow',
      roll: hit,
    });
    expect(far.advantage).toBe('disadvantage');
  });

  it('turns a hit on a paralyzed target within 5 ft into a critical hit', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: enemy[0]!, condition: 'paralyzed', active: true });

    giveTurn(pc);
    const struck = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Unarmed Strike',
      roll: hit,
    });
    expect(struck.hit).toBe(true);
    expect(struck.critical).toBe(true);
  });

  it('gives a poisoned attacker disadvantage and a blinded one disadvantage both ways', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'poisoned', active: true });

    giveTurn(pc);
    const poisoned = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Unarmed Strike',
      roll: hit,
    });
    expect(poisoned.advantage).toBe('disadvantage');

    // Blinded on both sides: the attacker's disadvantage and the target's advantage cancel out.
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'poisoned', active: false });
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: enemy[0]!, condition: 'blinded', active: true });
    startTurn(pc);
    const blinded = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Unarmed Strike',
      roll: hit,
    });
    expect(blinded.advantage).toBe('advantage');
    expect(blinded.notes.join()).toContain('blinded');
  });

  it('fails a paralyzed creature’s DEX save without rolling it', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: enemy[0]!, condition: 'paralyzed', active: true });

    giveTurn(pc);
    const blast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Scorching Blast',
      target_id: enemy[0]!,
      damage_expr: '2',
      damage_type: 'fire',
      save_ability: 'dex',
      save_dc: 5,
      half_on_save: true,
    });
    const first = blast.targets[0] as { save: { success: boolean; auto_fail: string | null } };
    expect(first.save.success).toBe(false);
    expect(first.save.auto_fail).toContain('paralyzed');
  });
});

describe('conditions on movement and the turn', () => {
  it('refuses to move a grappled or restrained combatant', async () => {
    await ambush();
    const { pc } = ids();
    place(pc, 1, 5);
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'restrained', active: true });
    giveTurn(pc);
    expect(() => moveToken(db, { campaign_id: campaignId, combatant_id: pc, to: { x: 3, y: 5 } })).toThrow(
      /speed 0 while restrained/,
    );
    expect(combatantOf(pc).movement_left).toBe(0);
  });

  it('offers standing up to a prone combatant and charges half its speed for it', async () => {
    await ambush();
    const { pc } = ids();
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'prone', active: true });
    giveTurn(pc);
    const combatants = listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
    const prone = combatants.find((c) => c.id === pc)!;
    const actions = legalActions(prone, combatSheet(db, prone.character_id!));
    expect(actions.map((a) => a.id)).toContain('stand');

    const stood = (await useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'stand' })) as unknown as {
      movement_left: number;
    };
    expect(stood.movement_left).toBe(15); // 30 ft speed, half of it spent standing
    expect(combatantOf(pc).conditions).not.toContain('prone');
  });

  it('stands the party up when the fight ends, so nobody walks away prone', async () => {
    await ambush();
    const { pc } = ids();
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'prone', active: true });
    expect(getCharacterSheet(db, campaignId)!.conditions).toContain('prone');

    const ended = endEncounter(db, { campaign_id: campaignId, outcome: 'victory' });
    expect(ended.stood_up).toEqual(['Borg']);
    expect(getCharacterSheet(db, campaignId)!.conditions).not.toContain('prone');
  });

  it('leaves an incapacitated combatant no actions at all', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'stunned', active: true });
    giveTurn(pc);

    const combatants = listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
    const stunned = combatants.find((c) => c.id === pc)!;
    const actions = legalActions(stunned, combatSheet(db, stunned.character_id!));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.id).toBe('incapacitated');

    await expect(
      attack(db, { campaign_id: campaignId, attacker_id: pc, target_id: enemy[0]!, action_name: 'Unarmed Strike' }),
    ).rejects.toThrow(/stunned and takes no action/);
    await expect(
      useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'dodge' }),
    ).rejects.toThrow(/takes no action/);
  });

  it('ends concentration when the caster is stunned', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    giveTurn(pc);
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Hold Person',
      target_id: enemy[0]!,
      concentration: true,
      effect: { name: 'restrained', kind: 'condition', tick: 'start', ends: 'concentration' },
    });
    expect(getBattleState(db, campaignId)!.effects).toHaveLength(1);

    setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'stunned', active: true });
    expect(combatantOf(pc).concentration).toBeNull();
    expect(getBattleState(db, campaignId)!.effects).toHaveLength(0);
  });
});

describe('exhaustion', () => {
  it('takes 2 off every d20 and 5 ft of speed per level', async () => {
    db.prepare('UPDATE character SET exhaustion = 2 WHERE campaign_id = ? AND is_pc = 1').run(campaignId);
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);

    const sheet = combatSheet(db, listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === pc)!.character_id!);
    expect(sheet.speed).toBe(20);
    expect(combatantOf(pc).speed).toBe(20);

    giveTurn(pc);
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Unarmed Strike',
    });
    expect(swing.notes.join()).toContain('exhaustion 2 (-4 to the roll)');
    const payload = swing.log[0]!.payload as { roll: { expr: string } };
    expect(payload.roll.expr).toContain('+1'); // +5 to hit, less 4 for exhaustion
  });
});

describe('armour worn without proficiency', () => {
  /** A wizard in chain mail: the sheet says so, and the engine makes them pay for it. */
  function armouredWizard(): number {
    const id = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Zel',
      source: { class: 'Wizard', species: 'Human', background: 'Sage' },
    }).companion!.id;
    db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(
      JSON.stringify([{ name: 'Chain Mail', qty: 1, equipped: true }]),
      id,
    );
    return id;
  }

  it('flags the sheet, the battle state and the legal actions', async () => {
    const wizard = armouredWizard();
    const state = await ambush();
    const sheet = combatSheet(db, wizard);
    expect(sheet.armor_penalty.penalty).toBe(true);
    expect(sheet.armor_penalty.reason).toContain('Chain Mail (Heavy Armor)');

    const zel = state.combatants.find((c) => c.character_id === wizard)!;
    expect(zel.armor_penalty).toBe(true);
    const actions = legalActions(listCombatants(db, state.encounter.id).find((c) => c.id === zel.id)!, sheet);
    expect(actions.map((a) => a.id)).toContain('no_spells');
    expect(actions.some((a) => a.id.startsWith('cast:'))).toBe(false);
  });

  it('gives disadvantage on a STR or DEX roll and refuses to cast', async () => {
    const wizard = armouredWizard();
    const state = await ambush();
    const { enemy } = ids();
    const zel = state.combatants.find((c) => c.character_id === wizard)!.id;
    place(zel, 1, 5);
    place(enemy[0]!, 2, 5);
    giveTurn(zel);

    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: zel,
      target_id: enemy[0]!,
      action_name: 'Unarmed Strike',
      roll: hit,
    });
    expect(swing.advantage).toBe('disadvantage');
    expect(swing.notes.join()).toContain('not proficient with Chain Mail');

    startTurn(zel);
    await expect(
      useAction(db, { campaign_id: campaignId, actor_id: zel, action_name: 'Fire Bolt', spell: 'Fire Bolt', target_id: enemy[0]! }),
    ).rejects.toThrow(/cannot cast Fire Bolt/);
  });
});

describe('condition immunities and damage types', () => {
  it('refuses a condition the creature is immune to', async () => {
    await ambush();
    const { enemy } = ids();
    const encounterId = getBattleState(db, campaignId)!.encounter.id;
    db.prepare('UPDATE combatant SET stat_block_json = json_set(stat_block_json, \'$.condition_immunities\', ?) WHERE id = ?').run(
      'poisoned, charmed',
      enemy[0]!,
    );
    expect(() =>
      setCombatCondition(db, { campaign_id: campaignId, combatant_id: enemy[0]!, condition: 'poisoned', active: true }),
    ).toThrow(/immune to the poisoned condition/);
    expect(() =>
      applyEffect(db, {
        campaign_id: campaignId,
        target_id: enemy[0]!,
        name: 'charmed',
        kind: 'condition',
        tick: 'end',
        ends: 'manual',
      }),
    ).toThrow(/immune to the charmed condition/);
    expect(listCombatants(db, encounterId).find((c) => c.id === enemy[0])!.conditions).toEqual([]);
  });

  it('warns when the DM invents a damage type instead of silently applying it', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    giveTurn(pc);
    const zap = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Weird Blast',
      target_id: enemy[0]!,
      damage_expr: '2',
      damage_type: 'sonic',
    });
    const note = zap.log.find((entry) => entry.kind === 'note')!;
    expect(note.text).toContain('"sonic" is not an SRD damage type');
  });

  it('knocks a creature out instead of killing it when the blow is pulled', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    db.prepare('UPDATE combatant SET hp_current = 1 WHERE id = ?').run(enemy[0]!);
    giveTurn(pc);
    const pulled = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Unarmed Strike',
      roll: hit,
      knock_out: true,
    });
    expect(pulled.hit).toBe(true);
    const goblin = combatantOf(enemy[0]!);
    // SRD 5.2.1: the pulled blow leaves it on 1 hit point, Unconscious.
    expect(goblin.hp_current).toBe(1);
    expect(goblin.alive).toBe(true);
    expect(goblin.conditions).toContain('unconscious');
  });
});

describe('conditions that depend on what can be seen', () => {
  it('only frightens while the source is in sight', async () => {
    await ambush(2);
    const { pc, enemy } = ids();
    setMap([
      '..............',
      '..............',
      '..............',
      '..............',
      '..............',
      '..............',
    ]);
    place(pc, 1, 5);
    place(enemy[0]!, 3, 5);
    place(enemy[1]!, 1, 4);
    applyEffect(db, {
      campaign_id: campaignId,
      target_id: pc,
      source_id: enemy[0]!,
      name: 'frightened',
      kind: 'condition',
      tick: 'end',
      ends: 'manual',
    });
    giveTurn(pc);
    const seen = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Shortbow',
      roll: hit,
    });
    expect(seen.advantage).toBe('disadvantage');
    expect(seen.notes.join()).toContain('frightened');

    // A wall hides the source: the fear is still on the sheet, but it no longer moves the die.
    setMap([
      '..............',
      '..............',
      '##############',
      '..............',
      '..............',
      '..............',
    ]);
    place(pc, 2, 0);
    place(enemy[0]!, 2, 4);
    place(enemy[1]!, 3, 0);
    startTurn(pc);
    const unseen = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[1]!,
      action_name: 'Unarmed Strike',
      roll: hit,
    });
    expect(unseen.advantage).toBe('none');
  });

  it('gives an invisible attacker advantage and its attacker disadvantage', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'invisible', active: true });
    giveTurn(pc);
    const unseen = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Unarmed Strike',
      roll: hit,
    });
    expect(unseen.advantage).toBe('advantage');

    startTurn(enemy[0]!);
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: enemy[0]!,
      target_id: pc,
      action_name: 'Scimitar',
      roll: { total: 5, natural: 5 },
    });
    expect(swing.advantage).toBe('disadvantage');
  });

  it('holds a restrained creature still and spoils its attacks', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: enemy[0]!, condition: 'restrained', active: true });
    giveTurn(enemy[0]!);
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: enemy[0]!,
      target_id: pc,
      action_name: 'Scimitar',
      roll: { total: 5, natural: 5 },
    });
    expect(swing.advantage).toBe('disadvantage');
    expect(swing.notes.join()).toContain('restrained');
    expect(combatantOf(enemy[0]!).movement_left).toBe(0);

    startTurn(pc);
    const back = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Unarmed Strike',
      roll: hit,
    });
    expect(back.advantage).toBe('advantage');
  });
});

describe('what the character sheet lends the engine', () => {
  it('halves damage of a type a feature resists', async () => {
    const character = (db.prepare('SELECT id FROM character WHERE campaign_id = ? AND is_pc = 1').get(campaignId) as {
      id: number;
    }).id;
    const features = JSON.parse(
      (db.prepare('SELECT features_json AS f FROM character WHERE id = ?').get(character) as { f: string }).f,
    ) as Array<Record<string, unknown>>;
    features.push({ name: 'Draconic Ancestry', mechanics: { resistances: ['fire'] } });
    db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(JSON.stringify(features), character);
    expect(combatSheet(db, character).resistances).toContain('fire');

    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    giveTurn(enemy[0]!);
    const burn = await useAction(db, {
      campaign_id: campaignId,
      actor_id: enemy[0]!,
      action_name: 'Firebomb',
      target_id: pc,
      damage_expr: '8',
      damage_type: 'fire',
    });
    const first = burn.targets[0] as { damage: { applied: number; resistance: string | null } };
    expect(first.damage).toMatchObject({ applied: 4, resistance: 'resistant' });
  });

  it('leaves a stabilised character alone instead of rolling another death save', async () => {
    await ambush();
    const { pc } = ids();
    const character = (db.prepare('SELECT id FROM character WHERE campaign_id = ? AND is_pc = 1').get(campaignId) as {
      id: number;
    }).id;
    db.prepare('UPDATE character SET hp_current = 0, stable = 1 WHERE id = ?').run(character);
    db.prepare('UPDATE combatant SET hp_current = 0 WHERE id = ?').run(pc);
    giveTurn(pc);

    const turn = await advanceTurn(db, campaignId);
    const next = await advanceTurn(db, campaignId);
    const rolls = [...turn.log, ...next.log].filter((entry) => entry.kind === 'death_save');
    expect(rolls).toHaveLength(0);
  });
});

describe('a dead PC reads Dead, not Unconscious or Prone', () => {
  /** The fight on the road with the PC pinned to a known 10 maximum, so the massive-damage line is exact. */
  async function pinchedFight(): Promise<{ pc: number }> {
    await ambush();
    const { pc } = ids();
    db.prepare('UPDATE character SET hp_current = 10, hp_max = 10 WHERE campaign_id = ? AND is_pc = 1').run(campaignId);
    db.prepare('UPDATE combatant SET hp_current = 10, hp_max = 10 WHERE id = ?').run(pc);
    return { pc };
  }

  const rowOf = (id: number) => {
    const encounter = activeEncounter(db, campaignId)!;
    return listCombatants(db, encounter.id).find((c) => c.id === id)!;
  };

  it('leaves a PC killed outright by massive damage without Unconscious or Prone', async () => {
    const { pc } = await pinchedFight();
    const result = damageCombatant(
      db,
      activeEncounter(db, campaignId)!,
      getCombatant(db, activeEncounter(db, campaignId)!.id, pc),
      { amount: 25, type: 'slashing', source: 'a great axe' },
    );

    expect(result.dead).toBe(true);
    const sheet = getCharacterSheet(db, campaignId)!;
    expect(sheet.status).toBe('dead');
    expect(sheet.hp_current).toBe(0);
    expect(sheet.conditions).not.toContain('unconscious');
    expect(sheet.conditions).not.toContain('prone');
    const row = rowOf(pc);
    expect(row.alive).toBe(false);
    expect(row.hp_current).toBe(0);
    expect(row.conditions).not.toContain('unconscious');
    expect(row.conditions).not.toContain('prone');
  });

  it('leaves a PC killed through the third death-save failure without Unconscious or Prone', async () => {
    const { pc } = await pinchedFight();
    db.prepare(
      'UPDATE character SET hp_current = 0, stable = 0, death_saves_json = ? WHERE campaign_id = ? AND is_pc = 1',
    ).run(JSON.stringify({ successes: 0, failures: 2 }), campaignId);
    db.prepare('UPDATE combatant SET hp_current = 0 WHERE id = ?').run(pc);

    const result = damageCombatant(
      db,
      activeEncounter(db, campaignId)!,
      getCombatant(db, activeEncounter(db, campaignId)!.id, pc),
      { amount: 5, type: 'bludgeoning', source: 'a hobgoblin mace' },
    );

    expect(result.dead).toBe(true);
    const sheet = getCharacterSheet(db, campaignId)!;
    expect(sheet.status).toBe('dead');
    expect(sheet.conditions).not.toContain('unconscious');
    expect(sheet.conditions).not.toContain('prone');
    const row = rowOf(pc);
    expect(row.alive).toBe(false);
    expect(row.conditions).not.toContain('unconscious');
    expect(row.conditions).not.toContain('prone');
  });

  it('leaves a PC killed through the death-save roll without Unconscious or Prone', async () => {
    const { pc } = await pinchedFight();
    db.prepare(
      'UPDATE character SET hp_current = 0, stable = 0, death_saves_json = ?, conditions_json = ? WHERE campaign_id = ? AND is_pc = 1',
    )
      .run(JSON.stringify({ successes: 0, failures: 2 }), JSON.stringify(['unconscious', 'prone']), campaignId);
    db.prepare('UPDATE combatant SET hp_current = 0, conditions_json = ? WHERE id = ?').run(
      JSON.stringify(['unconscious', 'prone']),
      pc,
    );

    const result = deathSave(db, { campaign_id: campaignId, roll: { total: 5, natural_d20: 5 } });

    expect(result.status).toBe('dead');
    const sheet = getCharacterSheet(db, campaignId)!;
    expect(sheet.status).toBe('dead');
    expect(sheet.hp_current).toBe(0);
    expect(sheet.conditions).not.toContain('unconscious');
    expect(sheet.conditions).not.toContain('prone');
    const row = rowOf(pc);
    expect(row.alive).toBe(false);
    expect(row.conditions).not.toContain('unconscious');
    expect(row.conditions).not.toContain('prone');
  });

  it('leaves a PC killed by exhaustion 6 without Unconscious or Prone', async () => {
    const { pc } = await pinchedFight();

    const result = setExhaustion(db, { campaign_id: campaignId, level: 6 });

    expect(result.status).toBe('dead');
    const sheet = getCharacterSheet(db, campaignId)!;
    expect(sheet.status).toBe('dead');
    expect(sheet.hp_current).toBe(0);
    expect(sheet.conditions).not.toContain('unconscious');
    expect(sheet.conditions).not.toContain('prone');
    const row = rowOf(pc);
    expect(row.alive).toBe(false);
    expect(row.conditions).not.toContain('unconscious');
    expect(row.conditions).not.toContain('prone');
  });

  it('still drops a living PC to Unconscious and Prone at 0 HP without killing them', async () => {
    const { pc } = await pinchedFight();
    damageCombatant(
      db,
      activeEncounter(db, campaignId)!,
      getCombatant(db, activeEncounter(db, campaignId)!.id, pc),
      { amount: 12, type: 'slashing', source: 'a longsword' },
    );

    const sheet = getCharacterSheet(db, campaignId)!;
    expect(sheet.status).not.toBe('dead');
    expect(sheet.hp_current).toBe(0);
    expect(sheet.conditions).toContain('unconscious');
    expect(sheet.conditions).toContain('prone');
    expect(sheet.death_saves).toEqual({ successes: 0, failures: 0 });
    const row = rowOf(pc);
    expect(row.alive).toBe(true);
    expect(row.conditions).toContain('unconscious');
    expect(row.conditions).toContain('prone');
  });

  it('strips a Prone the PC had before the killing blow', async () => {
    const { pc } = await pinchedFight();
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'prone', active: true });
    expect(getCharacterSheet(db, campaignId)!.conditions).toContain('prone');

    damageCombatant(
      db,
      activeEncounter(db, campaignId)!,
      getCombatant(db, activeEncounter(db, campaignId)!.id, pc),
      { amount: 25, type: 'piercing', source: 'a crossbow bolt' },
    );

    const sheet = getCharacterSheet(db, campaignId)!;
    expect(sheet.status).toBe('dead');
    expect(sheet.conditions).not.toContain('prone');
    expect(sheet.conditions).not.toContain('unconscious');
    const row = rowOf(pc);
    expect(row.alive).toBe(false);
    expect(row.conditions).not.toContain('prone');
    expect(row.conditions).not.toContain('unconscious');
  });
});
