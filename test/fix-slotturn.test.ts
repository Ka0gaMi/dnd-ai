// The one-slot-a-turn rule the Quickened Spell flag never enforced, and the spent homebrew clause
// that use_action used to resolve into a silent no-op instead of refusing it by name.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, createCompanion, grantFeature } from '../src/core/character.js';
import { clausesSchema, type ClauseInput } from '../src/core/mechanics.js';
import { saveHomebrew } from '../src/core/progression.js';
import { openDb, type Db } from '../src/db/connection.js';
import { advanceTurn, startEncounter, useAction } from '../src/combat/engine.js';
import { combatSheet } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, type BattleState } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';

let db: Db;
let campaignId: number;
let borgId: number;
const realRandom = Math.random;

function makeCampaign(database: Db): number {
  const id = createCampaign(database, { name: 'Slots', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
    .campaign_id;
  borgId = createCharacter(database, {
    campaign_id: id,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  }).character!.id;
  return id;
}

/** A level 5 wizard with the slots and the spell list this file needs, set straight on the row. */
function makeWizard(slots: Record<string, { max: number; used: number }> = { '1': { max: 4, used: 0 }, '3': { max: 3, used: 0 } }): number {
  const id = createCompanion(db, {
    campaign_id: campaignId,
    name: 'Zel',
    source: { class: 'Wizard', species: 'Human', background: 'Sage' },
  }).companion!.id;
  db.prepare('UPDATE character SET level = 5, spells_json = ?, spell_slots_json = ?, inventory_json = ? WHERE id = ?').run(
    JSON.stringify({
      cantrips: ['Fire Bolt'],
      known: ['Fireball', 'Healing Word', "Hunter's Mark"],
      prepared: ['Fireball', 'Healing Word', "Hunter's Mark"],
      save_dc: 14,
      attack_bonus: 6,
    }),
    JSON.stringify(slots),
    JSON.stringify([]),
    id,
  );
  return id;
}

/** Gives the wizard the Favored Enemy counter, so Hunter's Mark is a casting that pays no slot. */
function grantFavoredEnemy(characterId: number): void {
  const row = db.prepare('SELECT features_json FROM character WHERE id = ?').get(characterId) as { features_json: string };
  const features = JSON.parse(row.features_json) as Array<Record<string, unknown>>;
  features.push({ name: 'Favored Enemy', source: 'class', mechanics: { resource: 'favored_enemies', max: 2, per: 'long' } });
  db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(JSON.stringify(features), characterId);
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
  db.prepare("UPDATE combatant SET hp_max = 200, hp_current = 200 WHERE team = 'enemy'").run();
  return getBattleState(db, campaignId)!;
}

const ids = (): { zel: number; enemy: number[] } => {
  const combatants = listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
  return {
    zel: combatants.find((c) => c.name === 'Zel')!.id,
    enemy: combatants.filter((c) => c.team === 'enemy').map((c) => c.id),
  };
};

const place = (id: number, x: number, y: number): void => {
  db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, id);
};

/** Puts the turn on the caster without touching the once-a-turn flags, like a turn mid-way through. */
const startTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?').run(id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === id),
    state.encounter.id,
  );
};

/** A real next turn: advance until it is theirs again, so the engine's own turn edge clears the flags. */
const newTurn = async (id: number): Promise<void> => {
  const order = getBattleState(db, campaignId)!.combatants;
  for (let step = 0; step <= order.length; step += 1) {
    await advanceTurn(db, campaignId);
    const state = getBattleState(db, campaignId)!;
    if (state.combatants[state.encounter.turn_index]?.id === id) break;
  }
};

const slotsOf = (id: number): Record<string, { max: number; used: number }> => combatSheet(db, id).spell_slots;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = makeCampaign(db);
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('one spell slot a turn', () => {
  it('refuses a second spell that would spend a slot, names the rule and costs nothing', async () => {
    const wizardId = makeWizard();
    await ambush();
    const { zel, enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 3, 5);
    startTurn(zel);

    // A bonus-action slot first, so the Action is still open for the second cast.
    await useAction(db, { campaign_id: campaignId, actor_id: zel, action_name: 'Healing Word', spell: 'Healing Word', target_id: zel });
    expect(slotsOf(wizardId)['1']).toEqual({ max: 4, used: 1 });

    await expect(
      useAction(db, { campaign_id: campaignId, actor_id: zel, action_name: 'Fireball', spell: 'Fireball', target_id: enemy[0]! }),
    ).rejects.toThrow(/already expended a spell slot this turn, and a turn allows only one: Fireball has to wait for their next turn/);
    // The refused cast cost nothing: the second slot is untouched and the next turn can still pay it.
    expect(slotsOf(wizardId)['3']).toEqual({ max: 3, used: 0 });
  });

  it('keeps a casting that pays no slot open, so one slot is still available after it', async () => {
    const wizardId = makeWizard();
    grantFavoredEnemy(wizardId);
    await ambush();
    const { zel, enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 3, 5);
    startTurn(zel);

    // Hunter's Mark through Favored Enemy: a level 1 spell the feature pays for with no slot.
    const free = await useAction(db, {
      campaign_id: campaignId,
      actor_id: zel,
      action_name: "Hunter's Mark",
      spell: "Hunter's Mark",
      target_id: enemy[0]!,
    });
    expect(free.log.some((entry) => entry.kind === 'spell_slot')).toBe(false);

    // The one slot of the turn is still there, because the free cast never touched it.
    await useAction(db, { campaign_id: campaignId, actor_id: zel, action_name: 'Fireball', spell: 'Fireball', target_id: enemy[0]! });
    expect(slotsOf(wizardId)['3']).toEqual({ max: 3, used: 1 });
  });

  it('allows any number of cantrips, which spend nothing however many are cast', async () => {
    const wizardId = makeWizard();
    await ambush();
    const { zel, enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 6, 5);
    startTurn(zel);
    for (let cast = 0; cast < 3; cast += 1) {
      const bolt = await useAction(db, {
        campaign_id: campaignId,
        actor_id: zel,
        action_name: 'Fire Bolt',
        spell: 'Fire Bolt',
        target_id: enemy[0]!,
        roll: { total: 22, natural: 16 },
      });
      expect(bolt.log.some((entry) => entry.kind === 'spell_slot')).toBe(false);
      if (cast < 2) startTurn(zel); // Same turn, its Action handed back: only the slot rule could stop us.
    }
    expect(slotsOf(wizardId)['1']).toEqual({ max: 4, used: 0 });
    expect(slotsOf(wizardId)['3']).toEqual({ max: 3, used: 0 });
  });

  it('lets the second spell go on the next turn', async () => {
    const wizardId = makeWizard();
    await ambush();
    const { zel, enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 3, 5);
    startTurn(zel);

    await useAction(db, { campaign_id: campaignId, actor_id: zel, action_name: 'Fireball', spell: 'Fireball', target_id: enemy[0]! });
    expect(slotsOf(wizardId)['3']).toEqual({ max: 3, used: 1 });

    await newTurn(zel);
    await useAction(db, { campaign_id: campaignId, actor_id: zel, action_name: 'Fireball', spell: 'Fireball', target_id: enemy[0]! });
    expect(slotsOf(wizardId)['3']).toEqual({ max: 3, used: 2 });
  });

  it("lets a reaction spell answer an attack on someone else's turn after a cast on your own", async () => {
    const wizardId = makeWizard();
    await ambush();
    const { zel, enemy } = ids();
    place(zel, 1, 5);
    place(enemy[0]!, 3, 5);
    startTurn(zel);

    await useAction(db, { campaign_id: campaignId, actor_id: zel, action_name: 'Fireball', spell: 'Fireball', target_id: enemy[0]! });
    expect(slotsOf(wizardId)['3']).toEqual({ max: 3, used: 1 });

    // The goblin's turn is a different turn, so the wizard has expended nothing on it.
    await advanceTurn(db, campaignId);
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: zel,
      action_name: 'Shield',
      spell: 'Shield',
      out_of_turn: true,
      reason: 'hit by an attack',
    });
    expect(slotsOf(wizardId)['1']!.used).toBe(1);
  });
});

describe('a spent homebrew clause', () => {
  /** Writes the homebrew row and puts the feature it stands for on the sheet. */
  function grant(characterId: number, name: string, clauses: ClauseInput[]): number {
    const entry = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'feature',
      name,
      schema: { name, text: name, clauses: clausesSchema.parse(clauses) },
    });
    grantFeature(db, {
      campaign_id: campaignId,
      character_id: characterId,
      name,
      text: name,
      source: 'homebrew',
      mechanics: { homebrew_id: entry.id },
    });
    return entry.id;
  }

  const usesOf = (characterId: number, feature: string): { max?: number; used?: number } =>
    (
      JSON.parse(
        (db.prepare('SELECT features_json FROM character WHERE id = ?').get(characterId) as { features_json: string })
          .features_json,
      ) as Array<{ name: string; mechanics?: { max?: number; used?: number } }>
    ).find((f) => f.name === feature)?.mechanics ?? {};

  it('is refused by name on a second attempt instead of resolving into a silent no-op', async () => {
    const id = grant(borgId, 'Measured Step', [
      { when: 'action', do: [{ kind: 'move_ft', amount: 10 }], uses: { per: 'long', count: 1 } },
    ]);
    await ambush();
    const borg = listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.kind === 'pc')!;
    startTurn(borg.id);
    const actionId = `homebrew_${id}_0`;

    await useAction(db, { campaign_id: campaignId, actor_id: borg.id, action_name: actionId });
    expect(usesOf(borgId, 'Measured Step').used).toBe(1);
    // Out of uses, it is off the list the DM builds the offer from.
    expect(getBattleState(db, campaignId)!.legal_actions.some((a) => a.id === `feature:${actionId}`)).toBe(false);

    // Hand the Action back, so the only thing that can refuse the second attempt is the spent use.
    startTurn(borg.id);
    await expect(useAction(db, { campaign_id: campaignId, actor_id: borg.id, action_name: actionId })).rejects.toThrow(
      /Measured Step/,
    );
    // A refused call costs nothing.
    expect(usesOf(borgId, 'Measured Step').used).toBe(1);
    const after = listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === borg.id)!;
    expect(after.action_used).toBe(false);
  });
});
