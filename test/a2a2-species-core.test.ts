// A2a-2 species core: the species trait registry and its six passive and save traits, each against a
// sheet of the right species and a negative case, plus a homebrew trait firing beside the SRD ones.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, grantFeature, heal, rest, type CreateCharacterInput } from '../src/core/character.js';
import { clausesSchema, type ClauseInput } from '../src/core/mechanics.js';
import { saveHomebrew } from '../src/core/progression.js';
import { applyEffect, attack, endEncounter, startEncounter, tickEffects } from '../src/combat/engine.js';
import { rollCheck, rollSave } from '../src/combat/d20.js';
import { FEATURES, classFeatures, heldFeatures } from '../src/combat/features.js';
import { RELENTLESS_ENDURANCE, SPECIES_TRAITS } from '../src/combat/species-traits.js';
import { combatSheet } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, requireEncounter, type Combatant } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';
import type { Ability } from '../src/core/rules.js';
import { findClass, findSpecies, skillChoiceGroups } from '../src/srd/lookup.js';
import { openDb, type Db } from '../src/db/connection.js';
import * as srd from '../src/srd/data.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const hit = { total: 30, natural: 12 };

// rpg-dice-roller turns each Math.random into one die through its own integer step, so these are measured.
const D20_1 = 0;
const D20_9 = 0.3;
const D20_18 = 0.6;

/** The next d20s the engine rolls, in order; anything after them rolls as 0.5. */
function queueRolls(values: number[]): void {
  let index = 0;
  Math.random = () => values[index++] ?? 0.5;
}

const LINEAGE: Record<string, string> = { Elf: 'Elven Lineage: High Elf', Gnome: 'Gnomish Lineage: Rock Gnome' };

function skillPicks(species: string): string[] {
  const picks: string[] = [];
  for (const group of skillChoiceGroups(findClass('fighter'), findSpecies(species))) {
    let taken = 0;
    for (const option of group.from) {
      if (taken >= group.choose) break;
      if (picks.includes(option)) continue;
      picks.push(option);
      taken += 1;
    }
  }
  return picks;
}

/** A level 1 fighter of that species, alone in a campaign of its own. */
function make(species: string): number {
  campaignId = createCampaign(db, { name: species, story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  const id = createCharacter(db, {
    campaign_id: campaignId,
    name: species,
    class: 'fighter',
    species,
    ...(LINEAGE[species] ? { lineage: LINEAGE[species] } : {}),
    background: 'Soldier',
    ability_method: 'manual',
    abilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: skillPicks(species),
  } as CreateCharacterInput).character!.id;
  db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(
    JSON.stringify([{ name: 'Longsword', qty: 1, equipped: true }]),
    id,
  );
  return id;
}

async function ambush(): Promise<void> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: 1 }],
  });
  const state = getBattleState(db, campaignId)!;
  const rows = Array.from({ length: 14 }, () => '.'.repeat(60));
  const map: BattleMap = { w: 60, h: 14, rows, features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
  let x = 3;
  for (const c of listCombatants(db, state.encounter.id)) {
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, 5, c.id);
    x += 1;
  }
  db.prepare("UPDATE combatant SET hp_max = 200, hp_current = 200 WHERE team = 'enemy'").run();
}

const encounter = () => requireEncounter(db, campaignId);
const combatants = (): Combatant[] => listCombatants(db, encounter().id);
const pc = (): Combatant => combatants().find((c) => c.kind === 'pc')!;
const foe = (): Combatant => combatants().find((c) => c.team === 'enemy')!;

/** Hands the turn to this combatant with its whole economy back. */
const turnOf = (who: Combatant): void => {
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?').run(who.id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === who.id),
    state.encounter.id,
  );
};

/** A fighter of that species in a fight, ready to roll. */
async function inFight(species: string): Promise<number> {
  const id = make(species);
  await ambush();
  return id;
}

const save = (ability: Ability, against?: string[]) =>
  rollSave(db, encounter(), pc(), ability, 12, against ? { against } : {});

/** Writes a homebrew feature row with these clauses, the way the DM's propose path stores one. */
function homebrewEntry(name: string, clauses: ClauseInput[]): number {
  return saveHomebrew(db, {
    campaign_id: campaignId,
    kind: 'feature',
    name,
    schema: { name, text: name, clauses: clausesSchema.parse(clauses) },
  }).id;
}

const CON_ADVANTAGE: ClauseInput[] = [{ when: 'roll', if: { kind: 'save', save: ['con'] }, do: [{ kind: 'advantage' }] }];

beforeEach(() => {
  db = openDb(':memory:');
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

// --- the registry -------------------------------------------------------------

describe('the species trait registry', () => {
  it('files every handler under an SRD trait of its own species, and keeps them out of the class registry', () => {
    for (const handler of Object.values(SPECIES_TRAITS)) {
      const trait = srd.traits().find((t) => t.index === handler.index);
      expect(trait, handler.index).toBeDefined();
      expect(trait!.name).toBe(handler.name);
      expect(trait!.species.map((s) => s.index)).toContain(handler.species);
      expect(handler.class).toBeUndefined();
      expect(FEATURES[handler.index]).toBeUndefined();
    }
  });

  it('holds a species trait through its species row, and a Human holds none of them', () => {
    const halfling = combatSheet(db, make('Halfling'));
    const held = heldFeatures(halfling).map((h) => h.handler.index);
    expect(held).toEqual(expect.arrayContaining(['brave', 'luck']));
    // The window's class feature view stays the class's own.
    expect(classFeatures(halfling).map((f) => f.index)).not.toContain('brave');

    const human = combatSheet(db, make('Human'));
    const indexes = Object.keys(SPECIES_TRAITS);
    expect(heldFeatures(human).filter((h) => indexes.includes(h.handler.index))).toEqual([]);
  });
});

// --- the four save traits -----------------------------------------------------

describe('Brave', () => {
  it('gives a Halfling Advantage on a save to avoid Frightened, and on nothing else', async () => {
    await inFight('Halfling');
    const scared = await save('wis', ['frightened']);
    expect(scared.advantage).toBe('advantage');
    expect(scared.notes.join(' ')).toMatch(/Brave/);
    expect((await save('wis')).advantage).toBe('none');
    expect((await save('wis', ['charmed'])).advantage).toBe('none');
  });

  it('gives Advantage on the save that ends Frightened at the end of the turn, and not on one ending Restrained', async () => {
    await inFight('Halfling');
    applyEffect(db, {
      campaign_id: campaignId,
      target_id: pc().id,
      name: 'frightened',
      kind: 'condition',
      tick: 'end',
      ends: 'save',
      save_ability: 'wis',
      save_dc: 30,
    });
    applyEffect(db, {
      campaign_id: campaignId,
      target_id: pc().id,
      name: 'restrained',
      kind: 'condition',
      tick: 'end',
      ends: 'save',
      save_ability: 'wis',
      save_dc: 30,
    });
    const log = await tickEffects(db, encounter(), pc().id, 'end');
    const saves = log.filter((e) => e.kind === 'save').map((e) => e.payload as { save: { advantage: string }; effect_id: number });
    expect(saves).toHaveLength(2);
    const [frightened, restrained] = saves;
    expect(frightened!.save.advantage).toBe('advantage');
    expect(restrained!.save.advantage).toBe('none');
  });

  it('gives a Human nothing', async () => {
    await inFight('Human');
    expect((await save('wis', ['frightened'])).advantage).toBe('none');
  });
});

describe('Fey Ancestry', () => {
  it('gives an Elf Advantage on a save to avoid Charmed, and not on one against Frightened', async () => {
    await inFight('Elf');
    const charmed = await save('wis', ['charmed']);
    expect(charmed.advantage).toBe('advantage');
    expect(charmed.notes.join(' ')).toMatch(/Fey Ancestry/);
    expect((await save('wis', ['frightened'])).advantage).toBe('none');
  });

  it('gives a Human nothing', async () => {
    await inFight('Human');
    expect((await save('wis', ['charmed'])).advantage).toBe('none');
  });
});

describe('Dwarven Resilience', () => {
  it('gives a Dwarf Advantage on a save to avoid Poisoned, alongside the Poison resistance it already had', async () => {
    const id = await inFight('Dwarf');
    const poisoned = await save('con', ['poisoned']);
    expect(poisoned.advantage).toBe('advantage');
    expect(poisoned.notes.join(' ')).toMatch(/Dwarven Resilience/);
    expect((await save('con')).advantage).toBe('none');
    expect(combatSheet(db, id).resistances).toContain('poison');
  });

  it('gives a Human nothing', async () => {
    await inFight('Human');
    expect((await save('con', ['poisoned'])).advantage).toBe('none');
  });
});

describe('Gnomish Cunning', () => {
  it('gives a Gnome Advantage on Intelligence, Wisdom and Charisma saves, and not on the physical ones', async () => {
    await inFight('Gnome');
    for (const ability of ['int', 'wis', 'cha'] as Ability[]) {
      const rolled = await save(ability);
      expect(rolled.advantage, ability).toBe('advantage');
      expect(rolled.notes.join(' ')).toMatch(/Gnomish Cunning/);
    }
    for (const ability of ['str', 'dex', 'con'] as Ability[]) {
      expect((await save(ability)).advantage, ability).toBe('none');
    }
  });

  it('gives a Human nothing', async () => {
    await inFight('Human');
    expect((await save('wis')).advantage).toBe('none');
  });
});

// --- Halfling Luck ------------------------------------------------------------

describe('Halfling Luck', () => {
  it('rerolls a natural 1 on a save, and the new roll stands', async () => {
    await inFight('Halfling');
    queueRolls([D20_1, D20_18]);
    const rolled = await save('dex');
    expect(rolled.natural).toBe(18);
    expect(rolled.total).toBe(18 + rolled.bonus);
    expect(rolled.notes.join(' ')).toMatch(/Halfling Luck: the natural 1 is rerolled and the d20 now reads 18/);
  });

  it('leaves any other natural alone', async () => {
    await inFight('Halfling');
    queueRolls([D20_9, D20_18]);
    const rolled = await save('dex');
    expect(rolled.natural).toBe(9);
    expect(rolled.notes.join(' ')).not.toMatch(/Halfling Luck/);
  });

  it('rerolls only the die that came up 1: with Disadvantage the other die still stands', async () => {
    await inFight('Halfling');
    // The pool is [1, 9] keeping the lower; the 1 becomes an 18, and the lower of 18 and 9 is the 9.
    queueRolls([D20_1, D20_9, D20_18]);
    const rolled = await rollSave(db, encounter(), pc(), 'dex', 12, { advantage: 'disadvantage' });
    expect(rolled.advantage).toBe('disadvantage');
    expect(rolled.natural).toBe(9);
  });

  it('rerolls a natural 1 on an ability check', async () => {
    await inFight('Halfling');
    queueRolls([D20_1, D20_18]);
    const rolled = await rollCheck(db, encounter(), pc(), { ability: 'str', dc: 10, purpose: 'Shove the cart', tool: 'test' });
    expect(rolled.natural).toBe(18);
    expect(rolled.notes.join(' ')).toMatch(/Halfling Luck/);
  });

  it('rerolls a natural 1 on an attack roll, turning the automatic miss into a hit', async () => {
    await inFight('Halfling');
    turnOf(pc());
    queueRolls([D20_1, D20_18]);
    const swing = (await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
    })) as unknown as { natural: number; hit: boolean; log: Array<{ kind: string; text: string; payload: Record<string, unknown> }> };
    const line = swing.log.find((e) => e.kind === 'attack')!;
    expect(line.payload.natural).toBe(18);
    expect(line.payload.hit).toBe(true);
    expect(line.text).toMatch(/Halfling Luck/);
    // The note rides in the log line, not as a stray field on the roll.
    expect(line.payload.roll).not.toHaveProperty('reroll_note');
  });

  it('gives a Human nothing: the natural 1 stands', async () => {
    await inFight('Human');
    queueRolls([D20_1, D20_18]);
    const rolled = await save('dex');
    expect(rolled.natural).toBe(1);
    expect(rolled.notes.join(' ')).not.toMatch(/Halfling Luck/);
  });
});

// --- Relentless Endurance -----------------------------------------------------

describe('Relentless Endurance', () => {
  const usedOf = (id: number): number =>
    combatSheet(db, id).features.find((f) => f.mechanics?.resource === RELENTLESS_ENDURANCE.resource)?.mechanics?.used ?? 0;

  /** Puts the Orc on 1 hit point, on the sheet and on the token. */
  const bloody = (id: number): void => {
    db.prepare('UPDATE character SET hp_current = 1 WHERE id = ?').run(id);
    db.prepare('UPDATE combatant SET hp_current = 1 WHERE character_id = ?').run(id);
  };

  const goblinHits = () => {
    turnOf(foe());
    return attack(db, { campaign_id: campaignId, attacker_id: foe().id, target_id: pc().id, action_name: 'Scimitar', roll: hit });
  };

  it('keeps an Orc on 1 hit point once, and not again until a Long Rest', async () => {
    const id = await inFight('Orc');
    bloody(id);
    const first = (await goblinHits()) as unknown as { log: Array<{ kind: string; text: string }> };
    expect(first.log.map((e) => e.text).join(' ')).toMatch(/Relentless Endurance/);
    expect(pc().hp_current).toBe(1);
    expect(pc().conditions).not.toContain('unconscious');
    expect(pc().conditions).not.toContain('prone');
    expect(usedOf(id)).toBe(1);

    // The use is spent: the next blow that drops the Orc leaves them dying at 0.
    await goblinHits();
    expect(pc().hp_current).toBe(0);
    expect(pc().conditions).toContain('unconscious');
    expect(usedOf(id)).toBe(1);

    // A Short Rest does not give the use back; a Long Rest does, and the next fight it holds them up again.
    endEncounter(db, { campaign_id: campaignId, outcome: 'other' });
    heal(db, { campaign_id: campaignId, character_id: id, amount: 50 });
    rest(db, { campaign_id: campaignId, character_id: id, kind: 'short' });
    expect(usedOf(id)).toBe(1);
    rest(db, { campaign_id: campaignId, character_id: id, kind: 'long' });
    expect(usedOf(id)).toBe(0);
    await ambush();
    bloody(id);
    await goblinHits();
    expect(pc().hp_current).toBe(1);
    expect(usedOf(id)).toBe(1);
  });

  it('does nothing for an Orc killed outright', async () => {
    const id = await inFight('Orc');
    bloody(id);
    applyEffect(db, {
      campaign_id: campaignId,
      target_id: pc().id,
      name: 'Inferno',
      kind: 'damage',
      damage_expr: '60',
      damage_type: 'fire',
      tick: 'start',
      ends: 'manual',
    });
    await tickEffects(db, encounter(), pc().id, 'start');
    expect(pc().alive).toBe(false);
    expect(usedOf(id)).toBe(0);
  });

  it('gives a Human nothing', async () => {
    const id = await inFight('Human');
    bloody(id);
    await goblinHits();
    expect(pc().hp_current).toBe(0);
  });
});

// --- homebrew beside the registry ---------------------------------------------

describe('a homebrew trait beside the SRD species traits', () => {
  it("fires its own clause in a fight next to a Halfling's Brave, and the SRD handler does not take it over", async () => {
    const id = make('Halfling');
    // The DM's own "Brave", sharing the SRD trait's name: Advantage on Constitution saves.
    const entry = homebrewEntry('Brave', CON_ADVANTAGE);
    grantFeature(db, { campaign_id: campaignId, character_id: id, name: 'Brave', text: 'Brave', source: 'homebrew', mechanics: { homebrew_id: entry } });
    await ambush();
    const held = heldFeatures(combatSheet(db, id)).map((h) => h.handler.index);
    expect(held).toContain('brave');
    expect(held).toContain(`homebrew:${entry}`);
    // The clause runs on a Constitution save, and the SRD Brave on a save against Frightened.
    expect((await save('con')).advantage).toBe('advantage');
    expect((await save('wis', ['frightened'])).advantage).toBe('advantage');
    expect((await save('wis')).advantage).toBe('none');
  });

  it('leaves a homebrew species row named like an SRD trait to its own clauses', async () => {
    const id = make('Human');
    const entry = homebrewEntry('Brave', CON_ADVANTAGE);
    // A DM-written species trait: a species row that carries a homebrew id. No tool writes one yet.
    const row = db.prepare('SELECT features_json FROM character WHERE id = ?').get(id) as { features_json: string };
    const features = JSON.parse(row.features_json) as Array<Record<string, unknown>>;
    features.push({ name: 'Brave', source: 'species', text: 'Brave', mechanics: { homebrew_id: entry } });
    db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(JSON.stringify(features), id);
    await ambush();
    const held = heldFeatures(combatSheet(db, id)).map((h) => h.handler.index);
    expect(held).not.toContain('brave');
    expect(held).toContain(`homebrew:${entry}`);
    expect((await save('con')).advantage).toBe('advantage');
    expect((await save('wis', ['frightened'])).advantage).toBe('none');
  });
});
