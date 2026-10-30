// The duty registry and the one next step a reply carries: urgency order, the 120-character cap, and which replies get it.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, logEvent, setCharacterDraft } from '../src/core/campaign.js';
import { NEXT_STEP_CHARS, dueDuties, registerDuty, registeredDuties, topDuty, type Urgency } from '../src/core/duties.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';

type Reply = { content: Array<{ type: string; text?: string }>; isError?: boolean };

let db: Db;
let removals: Array<() => void>;

beforeEach(() => {
  db = openDb(':memory:');
  removals = [];
});

afterEach(() => {
  for (const remove of removals) remove();
});

/** A duty that speaks only for this test's campaign, removed again after the test. */
function testDuty(id: string, urgency: Urgency, campaignId: number, check?: () => never): void {
  removals.push(
    registerDuty({
      id,
      check: check ?? ((on, asked) => (on === db && asked === campaignId ? { urgency, text: `${id} {op: test}` } : null)),
    }),
  );
}

const campaign = (name = 'Duties'): number => createCampaign(db, { name, story_shape: 'sandbox' }).campaign_id;

function logEvents(campaignId: number, count: number): void {
  for (let i = 0; i < count; i += 1) logEvent(db, { campaign_id: campaignId, kind: 'narration', text: `Beat ${i}.` });
}

/** A level 1 fighter PC written straight to the table. */
function character(campaignId: number, fields: { xp?: number; hp_current?: number }): number {
  const now = new Date().toISOString();
  return Number(
    db
      .prepare(
        "INSERT INTO character (campaign_id, name, is_pc, class, level, xp, hp_current, hp_max, status, created_at, updated_at) VALUES (?, 'Ash', 1, 'Fighter', 1, ?, ?, 10, 'active', ?, ?)",
      )
      .run(campaignId, fields.xp ?? 0, fields.hp_current ?? 10, now, now).lastInsertRowid,
  );
}

/** An active fight; returns the encounter id. */
const encounter = (campaignId: number): number =>
  Number(
    db
      .prepare("INSERT INTO encounter (campaign_id, seed, map_json, started_at) VALUES (?, 1, '{}', ?)")
      .run(campaignId, new Date().toISOString()).lastInsertRowid,
  );

const endFight = (encounterId: number): void => {
  db.prepare("UPDATE encounter SET status = 'ended' WHERE id = ?").run(encounterId);
};

const ids = (campaignId: number): string[] => dueDuties(db, campaignId).map((d) => d.id);

describe('the duty registry', () => {
  it('orders due duties by urgency, ties in the order they were registered', () => {
    const id = campaign();
    testDuty('test_low', 1, id);
    testDuty('test_mid_a', 2, id);
    testDuty('test_high', 3, id);
    testDuty('test_mid_b', 2, id);
    expect(ids(id).filter((d) => d.startsWith('test_'))).toEqual(['test_high', 'test_mid_a', 'test_mid_b', 'test_low']);
    expect(topDuty(db, id)?.id).toBe('test_high');
    expect(topDuty(db, id, 3)?.text).toBe('test_high {op: test}');
  });

  it('answers null when nothing reaches the asked urgency', () => {
    const id = campaign();
    testDuty('test_mid', 2, id);
    expect(topDuty(db, id, 3)).toBeNull();
    expect(topDuty(db, id, 2)?.id).toBe('test_mid');
    expect(topDuty(db, campaign('Quiet'))).toBeNull();
  });

  it('skips a check that throws and still answers the rest', () => {
    const id = campaign();
    testDuty('test_broken', 3, id, () => {
      throw new Error('check failed');
    });
    testDuty('test_fine', 1, id);
    expect(() => dueDuties(db, id)).not.toThrow();
    expect(ids(id)).toContain('test_fine');
    expect(ids(id)).not.toContain('test_broken');
    expect(topDuty(db, id)?.id).toBe('test_fine');
  });

  it('refuses a second duty under the same id, and frees the id once removed', () => {
    const id = campaign();
    testDuty('test_once', 1, id);
    expect(() => registerDuty({ id: 'test_once', check: () => null })).toThrow(/already registered/);
    removals.pop()!();
    removals.push(registerDuty({ id: 'test_once', check: () => null }));
  });

  it(`keeps every registered duty's text within ${NEXT_STEP_CHARS} characters`, () => {
    // A character draft owed, many events since a save.
    const unwritten = campaign('Unwritten');
    setCharacterDraft(db, unwritten, { class: 'Wizard' });
    logEvents(unwritten, 30);
    // A PC with the XP for level 2, dying outside a fight.
    const dying = campaign('Dying');
    character(dying, { xp: 300, hp_current: 0 });

    const texts = new Map<string, string>();
    for (const id of [unwritten, dying]) for (const due of dueDuties(db, id)) texts.set(due.id, due.text);
    expect([...texts.keys()].sort()).toEqual(registeredDuties().map((d) => d.id).sort());
    const long = [...texts].filter(([, text]) => text.length > NEXT_STEP_CHARS);
    expect(long).toEqual([]);
  });
});

describe('the built-in duties', () => {
  it('owes a save after 25 events, but never during a fight', () => {
    const id = campaign();
    expect(ids(id)).not.toContain('checkpoint_overdue');
    logEvents(id, 30);
    expect(dueDuties(db, id).find((d) => d.id === 'checkpoint_overdue')).toMatchObject({ urgency: 2 });
    const fight = encounter(id);
    expect(ids(id)).toEqual([]);
    endFight(fight);
    expect(ids(id)).toEqual(['checkpoint_overdue']);
  });

  it('owes a level-up window until one is prepared, only with the XP for it', () => {
    const id = campaign();
    const pc = character(id, { xp: 299 });
    expect(ids(id)).toEqual([]);
    db.prepare('UPDATE character SET xp = 300 WHERE id = ?').run(pc);
    expect(topDuty(db, id)).toMatchObject({ id: 'level_up', urgency: 1 });
    expect(topDuty(db, id)?.text).toContain(`character_id: ${pc}`);
    db.prepare("UPDATE character SET pending_level_up_json = '{}' WHERE id = ?").run(pc);
    expect(ids(id)).toEqual([]);
  });

  it('owes death saves for a character dying outside a fight, not inside one or once stable', () => {
    const id = campaign();
    const pc = character(id, { hp_current: 0 });
    expect(topDuty(db, id, 3)).toMatchObject({ id: 'dying' });
    expect(topDuty(db, id)?.text).toContain(`character_id: ${pc}`);
    const fight = encounter(id);
    expect(ids(id)).toEqual([]);
    endFight(fight);
    db.prepare('UPDATE character SET stable = 1 WHERE id = ?').run(pc);
    expect(ids(id)).toEqual([]);
  });

  it('owes the character the player left to the DM until there is one', () => {
    const id = campaign();
    setCharacterDraft(db, id, { class: 'Wizard' });
    expect(topDuty(db, id, 3)).toMatchObject({ id: 'character_draft' });
    character(id, {});
    expect(ids(id)).toEqual([]);
  });
});

describe('the next step on a reply', () => {
  async function connect(): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'duties-test', version: '0.0.0' });
    await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  const call = async (client: Client, name: string, args: Record<string, unknown>): Promise<Reply> =>
    (await client.callTool({ name, arguments: args })) as unknown as Reply;

  const textOf = (reply: Reply): string => reply.content.map((c) => c.text ?? '').join('');

  const beat = (client: Client, campaign_id: number): Promise<Reply> =>
    call(client, 'log_event', { campaign_id, kind: 'narration', text: 'A beat.' });

  it('rides on a state-changing reply when a duty is due, once, and is absent when none is', async () => {
    const client = await connect();
    const id = campaign();
    const quiet = await beat(client, id);
    expect(quiet.content).toHaveLength(1);
    expect(textOf(quiet)).not.toContain('Next:');

    logEvents(id, 30);
    const due = textOf(await beat(client, id));
    expect(due).toMatch(/\n\nNext: checkpoint \{op: save\} - \d+ events since the last save\.$/);
    expect(due.split('checkpoint {op: save}')).toHaveLength(2);
    expect(due).not.toContain('Reminder');
    await client.close();
  });

  it('lists urgency 2 and up in the briefing, and leaves the list out when nothing is owed', async () => {
    const client = await connect();
    const id = campaign();
    expect(textOf(await call(client, 'load_campaign', { campaign_id: id }))).not.toContain('## Duties');
    logEvents(id, 30);
    const briefing = textOf(await call(client, 'load_campaign', { campaign_id: id }));
    expect(briefing).toMatch(/\n## Duties \(owed before you play on\)\n- checkpoint \{op: save\} - \d+ events since the last save\.\n/);
    await client.close();
  });

  it('rides on a read-only reply only at urgency 3', async () => {
    const client = await connect();
    const id = campaign();
    logEvents(id, 30);
    expect(textOf(await call(client, 'read_journal', { campaign_id: id }))).not.toContain('Next:');

    setCharacterDraft(db, id, { class: 'Wizard' });
    const read = textOf(await call(client, 'read_journal', { campaign_id: id }));
    expect(read).toMatch(/\n\nNext: create_character from the draft /);
    // The more urgent duty is the one shown, never both.
    const written = textOf(await beat(client, id));
    expect(written).toContain('\n\nNext: create_character');
    expect(written).not.toContain('checkpoint {op: save}');
    await client.close();
  });

  it('leaves an error reply alone, returned or thrown', async () => {
    const client = await connect();
    const id = campaign();
    setCharacterDraft(db, id, { class: 'Wizard' });
    expect(textOf(await beat(client, id))).toContain('\n\nNext: create_character');
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
    expect(textOf(thrown)).not.toContain('Next:');
    await client.close();
  });

  it('holds the save back while a fight is running', async () => {
    const client = await connect();
    const id = campaign();
    logEvents(id, 30);
    const fight = encounter(id);
    expect(textOf(await beat(client, id))).not.toContain('Next:');
    endFight(fight);
    expect(textOf(await beat(client, id))).toContain('\n\nNext: checkpoint {op: save}');
    await client.close();
  });
});
