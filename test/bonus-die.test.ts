import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { d20Context, rollCheck, rollD20, rollSave } from '../src/combat/d20.js';
import { endConcentration } from '../src/combat/effects.js';
import {
  applyEffect,
  attack,
  damageCombatant,
  spellFill,
  startEncounter,
  undoLastCombatAction,
  useAction,
} from '../src/combat/engine.js';
import {
  combatLog,
  getCombatant,
  listCombatants,
  listEffects,
  requireEncounter,
  setCombatantStatBlock,
  type Combatant,
} from '../src/combat/state.js';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, createCompanion } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
/** Pins every d20 to a 20 and every d4 to a 4. */
const HIGH = 0.041;
/** Pins every d20 to a 4 and every d4 to a 4. */
const LOW = 0.99;

interface Fight {
  pc: number;
  elowen: number;
  aldo: number;
  goblin: number;
}

function makeCampaign(playerRolls: 'none' | 'all'): number {
  const id = createCampaign(db, { name: 'Bonus dice', story_shape: 'sandbox', settings: { player_rolls: playerRolls } })
    .campaign_id;
  createCharacter(db, {
    campaign_id: id,
    name: 'Bram',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
  for (const name of ['Elowen', 'Aldo']) {
    const cleric = createCompanion(db, {
      campaign_id: id,
      name,
      source: { class: 'Cleric', species: 'Human', background: 'Acolyte' },
    }).companion!.id;
    db.prepare('UPDATE character SET spells_json = ?, spell_slots_json = ? WHERE id = ?').run(
      JSON.stringify({ cantrips: ['Guidance', 'Resistance'], known: ['Bless', 'Bane'], prepared: ['Bless', 'Bane'], save_dc: 13, attack_bonus: 5 }),
      JSON.stringify({ '1': { max: 4, used: 0 } }),
      cleric,
    );
  }
  return id;
}

/** A fight on an open map: Bram, the two clerics beside him and a goblin 15 ft off with 100 HP. */
async function fight(playerRolls: 'none' | 'all' = 'none'): Promise<Fight> {
  campaignId = makeCampaign(playerRolls);
  const stopClicking = resolvePendingRollsImmediately(db);
  const started = await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: 1 }],
  });
  stopClicking();
  const map = { w: 30, h: 10, rows: Array.from({ length: 10 }, () => '.'.repeat(30)), features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), started.encounter_id);
  const combatants = listCombatants(db, started.encounter_id);
  const ids: Fight = {
    pc: combatants.find((c) => c.kind === 'pc')!.id,
    elowen: combatants.find((c) => c.name === 'Elowen')!.id,
    aldo: combatants.find((c) => c.name === 'Aldo')!.id,
    goblin: combatants.find((c) => c.team === 'enemy')!.id,
  };
  const place = (id: number, x: number): void => {
    db.prepare('UPDATE combatant SET x = ?, y = 5 WHERE id = ?').run(x, id);
  };
  place(ids.pc, 5);
  place(ids.elowen, 4);
  place(ids.aldo, 3);
  place(ids.goblin, 6);
  db.prepare('UPDATE combatant SET hp_current = 100, hp_max = 100 WHERE id = ?').run(ids.goblin);
  return ids;
}

const encounter = () => requireEncounter(db, campaignId);
const who = (id: number): Combatant => getCombatant(db, encounter().id, id);

const giveTurn = (id: number): void => {
  const index = listCombatants(db, encounter().id).findIndex((c) => c.id === id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, encounter().id);
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0 WHERE id = ?').run(id);
};

/** An effect row as `effect {op: apply}` makes it: held on the caster's concentration. */
const cast = (name: string, target: number, source: number, damageType?: string): void => {
  applyEffect(db, {
    campaign_id: campaignId,
    target_id: target,
    source_id: source,
    name,
    kind: 'buff',
    tick: 'end',
    ends: 'concentration',
    ...(damageType ? { damage_type: damageType } : {}),
  });
};

const diceOn = (id: number, kind: 'attack' | 'save' | 'check', skill?: string): string =>
  d20Context(db, encounter(), who(id), { kind, ...(kind === 'save' ? { ability: 'wis' as const } : {}), ...(skill ? { skill } : {}) })
    .dice;

const lastCard = (): string =>
  (db.prepare('SELECT expr FROM pending_roll ORDER BY id DESC LIMIT 1').get() as { expr: string }).expr;

beforeEach(() => {
  db = openDb(':memory:');
  Math.random = () => HIGH;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('Bless', () => {
  it('adds 1d4 to the attack rolls and saves of a blessed creature, rolled with the d20', async () => {
    const f = await fight();
    cast('Bless', f.pc, f.elowen);

    const context = d20Context(db, encounter(), who(f.pc), { kind: 'attack', target: who(f.goblin) });
    expect(context.dice).toBe('+1d4');
    expect(context.notes).toContain('Bless: +1d4');
    const engine = rollD20(5, { kind: 'attack', dice: context.dice });
    expect(engine).toMatchObject({ expr: '1d20+5+1d4', total: 29, natural: 20 });
    expect(rollD20(5, { kind: 'attack', dice: context.dice }, { total: 12 }).expr).toBe('1d20+5+1d4 (player roll)');

    const save = await rollSave(db, encounter(), who(f.pc), 'wis', 10);
    expect(save.total).toBe(20 + save.bonus + 4);
    expect(save.notes).toContain('Bless: +1d4');
    // Bless has nothing to say about an ability check.
    expect(diceOn(f.pc, 'check', 'athletics')).toBe('');
  });

  it('reaches up to three creatures from one casting and ends with its concentration', async () => {
    const f = await fight();
    for (const id of [f.pc, f.elowen, f.aldo]) cast('Bless', id, f.elowen);
    expect(who(f.elowen).concentration?.name).toBe('Bless');
    expect(listEffects(db, encounter().id).filter((e) => e.name === 'Bless')).toHaveLength(3);
    for (const id of [f.pc, f.elowen, f.aldo]) expect(diceOn(id, 'save')).toBe('+1d4');

    endConcentration(db, encounter(), who(f.elowen), 'Elowen is knocked out');
    for (const id of [f.pc, f.elowen, f.aldo]) expect(diceOn(id, 'save')).toBe('');
  });

  it('lands through the cast effect and shows on the next save', async () => {
    const f = await fight();
    giveTurn(f.elowen);
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: f.elowen,
      action_name: 'Bless',
      spell: 'Bless',
      target_id: f.pc,
      effect: { name: 'Bless', kind: 'buff' },
    });
    expect(listEffects(db, encounter().id).find((e) => e.name === 'Bless')).toMatchObject({
      target_id: f.pc,
      ends: 'concentration',
      concentration_of: f.elowen,
    });
    const save = await rollSave(db, encounter(), who(f.pc), 'con', 10);
    expect(save.total).toBe(20 + save.bonus + 4);
  });

  it('counts once however many castings are on the creature', async () => {
    const f = await fight();
    cast('Bless', f.pc, f.elowen);
    cast('Bless', f.pc, f.aldo);
    expect(diceOn(f.pc, 'attack')).toBe('+1d4');
    const save = await rollSave(db, encounter(), who(f.pc), 'wis', 10);
    expect(save.total).toBe(20 + save.bonus + 4);
  });
});

describe('Bane', () => {
  it('takes 1d4 off the attack rolls and saves of a creature that fails its Charisma save', async () => {
    const f = await fight();
    Math.random = () => LOW;
    giveTurn(f.elowen);
    const casting = await useAction(db, {
      campaign_id: campaignId,
      actor_id: f.elowen,
      action_name: 'Bane',
      spell: 'Bane',
      target_id: f.goblin,
      effect: { name: 'Bane', kind: 'buff' },
    });
    const target = (casting as { targets: Array<{ save: { ability: string; success: boolean } }> }).targets[0]!;
    expect(target.save).toMatchObject({ ability: 'cha', success: false });
    expect(diceOn(f.goblin, 'attack')).toBe('-1d4');
    const save = await rollSave(db, encounter(), who(f.goblin), 'dex', 30);
    expect(save.total).toBe(4 + save.bonus - 4);
    expect(save.notes).toContain('Bane: -1d4');
  });

  it('leaves a creature that makes the save alone', async () => {
    const f = await fight();
    giveTurn(f.elowen);
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: f.elowen,
      action_name: 'Bane',
      spell: 'Bane',
      target_id: f.goblin,
      effect: { name: 'Bane', kind: 'buff' },
    });
    expect(listEffects(db, encounter().id).some((e) => e.name === 'Bane')).toBe(false);
    expect(diceOn(f.goblin, 'attack')).toBe('');
  });

  it('puts both dice on a roll when Bless and Bane are on the same creature', async () => {
    const f = await fight();
    cast('Bless', f.pc, f.elowen);
    cast('Bane', f.pc, f.aldo);
    expect(diceOn(f.pc, 'attack')).toBe('+1d4-1d4');
    const save = await rollSave(db, encounter(), who(f.pc), 'wis', 10);
    expect(save.total).toBe(20 + save.bonus);
    expect(save.notes).toEqual(expect.arrayContaining(['Bless: +1d4', 'Bane: -1d4']));
  });
});

describe('Guidance', () => {
  const athletics = { ability: 'str' as const, skill: 'athletics', dc: 10, purpose: 'Athletics check', tool: 'use_action' };

  it('adds 1d4 to every check with its chosen skill until the spell ends', async () => {
    const f = await fight();
    cast('Guidance (Athletics)', f.pc, f.elowen);
    for (let time = 0; time < 2; time += 1) {
      const check = await rollCheck(db, encounter(), who(f.pc), athletics);
      expect(check.total).toBe(20 + check.bonus + 4);
      expect(check.notes).toContain('Guidance (Athletics): +1d4');
    }
    const perception = await rollCheck(db, encounter(), who(f.pc), { ...athletics, ability: 'wis', skill: 'perception' });
    expect(perception.total).toBe(20 + perception.bonus);
    expect(diceOn(f.pc, 'save')).toBe('');

    endConcentration(db, encounter(), who(f.elowen), 'Elowen lets it go');
    const after = await rollCheck(db, encounter(), who(f.pc), athletics);
    expect(after.total).toBe(20 + after.bonus);
  });

  it('reads the skill however it is written, and says so when none is named', async () => {
    const f = await fight();
    cast('Guidance (Sleight of Hand)', f.pc, f.elowen);
    expect(diceOn(f.pc, 'check', 'sleight_of_hand')).toBe('+1d4');

    cast('Guidance', f.aldo, f.aldo);
    const bare = d20Context(db, encounter(), who(f.aldo), { kind: 'check', ability: 'wis', skill: 'insight' });
    expect(bare.dice).toBe('');
    expect(bare.notes.join()).toMatch(/names no skill/);
  });

  it('no longer deals damage when it is cast, and neither does Resistance', async () => {
    expect(spellFill('Guidance', null)!.damage_expr).toBeUndefined();
    expect(spellFill('Resistance', null)!.damage_expr).toBeUndefined();
    const f = await fight();
    giveTurn(f.elowen);
    const before = who(f.pc).hp_current;
    // The cast now needs its skill, so the call names one.
    await useAction(db, { campaign_id: campaignId, actor_id: f.elowen, action_name: 'Guidance', spell: 'Guidance', target_id: f.pc, choice: 'athletics' });
    expect(who(f.pc).hp_current).toBe(before);
  });
});

describe('Resistance', () => {
  const nextTurn = (): void => {
    db.prepare('UPDATE encounter SET turn_index = (turn_index + 1) % 4 WHERE id = ?').run(encounter().id);
  };

  it('takes 1d4 off damage of the chosen type, once a turn', async () => {
    const f = await fight();
    cast('Resistance', f.goblin, f.elowen, 'fire');
    expect(damageCombatant(db, encounter(), who(f.goblin), { amount: 10, type: 'fire' }).applied).toBe(6);
    expect(combatLog(db, encounter().id).map((e) => e.text)).toContain('Resistance: Goblin Warrior takes 4 less fire damage (1d4: [4] = 4).');
    expect(damageCombatant(db, encounter(), who(f.goblin), { amount: 10, type: 'fire' }).applied).toBe(10);

    nextTurn();
    // Another type does not touch it or spend it.
    expect(damageCombatant(db, encounter(), who(f.goblin), { amount: 10, type: 'cold' }).applied).toBe(10);
    expect(damageCombatant(db, encounter(), who(f.goblin), { amount: 3, type: 'fire' }).applied).toBe(0);
  });

  it('comes off before the creature own Resistance halves what is left', async () => {
    const f = await fight();
    setCombatantStatBlock(db, f.goblin, { ...who(f.goblin).stat_block!, damage_resistances: 'fire' });
    cast('Resistance', f.goblin, f.elowen, 'fire');
    // (10 - 4) halved is 3, where halving first would leave 1.
    expect(damageCombatant(db, encounter(), who(f.goblin), { amount: 10, type: 'fire' }).applied).toBe(3);
  });

  it('gives the turn its use back when the blow is undone', async () => {
    const f = await fight();
    cast('Resistance', f.goblin, f.elowen, 'slashing');
    giveTurn(f.pc);
    const swing = async (): Promise<number> => {
      await attack(db, { campaign_id: campaignId, attacker_id: f.pc, target_id: f.goblin, action_name: 'Greatsword' });
      return who(f.goblin).hp_current;
    };
    // Undo keeps the lines it took back, struck through; only the standing ones count.
    const resisted = (): number =>
      combatLog(db, encounter().id, { omitReverted: true }).filter((e) => e.text.startsWith('Resistance: Goblin Warrior')).length;

    const first = await swing();
    expect(resisted()).toBe(1);
    undoLastCombatAction(db, campaignId);
    expect(resisted()).toBe(0);
    expect(await swing()).toBe(first);
    expect(resisted()).toBe(1);
  });
});

describe('the player rolling their own d20', () => {
  it('shows the die on the save and check cards, and the server rolls it', async () => {
    const f = await fight('all');
    // One caster holds one concentration, so the second spell comes from the other cleric.
    cast('Bless', f.pc, f.elowen);
    cast('Guidance (Athletics)', f.pc, f.aldo);
    const stopClicking = resolvePendingRollsImmediately(db);
    try {
      const save = await rollSave(db, encounter(), who(f.pc), 'wis', 10);
      expect(lastCard()).toBe(`1d20+${save.bonus}+1d4`);
      expect(save.total).toBe(20 + save.bonus + 4);

      const check = await rollCheck(db, encounter(), who(f.pc), { ability: 'str', skill: 'athletics', dc: 10, purpose: 'Athletics', tool: 'use_action' });
      expect(lastCard()).toBe(`1d20+${check.bonus}+1d4`);
      expect(check.total).toBe(20 + check.bonus + 4);
    } finally {
      stopClicking();
    }
  });
});

describe('a D20 Test stance on a roll that carries the die', () => {
  const arm = (id: number, mode: 'reroll' | 'set_20'): void => {
    db.prepare('UPDATE combatant SET flags_json = ? WHERE id = ?').run(
      JSON.stringify({ d20_stance: { feature: mode === 'reroll' ? 'Indomitable' : 'Stroke of Luck', mode, on: ['save'] } }),
      id,
    );
  };

  it('rolls the die again with a reroll, and keeps it on a d20 turned into a 20', async () => {
    const f = await fight();
    Math.random = () => LOW;
    cast('Bless', f.pc, f.elowen);

    arm(f.pc, 'reroll');
    const rerolled = await rollSave(db, encounter(), who(f.pc), 'wis', 30);
    expect(rerolled.notes.join()).toMatch(/Indomitable: the roll is made again/);
    expect(rerolled.total).toBe(4 + rerolled.bonus + 4);

    arm(f.pc, 'set_20');
    const lucky = await rollSave(db, encounter(), who(f.pc), 'wis', 30);
    expect(lucky.notes.join()).toMatch(/Stroke of Luck: the die is turned into a 20/);
    expect(lucky.total).toBe(20 + lucky.bonus + 4);
  });
});
