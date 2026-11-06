// Undoing a combat call takes back the Heroic Inspiration that call changed, never one spent or granted after it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, grantFeature, grantInspiration, spendInspiration } from '../src/core/character.js';
import { clausesSchema, type ClauseInput } from '../src/core/mechanics.js';
import { saveHomebrew } from '../src/core/progression.js';
import { openDb, type Db } from '../src/db/connection.js';
import { advanceTurn, attack, startEncounter, undoLastCombatAction, useAction } from '../src/combat/engine.js';
import { activeEncounter, getBattleState, listCombatants, type Combatant } from '../src/combat/state.js';
import { underSnapshot } from '../src/combat/undo.js';

let db: Db;
let campaignId: number;
let characterId: number;
const realRandom = Math.random;
const MISS = { total: 3, natural: 2 };
const HIT = { total: 30, natural: 15 };

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, {
    name: 'Undo',
    story_shape: 'sandbox',
    settings: { player_rolls: 'none' },
  }).campaign_id;
  characterId = createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  }).character!.id;
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
});

const inspiration = (): number =>
  (db.prepare('SELECT inspiration FROM character WHERE id = ?').get(characterId) as { inspiration: number }).inspiration;
const setInspiration = (value: number): void => {
  db.prepare('UPDATE character SET inspiration = ? WHERE id = ?').run(value, characterId);
};
const combatants = (): Combatant[] => listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
const pc = (): Combatant => combatants().find((c) => c.kind === 'pc')!;
const foe = (): Combatant => combatants().find((c) => c.team === 'enemy')!;
const undoRows = (): number =>
  (
    db
      .prepare('SELECT COUNT(*) AS n FROM combat_undo WHERE encounter_id = ?')
      .get(getBattleState(db, campaignId)!.encounter.id) as { n: number }
  ).n;

const giveTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === id),
    state.encounter.id,
  );
};

/** Borg and one goblin side by side, Borg to act. */
async function fight(): Promise<void> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: 1 }],
  });
  db.prepare('UPDATE combatant SET x = 1, y = 5 WHERE id = ?').run(pc().id);
  db.prepare('UPDATE combatant SET x = 2, y = 5, hp_max = 200, hp_current = 200 WHERE id = ?').run(foe().id);
  giveTurn(pc().id);
}

const swing = (roll: { total: number; natural: number }) =>
  attack(db, { campaign_id: campaignId, attacker_id: pc().id, target_id: foe().id, action_name: 'Greatsword', roll });

/** Writes the homebrew row and puts the feature it stands for on Borg's sheet. */
function grant(name: string, clauses: ClauseInput[]): number {
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

describe('undo and an Inspiration moved outside the combat call', () => {
  it('keeps an Inspiration spent on a reroll after the attack it takes back', async () => {
    await fight();
    setInspiration(1);

    // The act-run order: the swing misses, the player spends Inspiration, the DM undoes the miss and swings again.
    expect((await swing(MISS)).hit).toBe(false);
    spendInspiration(db, { campaign_id: campaignId, note: '2 -> 15' });
    expect(inspiration()).toBe(0);

    expect(undoLastCombatAction(db, campaignId).undone).toBe('attack');
    expect(pc().action_used).toBe(false);
    expect(inspiration()).toBe(0);

    expect((await swing(HIT)).hit).toBe(true);
    expect(inspiration()).toBe(0);
  });

  it('keeps an Inspiration granted after the call it takes back', async () => {
    await fight();
    setInspiration(0);
    await swing(MISS);
    grantInspiration(db, { campaign_id: campaignId });

    expect(undoLastCombatAction(db, campaignId).undone).toBe('attack');
    expect(pc().action_used).toBe(false);
    expect(inspiration()).toBe(1);
  });

  it('leaves a spend between two calls alone when both are undone', async () => {
    await fight();
    setInspiration(1);
    await swing(MISS);
    spendInspiration(db, { campaign_id: campaignId });
    db.prepare('UPDATE combatant SET action_used = 0 WHERE id = ?').run(pc().id);
    await swing(MISS);

    expect(undoLastCombatAction(db, campaignId).undone).toBe('attack');
    expect(undoLastCombatAction(db, campaignId).undone).toBe('attack');
    expect(pc().action_used).toBe(false);
    expect(inspiration()).toBe(0);
  });
});

describe('undo and an Inspiration the combat call itself granted', () => {
  it('takes back the Inspiration a feature action granted (use_action)', async () => {
    const id = grant('Rallying Shout', [{ when: 'action', do: [{ kind: 'grant_inspiration' }] }]);
    await fight();
    setInspiration(0);

    await useAction(db, { campaign_id: campaignId, actor_id: pc().id, action_name: `homebrew_${id}_0` });
    expect(inspiration()).toBe(1);

    expect(undoLastCombatAction(db, campaignId).undone).toBe('use_action');
    expect(inspiration()).toBe(0);
  });

  it('takes back the Inspiration a turn-start feature granted (advance_turn)', async () => {
    grant('Battle Thrill', [{ when: 'turn_start', do: [{ kind: 'grant_inspiration' }] }]);
    await fight();
    setInspiration(0);
    giveTurn(foe().id);
    const onTurn = getBattleState(db, campaignId)!.turn_index;

    await advanceTurn(db, campaignId);
    const state = getBattleState(db, campaignId)!;
    expect(state.combatants[state.turn_index]!.id).toBe(pc().id);
    expect(inspiration()).toBe(1);

    expect(undoLastCombatAction(db, campaignId).undone).toBe('advance_turn');
    expect(getBattleState(db, campaignId)!.turn_index).toBe(onTurn);
    expect(inspiration()).toBe(0);
  });
});

describe('a refused combat call', () => {
  it('costs nothing, the Inspiration it spent before refusing included', async () => {
    await fight();
    setInspiration(1);
    const encounter = activeEncounter(db, campaignId)!;
    const rows = undoRows();

    expect(() =>
      underSnapshot(db, encounter, 'use_action', () => {
        spendInspiration(db, { campaign_id: campaignId });
        throw new Error('refused');
      }),
    ).toThrow('refused');
    expect(inspiration()).toBe(1);
    expect(undoRows()).toBe(rows);

    await expect(
      underSnapshot(db, encounter, 'attack', async () => {
        spendInspiration(db, { campaign_id: campaignId });
        await Promise.resolve();
        throw new Error('refused later');
      }),
    ).rejects.toThrow('refused later');
    expect(inspiration()).toBe(1);
    expect(undoRows()).toBe(rows);
  });
});

describe('an undo row written before the post-call Inspiration was kept', () => {
  it('still undoes, putting the sheet back whole as it always did', async () => {
    await fight();
    setInspiration(1);
    await swing(MISS);
    const row = db
      .prepare('SELECT id, snapshot_json FROM combat_undo WHERE encounter_id = ? ORDER BY id DESC LIMIT 1')
      .get(getBattleState(db, campaignId)!.encounter.id) as { id: number; snapshot_json: string };
    const snapshot = JSON.parse(row.snapshot_json) as Record<string, unknown>;
    expect(snapshot.inspiration_after).toEqual({ [characterId]: 1 });
    delete snapshot.inspiration_after;
    db.prepare('UPDATE combat_undo SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(snapshot), row.id);
    spendInspiration(db, { campaign_id: campaignId });

    expect(undoLastCombatAction(db, campaignId).undone).toBe('attack');
    expect(pc().action_used).toBe(false);
    expect(inspiration()).toBe(1);
  });
});
