// The mode line on replies: the table's state and its calls on a change of mode only, and the replies it leaves alone.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertCombatant } from '../src/combat/state.js';
import { createCampaign, saveCheckpoint, setCharacterDraft } from '../src/core/campaign.js';
import { estimateTokens } from '../src/core/token-budget.js';
import { openDb, type Db } from '../src/db/connection.js';
import { MODE_CALLS, modeLine, tableMode } from '../src/mcp/mode.js';
import { createGameServer } from '../src/mcp/server.js';
import { resolvePendingRollsImmediately } from './helpers.js';

type Reply = { content: Array<{ type: string; text?: string }>; isError?: boolean };

const LONG = 'Bartholomew Aurelius Thistlewood-Vanderhaven the Unconquered';

let db: Db;
let stopClicking: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  stopClicking = resolvePendingRollsImmediately(db);
});

afterEach(() => {
  stopClicking();
});

const campaign = (name = 'Mode'): number => createCampaign(db, { name, story_shape: 'sandbox' }).campaign_id;

/** A level 1 fighter PC written straight to the table. */
function pc(campaignId: number, name = 'Ash'): number {
  const now = new Date().toISOString();
  return Number(
    db
      .prepare(
        "INSERT INTO character (campaign_id, name, is_pc, class, level, xp, hp_current, hp_max, status, created_at, updated_at) VALUES (?, ?, 1, 'Fighter', 1, 0, 10, 10, 'active', ?, ?)",
      )
      .run(campaignId, name, now, now).lastInsertRowid,
  );
}

/** A fight in `round` with `name` up second in the order; returns the encounter and the combatant that is up. */
function fight(campaignId: number, round = 3, name = 'Sera'): { encounter: number; up: number } {
  const encounter = Number(
    db
      .prepare("INSERT INTO encounter (campaign_id, seed, map_json, started_at, round, turn_index) VALUES (?, 1, '{}', ?, ?, 1)")
      .run(campaignId, new Date().toISOString(), round).lastInsertRowid,
  );
  const base = { encounter_id: encounter, x: 0, y: 0, size: 'M' as const, hp_current: 7, hp_max: 7, ac: 13, speed: 30 };
  insertCombatant(db, { ...base, kind: 'monster', name: 'Goblin', team: 'enemy', initiative_order: 0 });
  const up = insertCombatant(db, { ...base, kind: 'pc', name, team: 'party', initiative_order: 1 });
  return { encounter, up };
}

const endFight = (encounterId: number): void => {
  db.prepare("UPDATE encounter SET status = 'ended' WHERE id = ?").run(encounterId);
};

const prepareLevelUp = (characterId: number): void => {
  db.prepare('UPDATE character SET pending_level_up_json = ? WHERE id = ?').run(JSON.stringify({ to_level: 2 }), characterId);
};

const PLAY = `Mode: play — calls: ${MODE_CALLS.play}.`;

describe('the mode a table is in', () => {
  it('reads combat, level-up, creation and play from the state already kept', () => {
    const id = campaign();
    expect(tableMode(db, id)).toEqual({ mode: 'creation', header: 'creation' });
    setCharacterDraft(db, id, { class: 'Wizard' });
    expect(tableMode(db, id).mode).toBe('creation');

    const ash = pc(id);
    expect(tableMode(db, id)).toEqual({ mode: 'play', header: 'play' });
    saveCheckpoint(db, { campaign_id: id, scene_summary: 'They reach the inn.', scene_location: 'The Rusty Anchor' });
    expect(tableMode(db, id)).toEqual({ mode: 'play', header: 'play · The Rusty Anchor' });

    prepareLevelUp(ash);
    expect(tableMode(db, id)).toEqual({ mode: 'level-up', header: `level-up · Ash #${ash} to level 2` });

    const { encounter, up } = fight(id);
    expect(tableMode(db, id)).toEqual({ mode: 'combat', header: `combat · r3 · Sera #${up} up` });
    endFight(encounter);
    expect(tableMode(db, id).mode).toBe('level-up');
  });

  it('keeps every header within 20 tokens and every mode line within 45, however long the names', () => {
    const id = campaign();
    const ash = pc(id, LONG);
    saveCheckpoint(db, { campaign_id: id, scene_summary: 'On the road.', scene_location: `${LONG}'s Abandoned Watchtower` });
    const states = [tableMode(db, id)];
    prepareLevelUp(ash);
    states.push(tableMode(db, id));
    fight(id, 120, LONG);
    const empty = campaign('Empty');
    states.push(tableMode(db, id), tableMode(db, empty));
    expect(states.map((s) => s.mode)).toEqual(['play', 'level-up', 'combat', 'creation']);
    for (const { mode, header } of states) {
      expect(estimateTokens(header)).toBeLessThanOrEqual(20);
      expect(estimateTokens(`Mode: ${header} — calls: ${MODE_CALLS[mode]}.`)).toBeLessThanOrEqual(45);
    }
    for (const campaignId of [id, empty]) {
      const line = modeLine(db, campaignId, true)!;
      expect(line).not.toContain('\n');
      expect(estimateTokens(line)).toBeLessThanOrEqual(45);
    }
  });

  it('answers only on a change of mode, per campaign, and whenever asked fresh', () => {
    const id = campaign();
    const other = campaign('Other');
    pc(id);
    expect(modeLine(db, id)).toBe(PLAY);
    expect(modeLine(db, id)).toBeNull();
    expect(modeLine(db, other)).toBe(`Mode: creation — calls: ${MODE_CALLS.creation}.`);
    expect(modeLine(db, id, true)).toBe(PLAY);
    expect(modeLine(db, id)).toBeNull();
  });

  it('names no calls on entering a fight, and stays quiet while it runs, until asked fresh', () => {
    const id = campaign();
    pc(id);
    modeLine(db, id);
    const { encounter, up } = fight(id);
    expect(modeLine(db, id)).toBe(`Mode: combat · r3 · Sera #${up} up.`);
    db.prepare('UPDATE encounter SET round = 4 WHERE id = ?').run(encounter);
    expect(modeLine(db, id)).toBeNull();
    expect(modeLine(db, id, true)).toBe(`Mode: combat · r4 · Sera #${up} up — calls: ${MODE_CALLS.combat}.`);
    endFight(encounter);
    expect(modeLine(db, id)).toBe(PLAY);
  });

  it('drops the line, never throws, when the mode cannot be read', () => {
    const id = campaign();
    db.close();
    expect(modeLine(db, id)).toBeNull();
    expect(modeLine(db, id, true)).toBeNull();
  });
});

describe('the mode line on a reply', () => {
  async function connect(): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'mode-line-test', version: '0.0.0' });
    await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  const call = async (client: Client, name: string, args: Record<string, unknown>): Promise<Reply> =>
    (await client.callTool({ name, arguments: args })) as unknown as Reply;

  const textOf = (reply: Reply): string => reply.content.map((c) => c.text ?? '').join('');

  let beats = 0;
  const beat = (client: Client, campaign_id: number): Promise<Reply> =>
    // Each beat is new text: an identical write within 10 s would be answered as a duplicate retry.
    call(client, 'log_event', { campaign_id, kind: 'narration', text: `Beat ${(beats += 1)}.` });

  it('closes a reply that changes the mode, read or write, and no other, remembered across servers', async () => {
    const id = campaign();
    pc(id);
    const client = await connect();
    const read = await call(client, 'read_journal', { campaign_id: id });
    expect(read.content).toHaveLength(1);
    expect(textOf(read).endsWith(`\n\n${PLAY}`)).toBe(true);
    expect(textOf(await beat(client, id))).not.toContain('Mode:');
    await client.close();

    // HTTP builds a server per request; the next one still knows the mode was shown.
    const next = await connect();
    expect(textOf(await beat(next, id))).not.toContain('Mode:');
    const { encounter, up } = fight(id);
    expect(textOf(await beat(next, id)).endsWith(`\n\nMode: combat · r3 · Sera #${up} up.`)).toBe(true);
    expect(textOf(await beat(next, id))).not.toContain('Mode:');
    endFight(encounter);
    expect(textOf(await beat(next, id)).endsWith(`\n\n${PLAY}`)).toBe(true);
    await next.close();
  });

  it('puts the mode line just before the Next line, a blank line apart', async () => {
    const id = campaign();
    setCharacterDraft(db, id, { class: 'Wizard' });
    const client = await connect();
    const text = textOf(await beat(client, id));
    expect(text).toMatch(
      new RegExp(`\\n\\nMode: creation — calls: ${MODE_CALLS.creation}\\.\\n\\nNext: create_character from the draft [^\\n]+$`),
    );
    expect(text.split('Mode:')).toHaveLength(2);
    const quiet = textOf(await beat(client, id));
    expect(quiet).not.toContain('Mode:');
    expect(quiet).toMatch(/\n\nNext: create_character from the draft [^\n]+$/);
    await client.close();
  });

  it('leaves an error reply alone, returned or thrown', async () => {
    const id = campaign();
    const client = await connect();
    const refused = await call(client, 'condition', {
      campaign_id: id,
      op: 'set',
      condition: 'prone',
      active: true,
      duration_rounds: 2,
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe('duration_rounds only applies to a combatant in a fight; pass combatant_id, or leave duration_rounds out.');
    const thrown = await call(client, 'hp', { campaign_id: id, op: 'heal', character_id: 9999, amount: 1 });
    expect(thrown.isError).toBe(true);
    expect(textOf(thrown)).not.toContain('Mode:');
    // Neither refusal counted as showing the mode.
    expect(textOf(await beat(client, id))).toContain('Mode: creation');
    await client.close();
  });

  it('ends every load_campaign briefing with the line and its calls, and leaves read_guide bare', async () => {
    const id = campaign();
    pc(id);
    const client = await connect();
    for (let i = 0; i < 2; i += 1) {
      const text = textOf(await call(client, 'load_campaign', { campaign_id: id }));
      expect(text.endsWith(`\n\n${PLAY}`)).toBe(true);
      expect(text.split('Mode:')).toHaveLength(2);
    }
    const stale = textOf(await call(client, 'load_campaign', { campaign_id: id, tools_hash: '0000beef' }));
    expect(stale.startsWith('STALE TOOLS')).toBe(true);
    expect(stale.endsWith(`\n\n${PLAY}`)).toBe(true);
    expect(textOf(await call(client, 'read_guide', { section: 'story' }))).not.toContain('Mode:');
    await client.close();
  });

  it('gives start_encounter the header alone, after its turn-loop pointer', async () => {
    const id = campaign();
    const client = await connect();
    await call(client, 'create_character', {
      campaign_id: id,
      name: 'Borg',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
    });
    await beat(client, id);
    const started = await call(client, 'start_encounter', {
      campaign_id: id,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior', count: 2 }],
    });
    expect(started.isError).toBeFalsy();
    const blocks = textOf(started).split('\n\n');
    const mode = blocks.pop()!;
    expect(mode).toMatch(/^Mode: combat · r1 · .+ #\d+ up\.$/);
    expect(blocks.join('\n\n').trimEnd().split('\n').pop()).toContain('read_guide {section: "combat", topic: "turn-loop"}');
    await client.close();
  });
});
