// Audit: a pending combat roll keeps every advantage source, so a card boost re-nets the whole list
// instead of the single netted enum. An Advantage a Disadvantage had already cancelled stays cancelled.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attack, setCombatCondition, startEncounter } from '../src/combat/engine.js';
import { listCombatants } from '../src/combat/state.js';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, grantFeature } from '../src/core/character.js';
import { clausesSchema } from '../src/core/mechanics.js';
import { saveHomebrew } from '../src/core/progression.js';
import {
  applyRollBoost,
  getPendingRoll,
  openPendingRolls,
  resolvePendingRoll,
  rollBoosts,
  type PendingRollRow,
} from '../src/core/rolls.js';
import { openDb, type Db } from '../src/db/connection.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;

/** 0.041 pins every d20 to a natural 20, so an attack that is asked for always lands. */
const NAT_20 = 0.041;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Ask Player', story_shape: 'sandbox' }).campaign_id;
  createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
  Math.random = () => NAT_20;
});

afterEach(() => {
  Math.random = realRandom;
});

interface Fight {
  encounterId: number;
  pc: number;
  goblin: number;
}

/** Opens a fight with the PC next to one goblin, clicking the initiative asks on the player's behalf. */
async function fight(): Promise<Fight> {
  const stopClicking = resolvePendingRollsImmediately(db);
  const started = await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior' }],
  });
  stopClicking();
  const combatants = listCombatants(db, started.encounter_id);
  const pc = combatants.find((c) => c.kind === 'pc')!;
  const goblin = combatants.find((c) => c.team === 'enemy')!;
  db.prepare('UPDATE combatant SET x = 1, y = 5 WHERE id = ?').run(pc.id);
  db.prepare('UPDATE combatant SET x = 2, y = 5 WHERE id = ?').run(goblin.id);
  const order = listCombatants(db, started.encounter_id).findIndex((c) => c.id === pc.id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(order, started.encounter_id);
  return { encounterId: started.encounter_id, pc: pc.id, goblin: goblin.id };
}

/** The card the engine is waiting on right now; the chain moves on a microtask, so give it a moment. */
async function nextAsk(): Promise<PendingRollRow> {
  for (let tries = 0; tries < 100; tries += 1) {
    const open = openPendingRolls(db, campaignId);
    if (open.length > 0) return open[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The engine never asked the player to roll.');
}

/** The advantage sources the stored context kept, which is what a card boost re-nets. */
function storedSources(row: PendingRollRow): string[] {
  const context = JSON.parse(row.context_json ?? '{}') as { advantage_sources?: string[] };
  return context.advantage_sources ?? [];
}

/** The attack's damage card, rolled after the d20, so the waiting attack call settles. */
async function resolveDamage(): Promise<void> {
  const damage = await nextAsk();
  resolvePendingRoll(db, damage.id);
}

/** The combatant id of the player character in a fight. */
const characterIdOf = (encounterId: number, combatantId: number): number =>
  listCombatants(db, encounterId).find((c) => c.id === combatantId)!.character_id!;

/** A once-a-long-rest attack boost the player chooses on their card: one Advantage, no flat bonus. */
function grantAttackAdvantage(characterId: number): void {
  const entry = saveHomebrew(db, {
    campaign_id: campaignId,
    kind: 'feature',
    name: 'Opening Gambit',
    schema: {
      name: 'Opening Gambit',
      text: 'Opening Gambit',
      clauses: clausesSchema.parse([
        {
          when: 'roll',
          if: { kind: 'attack' },
          do: [{ kind: 'advantage' }],
          uses: { per: 'long', count: 1 },
          decide: 'ask_before',
        },
      ]),
    },
  });
  grantFeature(db, {
    campaign_id: campaignId,
    character_id: characterId,
    name: 'Opening Gambit',
    source: 'homebrew',
    text: 'Opening Gambit',
    mechanics: { homebrew_id: entry.id },
  });
}

/** One Advantage and one Disadvantage on the attack: a restrained target, and a poisoned attacker. */
function advantageAndDisadvantage(pc: number, goblin: number): void {
  setCombatCondition(db, { campaign_id: campaignId, combatant_id: goblin, condition: 'restrained', active: true });
  setCombatCondition(db, { campaign_id: campaignId, combatant_id: pc, condition: 'poisoned', active: true });
}

describe('a combat card keeps every advantage source', () => {
  it('stays a flat d20 when a card Advantage meets an already-cancelled Disadvantage', async () => {
    const { encounterId, pc, goblin } = await fight();
    grantAttackAdvantage(characterIdOf(encounterId, pc));
    advantageAndDisadvantage(pc, goblin);

    const running = attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: goblin,
      action_name: 'Greatsword',
    });
    const card = await nextAsk();
    // The two sources cancel in the column already, but both are stored for the next netting.
    expect(card.advantage).toBe('none');
    expect(storedSources(card)).toEqual(['disadvantage', 'advantage']);

    const boost = rollBoosts(card).boosts_available[0]!;
    const boosted = applyRollBoost(db, card.id, boost.id);
    // Advantage plus Disadvantage still cancel, however many Advantages there are.
    expect(boosted.advantage).toBe('none');
    expect(resolvePendingRoll(db, card.id).expr).toMatch(/^1d20[+-]/);
    await resolveDamage();
    await running;
  });

  it('resolves to Advantage when no Disadvantage source is on the roll', async () => {
    const { encounterId, pc, goblin } = await fight();
    grantAttackAdvantage(characterIdOf(encounterId, pc));
    // Only the target's restrained condition: one Advantage, nothing to cancel it.
    setCombatCondition(db, { campaign_id: campaignId, combatant_id: goblin, condition: 'restrained', active: true });

    const running = attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: goblin,
      action_name: 'Greatsword',
    });
    const card = await nextAsk();
    expect(card.advantage).toBe('advantage');

    const boost = rollBoosts(card).boosts_available[0]!;
    const boosted = applyRollBoost(db, card.id, boost.id);
    expect(boosted.advantage).toBe('advantage');
    expect(resolvePendingRoll(db, card.id).expr).toMatch(/^2d20kh1[+-]/);
    await resolveDamage();
    await running;
  });

  it('ships the d20 context sources on the card, not just the netted value', async () => {
    const { encounterId, pc, goblin } = await fight();
    grantAttackAdvantage(characterIdOf(encounterId, pc));
    advantageAndDisadvantage(pc, goblin);

    const running = attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: goblin,
      action_name: 'Greatsword',
    });
    const card = await nextAsk();
    expect(storedSources(card)).toEqual(['disadvantage', 'advantage']);
    expect(getPendingRoll(db, card.id)!.advantage).toBe('none');
    resolvePendingRoll(db, card.id);
    await resolveDamage();
    await running;
  });
});
