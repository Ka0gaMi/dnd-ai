// Audit: a pending roll keeps every advantage source, so a Disadvantage an earlier cancellation removed
// can still cancel a later Advantage instead of being folded away into one netted enum.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import {
  addItem,
  checkModifier,
  createCharacter,
  equipItem,
  grantFeature,
  type CreateCharacterInput,
} from '../src/core/character.js';
import { clausesSchema, type ClauseInput } from '../src/core/mechanics.js';
import { saveHomebrew } from '../src/core/progression.js';
import {
  applyRollBoost,
  createPendingRoll,
  getPendingRoll,
  openPendingRolls,
  resolvePendingRoll,
  rollBoosts,
  type PendingRollRow,
} from '../src/core/rolls.js';
import { createGameServer } from '../src/mcp/server.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Advsrc', story_shape: 'sandbox' }).campaign_id;
});

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function makePc(): number {
  const id = createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  } as CreateCharacterInput).character!.id;
  // The class's starting kit may already wear loud armour; a test puts on exactly what it needs.
  db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run('[]', id);
  return id;
}

/** Chain Mail is loud: the armour table sets Disadvantage on Stealth. */
function wearChainMail(characterId: number): void {
  addItem(db, { campaign_id: campaignId, character_id: characterId, name: 'Chain Mail', qty: 1 });
  equipItem(db, { campaign_id: campaignId, character_id: characterId, name: 'Chain Mail', equipped: true });
}

function grant(characterId: number, name: string, clauses: ClauseInput[]): void {
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
}

/** A once-a-long-rest boost the player chooses on their card: one Advantage, no flat bonus. */
const stealthAdvantage: ClauseInput[] = [
  {
    when: 'roll',
    if: { kind: 'check', skill: ['stealth'] },
    do: [{ kind: 'advantage' }],
    uses: { per: 'long', count: 1 },
    decide: 'ask_before',
  },
];

/** The advantage sources the stored context kept, as the fix writes them. */
function storedSources(row: PendingRollRow): string[] {
  const context = JSON.parse(row.context_json ?? '{}') as { advantage_sources?: string[] };
  return context.advantage_sources ?? [];
}

/** The card the roll tool is waiting on right now. */
async function openCard(): Promise<PendingRollRow> {
  for (let tries = 0; tries < 100; tries += 1) {
    const open = openPendingRolls(db, campaignId);
    if (open.length > 0) return open[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The roll tool never asked the player.');
}

/**
 * Runs the roll tool against the card it pushes, hands the card to the test and cleans up: an
 * unanswered card is resolved so the waiting call always settles rather than running to its timeout.
 */
async function withStealthCard<T>(id: number, body: (card: PendingRollRow) => T, extra: Record<string, unknown> = {}): Promise<T> {
  const client = await connect();
  const running = client.callTool({
    name: 'roll',
    arguments: { campaign_id: campaignId, character_id: id, purpose: 'Stealth check', skill: 'stealth', roller: 'player', ...extra },
  });
  const card = await openCard();
  try {
    return await body(card);
  } finally {
    if (getPendingRoll(db, card.id)?.resolved_at === null) resolvePendingRoll(db, card.id);
    await running.catch(() => undefined);
    await client.close();
  }
}

describe('a pending roll keeps every advantage source', () => {
  it('cancels loud-armour Disadvantage against two Advantage boosts to a flat d20', async () => {
    const id = makePc();
    wearChainMail(id);
    grant(id, 'Catlike', stealthAdvantage);
    grant(id, 'Shadowstep', stealthAdvantage);

    await withStealthCard(id, (card) => {
      const boosts = rollBoosts(card).boosts_available;
      expect(boosts).toHaveLength(2);

      applyRollBoost(db, card.id, boosts[0]!.id);
      applyRollBoost(db, card.id, boosts[1]!.id);
      const afterBoth = getPendingRoll(db, card.id)!;
      // Two Advantages and one Disadvantage cancel, however many of each.
      expect(afterBoth.advantage).toBe('none');

      const rolled = resolvePendingRoll(db, card.id);
      expect(rolled.expr).toMatch(/^1d20[+-]/);
      // The armour's Disadvantage is a source of the roll, not something the netted column alone carries.
      expect(storedSources(card)).toEqual(['disadvantage']);
      expect(storedSources(afterBoth)).toEqual(['disadvantage', 'advantage', 'advantage']);
    });
  });

  it('still cancels one Disadvantage and one Advantage', async () => {
    const id = makePc();
    wearChainMail(id);
    grant(id, 'Catlike', stealthAdvantage);

    await withStealthCard(id, (card) => {
      const boost = rollBoosts(card).boosts_available[0]!;
      const boosted = applyRollBoost(db, card.id, boost.id);
      expect(boosted.advantage).toBe('none');
      expect(resolvePendingRoll(db, card.id).expr).toMatch(/^1d20[+-]/);
    });
  });

  it('keeps a Disadvantage the creation-time netting had already cancelled', async () => {
    const id = makePc();
    wearChainMail(id);
    grant(id, 'Catlike', stealthAdvantage);

    // The DM grants Advantage; with the loud armour the column is netted to none, but both sources stay stored.
    await withStealthCard(
      id,
      (card) => {
        expect(getPendingRoll(db, card.id)!.advantage).toBe('none');
        expect(storedSources(card)).toEqual(['advantage', 'disadvantage']);
        const boost = rollBoosts(card).boosts_available[0]!;
        // The armour's Disadvantage still cancels the boosted Advantage: a flat d20, not Advantage.
        expect(applyRollBoost(db, card.id, boost.id).advantage).toBe('none');
        expect(resolvePendingRoll(db, card.id).expr).toMatch(/^1d20[+-]/);
      },
      { advantage: 'advantage' },
    );
  });

  it('gives Advantage when two Advantages and no Disadvantage are on the roll', async () => {
    const id = makePc();
    grant(id, 'Catlike', stealthAdvantage);
    grant(id, 'Shadowstep', stealthAdvantage);

    await withStealthCard(id, (card) => {
      const boosts = rollBoosts(card).boosts_available;
      applyRollBoost(db, card.id, boosts[0]!.id);
      const boosted = applyRollBoost(db, card.id, boosts[1]!.id);
      expect(boosted.advantage).toBe('advantage');
      expect(resolvePendingRoll(db, card.id).expr).toMatch(/^2d20kh1[+-]/);
    });
  });

  it('seeds the source list from the stored enum on a row written before the change', () => {
    const id = makePc();
    wearChainMail(id);
    grant(id, 'Catlike', stealthAdvantage);
    grant(id, 'Shadowstep', stealthAdvantage);
    const modifier = checkModifier(db, campaignId, id, { skill: 'stealth' });
    const boosts = modifier.boosts_available!;
    // The shape a pre-change row has: the netted enum, and a context with no source list.
    const legacy = createPendingRoll(db, {
      campaign_id: campaignId,
      character_id: id,
      expr: `1d20+${modifier.total_modifier}`,
      purpose: 'Stealth check',
      roll_type: 'check',
      advantage: 'disadvantage',
      boosts_available: boosts,
    });
    expect(storedSources(legacy)).toEqual([]);

    applyRollBoost(db, legacy.id, boosts[0]!.id);
    const second = applyRollBoost(db, legacy.id, boosts[1]!.id);
    // The stored enum started the list, so two later Advantages still cancel the one Disadvantage.
    expect(second.advantage).toBe('none');
    expect(storedSources(second)).toEqual(['disadvantage', 'advantage', 'advantage']);
  });
});
