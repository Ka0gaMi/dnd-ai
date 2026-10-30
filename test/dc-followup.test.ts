// The A0b follow-up: a DC the DM wrote into a roll's purpose and the DC an effect's save is made against follow
// dc_disclosure on every player surface, and a house revolt that took land is listed once in world get.
import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEffect, startEncounter } from '../src/combat/engine.js';
import { getBattleState, listCombatants, type BattleState } from '../src/combat/state.js';
import { bus, type GameEvent } from '../src/core/bus.js';
import { createCampaign, type RollRecord } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { getPolitics } from '../src/core/politics-store.js';
import { importRegion } from '../src/core/region.js';
import {
  applyRollBoost,
  createPendingRoll,
  openPendingRolls,
  previewPendingRoll,
  resolvePendingRoll,
  type PendingRollRow,
} from '../src/core/rolls.js';
import { updateSettings } from '../src/core/settings.js';
import { ensureWorld } from '../src/core/world-seed.js';
import { currentGameDay, insertEvent } from '../src/core/world-store.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { resolvePendingRollsImmediately } from './helpers.js';
import { replyData } from './helpers/reply.js';

const medium = JSON.parse(readFileSync(new URL('./fixtures/realm-medium.json', import.meta.url), 'utf8')) as unknown;

const PURPOSE = 'Stealth check vs DC 15';

let db: Db;
let campaignId: number;
let events: GameEvent[];
let unsubscribe: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Follow-up', story_shape: 'sandbox' }).campaign_id;
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
  events = [];
  unsubscribe = bus.subscribe((event) => events.push(event));
});

afterEach(() => {
  unsubscribe();
});

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

interface Asked {
  /** The DM's roll reply, its text and the roll record its JSON carries. */
  text: string;
  structured: RollRecord;
  /** What the player's window fetched and was answered while the card was open. */
  listed: PendingRollRow[];
  previewed: RollRecord;
  resolved: RollRecord;
}

/** The DM asks the player for a roll whose purpose names its DC; the window lists, previews and clicks it. */
async function askWithDcInPurpose(): Promise<Asked> {
  updateSettings(db, campaignId, { cheat_mode: true });
  let listed: PendingRollRow[] = [];
  let previewed: RollRecord | undefined;
  let resolved: RollRecord | undefined;
  const click = bus.subscribe((event) => {
    if (event.kind !== 'pending_roll') return;
    const id = (event.payload as PendingRollRow).id;
    listed = openPendingRolls(db, campaignId);
    previewed = previewPendingRoll(db, id);
    resolved = resolvePendingRoll(db, id);
  });
  const client = await connect();
  try {
    const result = await client.callTool({
      name: 'roll',
      arguments: {
        campaign_id: campaignId,
        expr: '1d20+3',
        purpose: PURPOSE,
        dc: 15,
        roll_type: 'check',
        roller: 'player',
      },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? '').join('\n');
    const structured = replyData<RollRecord>(result);
    return { text, structured, listed, previewed: previewed!, resolved: resolved! };
  } finally {
    click();
    await client.close();
  }
}

const pushed = (kind: string): GameEvent[] => events.filter((event) => event.kind === kind);

describe('a DC the DM wrote into a roll purpose', () => {
  it('reaches no player surface while hidden, and stays in the DM reply and the stored roll', async () => {
    const asked = await askWithDcInPurpose();

    const card = pushed('pending_roll')[0]!;
    expect(card.text).toBe('Stealth check');
    expect((card.payload as PendingRollRow).purpose).toBe('Stealth check');
    expect(asked.listed.map((row) => row.purpose)).toEqual(['Stealth check']);
    expect(asked.previewed.purpose).toBe('Stealth check');
    expect(asked.resolved.purpose).toBe('Stealth check');
    const rolled = pushed('roll');
    expect(rolled).toHaveLength(1);
    expect(rolled[0]!.text).toMatch(/^Stealth check: /);
    expect(JSON.stringify(events)).not.toMatch(/DC 15/);

    expect(asked.structured).toMatchObject({ purpose: PURPOSE, dc: 15 });
    expect(asked.text).toContain(PURPOSE);
    expect(db.prepare('SELECT purpose, dc FROM roll').get()).toEqual({ purpose: PURPOSE, dc: 15 });
  });

  it('keeps the purpose whole on every player surface once the table shows DCs', async () => {
    updateSettings(db, campaignId, { dc_disclosure: 'shown' });
    const asked = await askWithDcInPurpose();

    const card = pushed('pending_roll')[0]!;
    expect(card.text).toMatch(/^Stealth check vs DC 15/);
    expect(card.payload).toMatchObject({ purpose: PURPOSE, dc: 15 });
    expect(asked.listed.map((row) => row.purpose)).toEqual([PURPOSE]);
    expect(asked.previewed.purpose).toBe(PURPOSE);
    expect(asked.resolved).toMatchObject({ purpose: PURPOSE, dc: 15 });
    expect(pushed('roll')[0]!.text).toMatch(/^Stealth check vs DC 15: /);
  });

  it('cuts it from the text pushed when the player takes a boost, while hidden', () => {
    const card = createPendingRoll(db, {
      campaign_id: campaignId,
      expr: '1d20+3',
      purpose: PURPOSE,
      dc: 15,
      roll_type: 'check',
      boosts_available: [
        {
          id: 'lucky-bell',
          name: 'Lucky Bell',
          describe: 'Advantage on one roll.',
          uses_left: 1,
          advantage: true,
          bonus: 0,
          label: 'Lucky Bell',
          max: 1,
          per: 'long',
          when: 'roll',
        },
      ],
    });
    const boosted = applyRollBoost(db, card.id, 'lucky-bell');

    expect(boosted.purpose).toBe('Stealth check');
    expect(pushed('pending_roll').map((event) => event.text)).toEqual(['Stealth check', 'Stealth check (Lucky Bell)']);
    expect(JSON.stringify(events)).not.toMatch(/DC 15/);
  });
});

describe("the DC an effect's save is made against", () => {
  /** A fight with one save-ended effect on the goblin, DC 14; the DM's own answer comes back. */
  async function dazedGoblin(): Promise<ReturnType<typeof applyEffect>> {
    const stopClicking = resolvePendingRollsImmediately(db);
    try {
      const started = await startEncounter(db, {
        campaign_id: campaignId,
        seed: 7,
        terrain: 'road',
        size: 'small',
        enemies: [{ creature: 'Goblin Warrior' }],
      });
      const goblin = listCombatants(db, started.encounter_id).find((c) => c.team === 'enemy')!;
      events = [];
      return applyEffect(db, {
        campaign_id: campaignId,
        target_id: goblin.id,
        name: 'Tolling daze',
        kind: 'buff',
        save_ability: 'wis',
        save_dc: 14,
        ends: 'save',
      });
    } finally {
      stopClicking();
    }
  }

  const pushedState = (): BattleState => (pushed('combat').at(-1)!.payload as { state: BattleState }).state;

  it('is null in the player battle state while hidden, and whole for the DM', async () => {
    const dm = await dazedGoblin();

    expect(getBattleState(db, campaignId)!.effects.map((e) => e.save_dc)).toEqual([null]);
    expect(pushedState().effects.map((e) => e.save_dc)).toEqual([null]);
    expect(getBattleState(db, campaignId, false)!.effects.map((e) => e.save_dc)).toEqual([14]);
    expect(dm.effect.save_dc).toBe(14);
    expect(dm.state.effects.map((e) => e.save_dc)).toEqual([14]);
  });

  it('is in the player battle state once the table shows DCs', async () => {
    updateSettings(db, campaignId, { dc_disclosure: 'shown' });
    await dazedGoblin();

    expect(getBattleState(db, campaignId)!.effects.map((e) => e.save_dc)).toEqual([14]);
    expect(pushedState().effects.map((e) => e.save_dc)).toEqual([14]);
  });
});

describe('a house revolt that took land, in world get', () => {
  it('is listed once, as a county transfer and not again as a recent event', async () => {
    importRegion(db, campaignId, medium, { source: 'generated' });
    ensureWorld(db, campaignId);
    const today = currentGameDay(db, campaignId);
    const politics = getPolitics(db, campaignId)!;
    const county = politics.counties[0]!;
    const crown = politics.realms.find((realm) => realm.id === county.realm_id)!;
    const lordship = politics.realms.find((realm) => realm.id !== county.realm_id)!;
    const event = (text: string, effects: Record<string, unknown>) =>
      insertEvent(db, campaignId, {
        day: today - 1,
        kind: 'agenda_won',
        text,
        severity: 4,
        place_id: null,
        faction_id: null,
        agenda_id: null,
        causes: [],
        effects,
        visibility: 'public',
      });
    // A revolt that only wrung concessions, beside one that took the house's seat as a lordship.
    event('House Tarn wrings concessions from its crown.', { outcome: 'concessions' });
    event(`House Vell wrings concessions from its crown and takes ${county.name} as a lordship under it.`, {
      outcome: 'concessions',
      county_id: county.id,
      from_realm_id: crown.id,
      to_realm_id: lordship.id,
      house_id: 1,
    });

    const client = await connect();
    const result = await client.callTool({ name: 'world', arguments: { campaign_id: campaignId, op: 'get' } });
    await client.close();
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    // The "- " item lines under a section title of the digest text.
    const section = (title: string): string[] => {
      const lines = text.split('\n');
      const start = lines.indexOf(title);
      const end = lines.findIndex((line, index) => index > start && !line.startsWith('- '));
      return start === -1 ? [] : lines.slice(start + 1, end === -1 ? undefined : end);
    };

    expect(section('County transfers:')).toEqual([
      `- day ${today - 1}: ${county.name} passes from ${crown.name} to ${lordship.name}`,
    ]);
    const recent = section('Recent world events:');
    expect(recent.some((line) => line.endsWith('): House Tarn wrings concessions from its crown.'))).toBe(true);
    expect(recent.join('\n')).not.toContain('House Vell');
    expect(text).not.toContain('House Vell');
    expect(text).toContain(`${county.name} passes from ${crown.name} to ${lordship.name}`);
  });
});
