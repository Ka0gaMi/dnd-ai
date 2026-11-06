// A DM's own words for the number a roll must reach ("needs 12", "beat 14", "12 or better") follow dc_disclosure
// the way "DC 12" does: cut from what the player's dice panel reads while hidden, ordinary numbers left alone.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { namesTarget, scrub } from '../src/combat/log-view.js';
import { bus, type GameEvent } from '../src/core/bus.js';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import type { PendingRollRow } from '../src/core/rolls.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { resolvePendingRollsImmediately } from './helpers.js';

const TACTICAL_MIND = "Tactical Mind: 1d10 added to Bram's failed Intimidation (total 3, needs 12)";

describe('scrub', () => {
  it.each([
    [TACTICAL_MIND, "Tactical Mind: 1d10 added to Bram's failed Intimidation (total 3)"],
    ['Intimidation (needs 12)', 'Intimidation'],
    ['Persuasion, need 12', 'Persuasion'],
    ['Persuasion (needs a 12)', 'Persuasion'],
    ['Athletics: need a 13 or better', 'Athletics'],
    ['Stealth, needs 12+', 'Stealth'],
    ['Stealth (12 or better)', 'Stealth'],
    ['Stealth (a 12 or higher, total 9)', 'Stealth (total 9)'],
    ['Climb the wall to beat 12', 'Climb the wall'],
    ['Lockpicking (target 15)', 'Lockpicking'],
    ['Arcana - target number 14', 'Arcana'],
    ['Needs 12: Insight', 'Insight'],
    ['Perception (needs 12 on the d20, total 3)', 'Perception (total 3)'],
    ['Save (needs 12 to succeed)', 'Save'],
    ['Bram needs DC 12', 'Bram'],
    ['Arcana (total 3; needs 12, then Persuasion)', 'Arcana (total 3, then Persuasion)'],
    ['Wisdom save (total 3, DC 12)', 'Wisdom save (total 3)'],
  ])('cuts the target number out of "%s"', (text, expected) => {
    expect(scrub(text)).toBe(expected);
    expect(namesTarget(text)).toBe(true);
    expect(namesTarget(expected)).toBe(false);
  });

  it.each([
    'Stealth check',
    'He needs two hands',
    'Bram needs a rest',
    'the 3 goblins',
    'Damage: 1d10',
    'total 3',
    'Attack +5',
    'Counterspell against a level 3 spell',
    'Dispel Magic: a spell of level 4 or higher',
    '3 successes',
    'needs 2 more successes',
    'needs 1d6',
    'needs 2 or more allies',
    'an 18 or better on one counting as a 20',
    'beat 3 of them',
  ])('leaves "%s" as it is', (text) => {
    expect(scrub(text)).toBe(text);
    expect(namesTarget(text)).toBe(false);
  });
});

describe('a player roll whose purpose names the number needed', () => {
  let db: Db;
  let campaignId: number;
  let events: GameEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    db = openDb(':memory:');
    campaignId = createCampaign(db, { name: 'Tactical Mind', story_shape: 'sandbox' }).campaign_id;
    createCharacter(db, {
      campaign_id: campaignId,
      name: 'Bram',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
    });
    events = [];
    unsubscribe = bus.subscribe((event) => events.push(event));
  });

  afterEach(() => {
    unsubscribe();
  });

  /** The DM asks the player for the Tactical Mind die; the window clicks the card as soon as it arrives. */
  async function rollTacticalMind(): Promise<{ card: PendingRollRow; rollText: string }> {
    const click = resolvePendingRollsImmediately(db);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'roll',
        arguments: { campaign_id: campaignId, roller: 'player', expr: '1d10', purpose: TACTICAL_MIND },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      click();
      await client.close();
    }
    const card = events.find((event) => event.kind === 'pending_roll')!.payload as PendingRollRow;
    const rollText = events.find((event) => event.kind === 'roll')!.text;
    return { card, rollText };
  }

  it('reaches the window without the number while DCs are hidden, and the stored roll keeps it', async () => {
    const { card, rollText } = await rollTacticalMind();

    expect(card.purpose).toBe("Tactical Mind: 1d10 added to Bram's failed Intimidation (total 3)");
    expect(rollText).toMatch(/^Tactical Mind: 1d10 added to Bram's failed Intimidation \(total 3\): /);
    expect(JSON.stringify(events)).not.toContain('needs 12');
    expect(db.prepare('SELECT purpose FROM roll').pluck().get()).toBe(TACTICAL_MIND);
  });

  it('keeps the number once the table shows DCs', async () => {
    updateSettings(db, campaignId, { dc_disclosure: 'shown' });
    const { card, rollText } = await rollTacticalMind();

    expect(card.purpose).toBe(TACTICAL_MIND);
    expect(rollText.startsWith(`${TACTICAL_MIND}: `)).toBe(true);
  });
});
