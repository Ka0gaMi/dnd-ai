// Regression tests for the twelve 2024-rules bugs an engine review turned up.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import {
  applyDamage,
  createCharacter,
  createCompanion,
  setExhaustion,
  type CreateCharacterInput,
} from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import {
  advanceTurn,
  applyEffect,
  attack,
  moveToken,
  setCombatCondition,
  startEncounter,
  undoLastCombatAction,
  useAction,
} from '../src/combat/engine.js';
import { combatSheet } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, type BattleState } from '../src/combat/state.js';
import { reply } from '../src/mcp/tools/result.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const MID_D20 = 0.5;
const HIGH_D20 = 0.6; // 18 on a d20
const hit = { total: 25, natural: 12 };

const borg: Omit<CreateCharacterInput, 'campaign_id'> = {
  name: 'Borg',
  species: 'Dwarf',
  class: 'Fighter',
  background: 'Soldier',
  ability_method: 'standard_array',
  abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
  ability_bonuses: { str: 2, con: 1 },
  skill_choices: ['athletics', 'perception'],
};

function makeCampaign(database: Db, pc: Omit<CreateCharacterInput, 'campaign_id'> = borg): number {
  const id = createCampaign(database, { name: 'Review', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
    .campaign_id;
  createCharacter(database, { campaign_id: id, ...pc });
  return id;
}

async function ambush(creature = 'Goblin Warrior', enemies = 1): Promise<BattleState> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature, count: enemies }],
  });
  setMap(Array.from({ length: 8 }, () => '.'.repeat(30)));
  return getBattleState(db, campaignId)!;
}

const ids = (): { pc: number; enemy: number[] } => {
  const combatants = listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
  return {
    pc: combatants.find((c) => c.kind === 'pc')!.id,
    enemy: combatants.filter((c) => c.team === 'enemy').map((c) => c.id),
  };
};

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

const startTurn = (id: number): void => {
  db.prepare(
    'UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?',
  ).run(id);
  giveTurn(id);
};

const combatantOf = (id: number): BattleState['combatants'][number] =>
  getBattleState(db, campaignId)!.combatants.find((c) => c.id === id)!;

/** Turns until the given combatant is the active one, so a start-of-turn rule can be watched. */
async function turnsUntil(id: number): Promise<Awaited<ReturnType<typeof advanceTurn>>> {
  for (let step = 0; step < 12; step += 1) {
    const turn = await advanceTurn(db, campaignId);
    if (getBattleState(db, campaignId)!.active?.id === id) return turn;
  }
  throw new Error('never came round to that combatant');
}

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = makeCampaign(db);
  Math.random = () => MID_D20;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('standing up', () => {
  it('costs half the speed and no Action, so it is legal after the Action is spent', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    startTurn(pc);
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'prone', active: true });

    await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Unarmed Strike',
      roll: hit,
    });
    expect(combatantOf(pc).action_used).toBe(true);

    const stood = (await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'stand',
    })) as unknown as { cost_ft: number; movement_left: number };
    expect(stood.cost_ft).toBe(15);
    expect(stood.movement_left).toBe(15);
    expect(combatantOf(pc).conditions).not.toContain('prone');
    // The Action is still the one that was spent on the swing.
    expect(combatantOf(pc).action_used).toBe(true);
  });
});

describe('exhaustion and the character tools', () => {
  it('keeps the 5 ft per level off the speed when a character tool mirrors mid-fight', async () => {
    setExhaustion(db, { campaign_id: campaignId, level: 2 });
    await ambush();
    const { pc } = ids();
    expect(combatantOf(pc).speed).toBe(20);

    applyDamage(db, { campaign_id: campaignId, amount: 3 });
    expect(combatantOf(pc).speed).toBe(20);

    await turnsUntil(pc);
    expect(combatantOf(pc).movement_left).toBe(20);
  });
});

describe('taking a combat call back', () => {
  it('puts the stable flag back with the death saves', async () => {
    await ambush();
    const { pc } = ids();
    const characterId = combatantOf(pc).character_id!;
    db.prepare(
      "UPDATE character SET hp_current = 0, death_saves_json = ?, conditions_json = ?, stable = 0 WHERE id = ?",
    ).run(JSON.stringify({ successes: 2, failures: 0 }), JSON.stringify(['unconscious']), characterId);
    db.prepare("UPDATE combatant SET hp_current = 0, conditions_json = ?, death_saves_json = ? WHERE id = ?").run(
      JSON.stringify(['unconscious']),
      JSON.stringify({ successes: 2, failures: 0 }),
      pc,
    );

    Math.random = () => HIGH_D20; // the third death save succeeds
    await turnsUntil(pc);
    expect(combatSheet(db, characterId).stable).toBe(true);

    undoLastCombatAction(db, campaignId);
    const back = combatSheet(db, characterId);
    expect(back.stable).toBe(false);
    expect(back.death_saves).toEqual({ successes: 2, failures: 0 });
  });
});

describe('casting out of range', () => {
  it('refuses the spell before the slot is spent', async () => {
    const wizardId = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Zel',
      source: { class: 'Wizard', species: 'Human', background: 'Sage' },
    }).companion!.id;
    db.prepare('UPDATE character SET spells_json = ?, spell_slots_json = ? WHERE id = ?').run(
      JSON.stringify({ cantrips: [], known: ['Sleep'], prepared: ['Sleep'], save_dc: 13, attack_bonus: 5 }),
      JSON.stringify({ '1': { max: 2, used: 0 } }),
      wizardId,
    );
    await ambush();
    const zel = listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.name === 'Zel')!.id;
    const { enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 20, 5); // 95 ft away, well beyond Sleep's 60 ft
    giveTurn(zel);

    await expect(
      useAction(db, {
        campaign_id: campaignId,
        actor_id: zel,
        action_name: 'Sleep',
        spell: 'Sleep',
        target_id: enemy[0]!,
      }),
    ).rejects.toThrow(/reaches 60 ft/);
    expect(combatSheet(db, wizardId).spell_slots['1']).toEqual({ max: 2, used: 0 });
  });
});

describe('a character\'s size in the fight', () => {
  it('reads the species size off the species feature', () => {
    const halfling = openDb(':memory:');
    const id = createCampaign(halfling, { name: 'Small', story_shape: 'sandbox' }).campaign_id;
    const pc = createCharacter(halfling, {
      campaign_id: id,
      ...borg,
      name: 'Pip',
      species: 'Halfling',
    }).character!.id;
    expect(combatSheet(halfling, pc).size).toBe('S');
    halfling.close();
  });

  it('refuses a Small character the grapple of a Large creature', async () => {
    db = openDb(':memory:');
    campaignId = makeCampaign(db, { ...borg, name: 'Pip', species: 'Halfling' });
    await ambush('Brown Bear');
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    startTurn(pc);
    await expect(
      useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'grapple', target_id: enemy[0]! }),
    ).rejects.toThrow(/more than one size larger/);
  });
});

describe('a touch spell', () => {
  it('is not a crowded shot, so an adjacent enemy gives it no disadvantage', async () => {
    const wizardId = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Zel',
      source: { class: 'Wizard', species: 'Human', background: 'Sage' },
    }).companion!.id;
    db.prepare('UPDATE character SET spells_json = ? WHERE id = ?').run(
      JSON.stringify({
        cantrips: ['Shocking Grasp'],
        known: [],
        prepared: [],
        save_dc: 13,
        attack_bonus: 5,
      }),
      wizardId,
    );
    await ambush();
    const zel = listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.name === 'Zel')!.id;
    const { enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 2, 5);
    giveTurn(zel);

    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: zel,
      action_name: 'Shocking Grasp',
      spell: 'Shocking Grasp',
      target_id: enemy[0]!,
      roll: hit,
    });
    const target = cast.targets[0] as { attack: { advantage: string } };
    expect(target.attack.advantage).toBe('none');
    expect(JSON.stringify(cast.log)).not.toContain('rushed');
  });
});

describe('a Wizard\'s first spellbook', () => {
  const zel = (extra: Partial<CreateCharacterInput> = {}): CreateCharacterInput => ({
    campaign_id: campaignId,
    name: 'Zel',
    species: 'Human',
    class: 'Wizard',
    background: 'Sage',
    ability_method: 'standard_array',
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
    ability_bonuses: { int: 2, con: 1 },
    skill_choices: ['arcana', 'history', 'investigation'],
    cantrips: ['Fire Bolt', 'Light', 'Prestidigitation'],
    spells: ['Magic Missile', 'Shield', 'Mage Armor', 'Sleep'],
    ...extra,
  });

  it('takes the six the player picked, the four prepared among them', () => {
    const made = createCharacter(
      db,
      zel({ spellbook: ['Magic Missile', 'Shield', 'Mage Armor', 'Sleep', 'Grease', 'Thunderwave'] }),
    );
    const spells = made.character!.spells as { spellbook: string[]; prepared: string[] };
    expect(spells.spellbook).toEqual(['Magic Missile', 'Shield', 'Mage Armor', 'Sleep', 'Grease', 'Thunderwave']);
    expect(spells.prepared).toEqual(expect.arrayContaining(['Magic Missile', 'Shield', 'Mage Armor', 'Sleep']));
    expect(made.spellbook_chosen_for_you).toBeUndefined();
  });

  it('fills the last two pages in and says which when the book is left out', () => {
    const made = createCharacter(db, zel());
    const spells = made.character!.spells as { spellbook: string[] };
    expect(spells.spellbook).toHaveLength(6);
    expect(spells.spellbook.slice(0, 4)).toEqual(['Magic Missile', 'Shield', 'Mage Armor', 'Sleep']);
    expect(made.spellbook_chosen_for_you).toHaveLength(2);
    expect(spells.spellbook.slice(4)).toEqual(made.spellbook_chosen_for_you);
  });

  it('refuses a book of the wrong size, one missing a prepared spell, or one a Wizard does not keep', () => {
    expect(() => createCharacter(db, zel({ spellbook: ['Magic Missile', 'Shield', 'Mage Armor', 'Sleep'] }))).toThrow(
      /picks 6 spellbook spells/,
    );
    expect(() =>
      createCharacter(db, zel({ spellbook: ['Magic Missile', 'Shield', 'Mage Armor', 'Grease', 'Thunderwave', 'Alarm'] })),
    ).toThrow(/"Sleep" is not written in it/);
    expect(() =>
      createCharacter(db, {
        campaign_id: campaignId,
        ...borg,
        name: 'Brak',
        spellbook: ['Magic Missile'],
      }),
    ).toThrow(/Only a Wizard keeps a spellbook/);
  });
});

describe('pulling the blow', () => {
  it('leaves a character unconscious and stable rather than dying', async () => {
    await ambush();
    const { pc, enemy } = ids();
    const characterId = combatantOf(pc).character_id!;
    db.prepare('UPDATE character SET hp_current = 1 WHERE id = ?').run(characterId);
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
    const sheet = combatSheet(db, characterId);
    expect(sheet.hp_current).toBe(0);
    expect(sheet.stable).toBe(true);
    expect(sheet.conditions).toContain('unconscious');

    const turn = await turnsUntil(pc);
    expect(turn.log.some((entry) => entry.kind === 'death_save')).toBe(false);
  });

  it('does not tuck in a character who is already down: a pulled blow that lands nothing keeps their failures', async () => {
    // Hitting someone at 0 HP is an automatic critical in 2024, not a mercy - it must never
    // reset the death saves they have already failed.
    await ambush();
    const { pc, enemy } = ids();
    const characterId = combatantOf(pc).character_id!;
    db.prepare('UPDATE character SET hp_current = 0, death_saves_json = ? WHERE id = ?').run(
      JSON.stringify({ successes: 0, failures: 2 }),
      characterId,
    );
    db.prepare('UPDATE combatant SET hp_current = 0 WHERE id = ?').run(pc);
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
    const sheet = combatSheet(db, characterId);
    expect(sheet.stable).toBe(false);
    expect(sheet.death_saves).toMatchObject({ failures: 2 });
  });

  it('leaves a monster knocked out and rolls no death saves for it', async () => {
    await ambush();
    const { pc, enemy } = ids();
    db.prepare('UPDATE combatant SET hp_current = 1 WHERE id = ?').run(enemy[0]!);
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    startTurn(pc);

    await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Unarmed Strike',
      knock_out: true,
      roll: hit,
    });
    const knocked = combatantOf(enemy[0]!);
    expect(knocked.hp_current).toBe(0);
    expect(knocked.alive).toBe(true);
    expect(knocked.conditions).toContain('unconscious');
    expect(knocked.flags.stable).toBe(true);

    const turn = await turnsUntil(enemy[0]!);
    expect(turn.log.some((entry) => entry.kind === 'death_save')).toBe(false);
    expect(combatantOf(enemy[0]!).death_saves).toEqual({ successes: 0, failures: 0 });
  });
});

describe('the DM\'s copy of the battle state', () => {
  it('carries no visibility: the fog of war is the player\'s own setting', async () => {
    await ambush();
    const state = getBattleState(db, campaignId)!;
    expect(state.encounter.visibility).toBeDefined(); // the web and WS payloads keep it
    const answered = reply(db, campaignId, { state } as unknown as Record<string, unknown>);
    const shown = answered.structuredContent as { state: { encounter: Record<string, unknown> } };
    expect(shown.state.encounter.visibility).toBeUndefined();
    expect(shown.state.encounter.id).toBe(state.encounter.id);
    expect((answered.content[0] as { text: string }).text).not.toContain('visibility');
  });
});

describe('hiding', () => {
  it('refuses half cover: 2024 wants three-quarters, total or heavy obscurement', async () => {
    await ambush();
    const { pc, enemy } = ids();
    setMap([
      '..............',
      '..............',
      '..##..........',
      '..............',
      '..............',
      '..............',
    ]);
    place(pc, 2, 1);
    place(enemy[0]!, 2, 4); // half cover from the wall corner
    startTurn(pc);
    await expect(useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'hide' })).rejects.toThrow(
      /three-quarters cover/,
    );
  });
});

describe('initiative', () => {
  it('is a d20 test: exhaustion weighs on it', async () => {
    await ambush();
    const rested = combatantOf(ids().pc).initiative!;

    db = openDb(':memory:');
    campaignId = makeCampaign(db);
    setExhaustion(db, { campaign_id: campaignId, level: 2 });
    await ambush();
    // Two levels of exhaustion are 2 off every d20 test per level, initiative included.
    expect(combatantOf(ids().pc).initiative).toBe(rested - 4);
  });

  it('gives the DM sheet and the roll the same Alert bonus', () => {
    db = openDb(':memory:');
    campaignId = makeCampaign(db, {
      ...borg,
      name: 'Sly',
      background: 'Criminal',
      ability_bonuses: { dex: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
    });
    const sheet = getCharacterSheet(db, campaignId)!;
    const combat = combatSheet(db, sheet.id);
    const features = sheet.features as Array<{ name: string }>;
    expect(features.some((f) => f.name.startsWith('Alert'))).toBe(true);
    expect(combat.initiative_bonus).toBe(sheet.initiative_bonus);
    expect(combat.initiative_bonus).toBe((sheet.abilities as Record<string, { mod: number }>).dex.mod + 2);
  });
});

describe('frightened', () => {
  it('cannot move closer to the source, ruling or not', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 8, 5);
    applyEffect(db, {
      campaign_id: campaignId,
      target_id: pc,
      source_id: enemy[0]!,
      name: 'frightened',
      kind: 'condition',
      tick: 'end',
      ends: 'manual',
    });
    startTurn(pc);

    expect(() => moveToken(db, { campaign_id: campaignId, combatant_id: pc, to: { x: 4, y: 5 } })).toThrow(
      /cannot move closer/,
    );
    expect(() =>
      moveToken(db, {
        campaign_id: campaignId,
        combatant_id: pc,
        to: { x: 4, y: 5 },
        ruling: { reason: 'running the gauntlet' },
      }),
    ).toThrow(/cannot move closer/);

    // Away and sideways are both still fine.
    const aside = moveToken(db, { campaign_id: campaignId, combatant_id: pc, to: { x: 1, y: 7 } }) as unknown as {
      position: { x: number; y: number };
    };
    expect(aside.position).toEqual({ x: 1, y: 7 });
  });
});
