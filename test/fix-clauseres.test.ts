// A homebrew feature with two limited clauses: each clause is its own counter and its own legal
// action. `resourceState` used to read every action against the first clause's resource, so the
// second lost its count and its entry; these tests hold the per-action reading in place.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import {
  createCharacter,
  grantFeature,
  spendFeatureResource,
  type CreateCharacterInput,
} from '../src/core/character.js';
import { clausesSchema, type ClauseInput } from '../src/core/mechanics.js';
import { saveHomebrew } from '../src/core/progression.js';
import { legalActions } from '../src/combat/actions.js';
import { classFeatures, featureActions } from '../src/combat/features.js';
import { combatSheet } from '../src/combat/sheet.js';
import { startEncounter } from '../src/combat/engine.js';
import { getBattleState, listCombatants, type Combatant } from '../src/combat/state.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;

/** A level 1 Fighter who can be handed homebrew, with no class resources to confuse the count. */
function make(): number {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Fighter',
    class: 'fighter',
    species: 'Human',
    background: 'Acolyte',
    ability_method: 'manual',
    abilities: { str: 14, dex: 14, con: 14, int: 10, wis: 12, cha: 10 },
    ability_bonuses: { cha: 1, wis: 1, int: 1 },
    skill_choices: ['athletics', 'perception', 'arcana'],
  } satisfies CreateCharacterInput).character!.id;
}

/** Writes the homebrew row and puts the feature it stands for on the sheet, returning the row id. */
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

const pc = (): Combatant =>
  listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.kind === 'pc')!;

/** A fight, so the legal-action list is the one the DM is offered, with the Action still open. */
async function ambush(): Promise<void> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: 1 }],
  });
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0 WHERE id = ?').run(pc().id);
}

/** The uses each of one feature's actions reports, in the order they are offered. */
const usesOfActions = (sheet: ReturnType<typeof combatSheet>, row: number): Array<number | null> =>
  featureActions(sheet)
    .filter((entry) => entry.action.id.startsWith(`homebrew_${row}_`))
    .map((entry) => entry.left);

const TWO_CLAUSES: ClauseInput[] = [
  { when: 'action', do: [{ kind: 'move_ft', amount: 10 }], uses: { per: 'long', count: 2 } },
  { when: 'action', do: [{ kind: 'move_ft', amount: 20 }], uses: { per: 'long', count: 3 } },
];

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, {
    name: 'Clause Resources',
    story_shape: 'sandbox',
    settings: { player_rolls: 'none' },
  }).campaign_id;
  Math.random = () => 0.5;
});

afterEach(() => {
  Math.random = realRandom;
  db.close();
});

describe('a homebrew feature with two limited clauses', () => {
  it('offers both actions, each with its own remaining uses', async () => {
    const id = make();
    const row = grant(id, 'Paired Reserve', TWO_CLAUSES);
    await ambush();
    const sheet = combatSheet(db, id);

    const offered = legalActions(pc(), sheet);
    const first = `feature:homebrew_${row}_0`;
    const second = `feature:homebrew_${row}_1`;
    expect(offered.map((action) => action.id)).toContain(first);
    expect(offered.map((action) => action.id)).toContain(second);
    expect(offered.find((action) => action.id === first)!.label).toMatch(/\(2 left\)/);
    expect(offered.find((action) => action.id === second)!.label).toMatch(/\(3 left\)/);
    expect(usesOfActions(sheet, row)).toEqual([2, 3]);
  });

  it('keeps the other count when one of them is spent', async () => {
    const id = make();
    const row = grant(id, 'Paired Reserve', TWO_CLAUSES);
    await ambush();

    spendFeatureResource(db, {
      campaign_id: campaignId,
      character_id: id,
      resource: `homebrew:${row}:1`,
      label: 'Paired Reserve #2',
      max: 3,
      per: 'long',
    });

    const sheet = combatSheet(db, id);
    expect(usesOfActions(sheet, row)).toEqual([2, 2]);
    const offered = legalActions(pc(), sheet);
    expect(offered.map((action) => action.id)).toContain(`feature:homebrew_${row}_0`);
    expect(offered.find((action) => action.id === `feature:homebrew_${row}_1`)!.label).toMatch(/\(2 left\)/);
  });
});

describe('a homebrew feature with one limited clause', () => {
  it('behaves as it did before: the use is on the action and the sheet row', async () => {
    const id = make();
    const row = grant(id, 'Solo Reserve', [TWO_CLAUSES[0]!]);
    await ambush();
    const sheet = combatSheet(db, id);

    const actionId = `feature:homebrew_${row}_0`;
    expect(legalActions(pc(), sheet).map((action) => action.id)).toContain(actionId);
    expect(legalActions(pc(), sheet).find((action) => action.id === actionId)!.label).toMatch(/\(2 left\)/);
    expect(usesOfActions(sheet, row)).toEqual([2]);

    const view = classFeatures(sheet).find((feature) => feature.name === 'Solo Reserve')!;
    expect(view.uses_left).toBe(2);
    expect(view.uses_max).toBe(2);
  });
});
