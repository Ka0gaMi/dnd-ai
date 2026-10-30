// The scene-end compound call: checkpoint {op: save} writes facts, events, objectives and a play note
// with the save under one snapshot, refuses as a whole, and answers with a slim reply.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { rewindToCheckpoint } from '../src/core/rewind.js';
import { estimateTokens } from '../src/core/token-budget.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { replyData, replyText } from './helpers/reply.js';

/** The slim save reply's ceiling, in estimated tokens. */
const REPLY_CAP = 300;

type Row = Record<string, unknown>;

interface SaveReply {
  checkpoint_id: number;
  scene: { id: number; title: string | null; location: string | null };
  session: { id: number; number: number };
  applied: { facts: number; events: number; objectives: number; glossary: number; note: number };
  facts_skipped?: Array<{ subject: string; duplicate_of: number }>;
  open_quests: number;
  next_step: string;
}

let db: Db;

interface Seeded {
  campaignId: number;
  factId: number;
  questId: number;
  stepId: number;
}

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return replyData<T>(result);
}

const textOf = (result: { content: unknown }): string => (result.content as Array<{ text: string }>)[0]!.text;

async function makeCampaign(client: Client): Promise<number> {
  const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
    name: 'Compound',
    story_shape: 'sandbox',
  });
  return campaign_id;
}

/** Every row a scene end can write, so a refused call can be shown to have written nothing. */
function dump(campaignId: number): Record<string, Row[]> {
  const all = (sql: string): Row[] => db.prepare(sql).all(campaignId) as Row[];
  return {
    canon_fact: all('SELECT * FROM canon_fact WHERE campaign_id = ? ORDER BY id'),
    event: all('SELECT * FROM event WHERE campaign_id = ? ORDER BY id'),
    quest: all('SELECT * FROM quest WHERE campaign_id = ? ORDER BY id'),
    quest_step: all(
      'SELECT * FROM quest_step WHERE quest_id IN (SELECT id FROM quest WHERE campaign_id = ?) ORDER BY id',
    ),
    play_note: all('SELECT * FROM play_note WHERE campaign_id = ? ORDER BY id'),
    glossary_entry: all('SELECT * FROM glossary_entry WHERE campaign_id = ? ORDER BY id'),
    checkpoint: all('SELECT * FROM checkpoint WHERE campaign_id = ? ORDER BY id'),
    scene: all('SELECT * FROM scene WHERE campaign_id = ? ORDER BY id'),
    session: all('SELECT * FROM session WHERE campaign_id = ? ORDER BY id'),
    campaign: all('SELECT current_session_id, current_scene_id FROM campaign WHERE id = ?'),
  };
}

/** A campaign mid-session with a scene open, one known fact and one quest with a step, as a scene end would find it. */
async function seeded(client: Client): Promise<Seeded> {
  const campaignId = await makeCampaign(client);
  const opening = { op: 'save', campaign_id: campaignId, scene_summary: 'They met Mira at the ferry.' };
  await call(client, 'checkpoint', opening);
  const fact = await call<{ id: number }>(client, 'remember', {
    op: 'fact',
    campaign_id: campaignId,
    subject: 'Mira',
    fact: 'Mira keeps the ferry at Redham.',
  });
  const quests = await call<{ open_quests: Array<{ id: number; steps: Array<{ id: number }> }> }>(
    client,
    'update_objectives',
    { campaign_id: campaignId, quests: [{ title: 'Find the smuggler', steps: [{ text: 'Watch the docks' }] }] },
  );
  const quest = quests.open_quests[0]!;
  return { campaignId, factId: fact.id, questId: quest.id, stepId: quest.steps[0]!.id };
}

/** A full scene end: a superseding and a new fact, two events, a step ticked, a new quest, a term and a note. */
function sceneEnd(ids: Seeded): Record<string, unknown> {
  return {
    op: 'save',
    campaign_id: ids.campaignId,
    scene_title: 'The ford',
    scene_summary: 'They crossed the flooded ford on a raft of barrels; Mira was swept away by the current.',
    facts: [
      { subject: 'Mira', fact: 'Mira drowned in the flood at the ford.', supersedes_id: ids.factId },
      { subject: 'Ashfall Keep', fact: 'Ashfall Keep flies the black heron banner.' },
    ],
    events: [
      { kind: 'narration', text: 'They lashed barrels into a raft.' },
      { kind: 'loot', text: 'They pulled a silver key from the wreck.', payload: { item: 'silver key' } },
    ],
    objectives: [
      { id: ids.questId, title: 'Find the smuggler', steps: [{ id: ids.stepId, text: 'Watch the docks', done: true }] },
      { title: 'Bury Mira', kind: 'personal' },
    ],
    glossary: [{ term: 'Black heron', definition: 'The banner of Ashfall Keep.' }],
    note: { tags: ['improvise', 'environment'], text: 'Lashed barrels into a raft to cross the flood.' },
  };
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('checkpoint {op: save} as the scene-end compound call', () => {
  it('applies facts, events, objectives, glossary and a note with one save and one snapshot', async () => {
    const client = await connect();
    const ids = await seeded(client);
    const before = dump(ids.campaignId);

    const saved = await call<SaveReply>(client, 'checkpoint', sceneEnd(ids));
    expect(saved.applied).toEqual({ facts: 2, events: 2, objectives: 2, glossary: 1, note: 1 });
    expect(saved.facts_skipped).toBeUndefined();
    expect(saved.open_quests).toBe(2);
    const after = dump(ids.campaignId);

    // One save: one new checkpoint row and one checkpoint event, both for the scene just closed.
    expect(after.checkpoint.length).toBe(before.checkpoint.length + 1);
    expect(after.checkpoint.at(-1)).toMatchObject({ id: saved.checkpoint_id, scene_id: saved.scene.id });
    const isNew = (e: Row): boolean => !before.event.some((old) => old.id === e.id);
    const checkpointEvents = after.event.filter((e) => e.kind === 'checkpoint' && isNew(e));
    expect(checkpointEvents).toHaveLength(1);
    expect(db.prepare('SELECT summary, ended_at FROM scene WHERE id = ?').get(saved.scene.id)).toMatchObject({
      summary: expect.stringContaining('flooded ford'),
      ended_at: expect.any(String),
    });

    // Facts as remember writes them: the old one superseded, both new ones stamped with the closed scene.
    const oldFact = after.canon_fact.find((f) => f.id === ids.factId)!;
    const drowned = after.canon_fact.find((f) => f.fact === 'Mira drowned in the flood at the ford.')!;
    const banner = after.canon_fact.find((f) => f.subject === 'Ashfall Keep')!;
    expect(oldFact).toMatchObject({ active: 0, superseded_by: drowned.id });
    expect(drowned).toMatchObject({ active: 1, established_scene_id: saved.scene.id });
    expect(banner).toMatchObject({ active: 1, established_scene_id: saved.scene.id });

    // Events as log_event writes them, in the closed scene and before the checkpoint.
    const raft = after.event.find((e) => e.text === 'They lashed barrels into a raft.')!;
    const key = after.event.find((e) => e.text === 'They pulled a silver key from the wreck.')!;
    expect(raft).toMatchObject({ kind: 'narration', scene_id: saved.scene.id });
    expect(key).toMatchObject({ kind: 'loot', scene_id: saved.scene.id, payload_json: '{"item":"silver key"}' });
    expect(Number(key.id)).toBeLessThan(Number(checkpointEvents[0]!.id));

    // Objectives as update_objectives writes them.
    expect(after.quest_step.find((s) => s.id === ids.stepId)).toMatchObject({ done: 1 });
    expect(after.quest.find((q) => q.title === 'Bury Mira')).toMatchObject({ kind: 'personal', status: 'open' });

    // The note as note_play writes it, with its play_note event.
    expect(after.play_note).toHaveLength(1);
    expect(after.play_note[0]).toMatchObject({ scene_id: saved.scene.id, tags_json: '["improvise","environment"]' });
    const noteEvent = after.event.find((e) => e.kind === 'play_note')!;
    expect(Number(noteEvent.id)).toBeLessThan(Number(checkpointEvents[0]!.id));
    expect(after.glossary_entry.map((g) => g.term)).toContain('Black heron');

    // The one snapshot holds every part, so a rewind lands on the scene end as a whole.
    const snapshot = JSON.parse(String(after.checkpoint.at(-1)!.snapshot_json)) as { tables: Record<string, Row[]> };
    expect(snapshot.tables.canon_fact!.map((f) => f.fact)).toContain('Mira drowned in the flood at the ford.');
    expect(snapshot.tables.quest!.map((q) => q.title)).toContain('Bury Mira');

    // The briefing answers in rendered text, so the count is read off its events line.
    const shown = await client.callTool({ name: 'load_campaign', arguments: { campaign_id: ids.campaignId } });
    expect(shown.isError).toBeFalsy();
    expect(replyText(shown)).toContain('\nEvents since last checkpoint: 0.');
    await client.close();
  });

  /** One bad part on an otherwise good scene end, and what the refusal must name. */
  const spoiled: Array<[string, (ids: Seeded) => Record<string, unknown>, RegExp]> = [
    [
      'an unknown supersedes_id',
      () => ({ facts: [{ subject: 'Mira', fact: 'Mira lives.', supersedes_id: 9999 }] }),
      /facts\[0\]\.supersedes_id 9999/,
    ],
    [
      'one supersedes_id named by two facts',
      ({ factId }) => ({
        facts: [
          { subject: 'Mira', fact: 'Mira drowned in the flood at the ford.', supersedes_id: factId },
          { subject: 'Mira', fact: 'Mira swam ashore below the ford.', supersedes_id: factId },
        ],
      }),
      /facts\[1\]\.supersedes_id \d+ is already replaced by facts\[0\] \(merge the two into one fact\)/,
    ],
    [
      'an unknown objective id',
      () => ({ objectives: [{ id: 9999, title: 'Ghost quest' }] }),
      /objectives\[0\]\.id 9999/,
    ],
    [
      'an unknown quest step id',
      ({ questId }) => ({
        objectives: [{ id: questId, title: 'Find the smuggler', steps: [{ id: 9999, text: 'Nowhere', done: true }] }],
      }),
      /objectives\[0\]\.steps\[0\]\.id 9999/,
    ],
    [
      'an unknown note character',
      () => ({ note: { character_id: 9999, tags: ['stealth'], text: 'Hid.' } }),
      /note\.character_id 9999/,
    ],
    ['a play tag outside the list', () => ({ note: { tags: ['juggling'], text: 'Juggled.' } }), /note\.tags/],
  ];

  it.each(spoiled)('refuses the whole call and writes nothing for %s', async (_label, spoil, message) => {
    const client = await connect();
    const ids = await seeded(client);
    const before = dump(ids.campaignId);

    const refused = await client.callTool({ name: 'checkpoint', arguments: { ...sceneEnd(ids), ...spoil(ids) } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(message);
    expect(dump(ids.campaignId)).toEqual(before);
    await client.close();
  });

  it.each([
    ['canon_facts', [{ subject: 'Ashfall Keep', fact: 'Ashfall Keep flies the black heron banner.' }]],
    ['quest_updates', [{ title: 'Bury Mira', kind: 'personal' }]],
  ])('refuses an old %s from a stale tool list and writes nothing', async (oldKey, value) => {
    const client = await connect();
    const ids = await seeded(client);
    const before = dump(ids.campaignId);

    const refused = await client.callTool({ name: 'checkpoint', arguments: { ...sceneEnd(ids), [oldKey]: value } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe(
      'canon_facts was renamed to facts and quest_updates to objectives - the dnd-ai tools changed; reconnect the dnd-ai server (new chat, or /mcp then Reconnect) and send the save again. Nothing was saved.',
    );
    expect(dump(ids.campaignId)).toEqual(before);
    await client.close();
  });

  it('advertises neither old name in its description, and refuses them on op=end_session too', async () => {
    const client = await connect();
    const ids = await seeded(client);
    const before = dump(ids.campaignId);

    const description = (await client.listTools()).tools.find((t) => t.name === 'checkpoint')!.description!;
    expect(description).toMatch(/^op=save: .*; also .*facts, events, objectives, glossary, note\.$/m);
    expect(description).not.toMatch(/canon_facts|quest_updates/);

    const refused = await client.callTool({
      name: 'checkpoint',
      arguments: { op: 'end_session', campaign_id: ids.campaignId, quest_updates: [{ title: 'Bury Mira' }] },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^canon_facts was renamed to facts and quest_updates to objectives .* Nothing was saved\.$/);
    expect(dump(ids.campaignId)).toEqual(before);
    await client.close();
  });

  it('names every bad part in one refusal and says nothing was saved', async () => {
    const client = await connect();
    const ids = await seeded(client);
    const before = dump(ids.campaignId);

    const refused = await client.callTool({
      name: 'checkpoint',
      arguments: {
        ...sceneEnd(ids),
        facts: [{ subject: 'Mira', fact: 'Mira lives.', supersedes_id: 9999 }],
        objectives: [{ id: 8888, title: 'Ghost quest' }],
      },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe(
      'Refused, nothing was saved: facts[0].supersedes_id 9999 is not an active canon fact here (use an id from load_campaign); objectives[0].id 8888 is not a quest here (use an id from load_campaign, or leave id out to create one). Fix them and re-call checkpoint {op: save}.',
    );
    expect(dump(ids.campaignId)).toEqual(before);
    await client.close();
  });

  it('skips and reports a fact that restates a known one, as remember does, and saves the rest', async () => {
    const client = await connect();
    const ids = await seeded(client);

    const saved = await call<SaveReply>(client, 'checkpoint', {
      ...sceneEnd(ids),
      facts: [
        { subject: 'Mira', fact: 'Mira keeps the ferry at Redham.' },
        { subject: 'Ashfall Keep', fact: 'Ashfall Keep flies the black heron banner.' },
      ],
    });
    expect(saved.facts_skipped).toEqual([{ subject: 'Mira', duplicate_of: ids.factId }]);
    expect(saved.applied).toMatchObject({ facts: 1, events: 2, objectives: 2, note: 1 });
    expect(saved.next_step).toContain('supersedes_id');
    const facts = db.prepare('SELECT subject FROM canon_fact WHERE campaign_id = ? ORDER BY id').all(ids.campaignId);
    expect(facts).toEqual([{ subject: 'Mira' }, { subject: 'Ashfall Keep' }]);
    await client.close();
  });

  it(`answers in at most ${REPLY_CAP} tokens however long the session and the quest list grow`, async () => {
    const client = await connect();
    const ids = await seeded(client);
    const summary =
      'They crossed the flooded ford at dusk, lost a mule to the current, and reached the walled port of Redham where the harbourmaster turned them away until morning.';
    for (let scene = 1; scene <= 6; scene += 1) {
      await call(client, 'update_objectives', {
        campaign_id: ids.campaignId,
        quests: [
          {
            title: `Errand ${scene}`,
            summary: 'Find out who is smuggling silver through the harbour, and for whom.',
            steps: [{ text: 'Talk to the harbourmaster' }, { text: 'Watch the docks at night' }],
          },
        ],
      });
      await call(client, 'checkpoint', {
        op: 'save',
        campaign_id: ids.campaignId,
        scene_title: `Scene ${scene}`,
        scene_summary: summary,
      });
    }

    const result = await client.callTool({
      name: 'checkpoint',
      arguments: {
        ...sceneEnd(ids),
        scene_location: 'Redham',
        facts: [
          { subject: 'Mira', fact: 'Mira keeps the ferry at Redham.' },
          { subject: 'Ashfall Keep', fact: 'Ashfall Keep flies the black heron banner.' },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(estimateTokens(text)).toBeLessThanOrEqual(REPLY_CAP);
    // Neither the recap nor the quest list comes back; load_campaign carries them.
    expect(text).not.toContain('harbourmaster');
    expect(text).not.toContain('Errand');
    await client.close();
  });

  it('still saves a plain scene with nothing else', async () => {
    const client = await connect();
    const campaignId = await makeCampaign(client);

    const result = await client.callTool({
      name: 'checkpoint',
      arguments: {
        op: 'save',
        campaign_id: campaignId,
        scene_title: 'Arrival',
        scene_summary: 'They arrived at dusk.',
      },
    });
    expect(result.isError).toBeFalsy();
    const saved = replyData<SaveReply>(result);
    expect(saved.scene).toMatchObject({ title: 'Arrival', location: null });
    expect(saved.applied).toEqual({ facts: 0, events: 0, objectives: 0, glossary: 0, note: 0 });
    expect(saved.next_step).toContain('load_campaign');
    expect(estimateTokens(textOf(result))).toBeLessThanOrEqual(REPLY_CAP);
    const rows = db.prepare('SELECT id, scene_id FROM checkpoint WHERE campaign_id = ?').all(campaignId);
    expect(rows).toEqual([{ id: saved.checkpoint_id, scene_id: saved.scene.id }]);
    await client.close();
  });

  it('rewinds to the compound snapshot: later play is undone and the scene end stays', async () => {
    const client = await connect();
    const ids = await seeded(client);
    const saved = await call<SaveReply>(client, 'checkpoint', sceneEnd(ids));
    const atSave = dump(ids.campaignId);

    // Later play changes every table the scene end wrote.
    const burned = { op: 'fact', campaign_id: ids.campaignId, subject: 'Redham', fact: 'Redham burned.' };
    await call(client, 'remember', burned);
    const bury = atSave.quest.find((q) => q.title === 'Bury Mira')!;
    await call(client, 'update_objectives', {
      campaign_id: ids.campaignId,
      quests: [{ id: bury.id, title: 'Bury Mira', status: 'done' }, { title: 'Flee Redham' }],
    });
    await call(client, 'log_event', { campaign_id: ids.campaignId, kind: 'narration', text: 'The town caught fire.' });
    expect(dump(ids.campaignId).canon_fact).not.toEqual(atSave.canon_fact);

    const rewound = rewindToCheckpoint(db, ids.campaignId);
    expect(rewound.checkpoint_id).toBe(saved.checkpoint_id);
    const restored = dump(ids.campaignId);
    expect(restored.canon_fact).toEqual(atSave.canon_fact);
    expect(restored.quest).toEqual(atSave.quest);
    expect(restored.quest_step).toEqual(atSave.quest_step);
    expect(restored.glossary_entry).toEqual(atSave.glossary_entry);
    expect(restored.campaign).toEqual(atSave.campaign);
    // The scene end's own events stand; what came after is marked reverted.
    const revertedOf = db.prepare('SELECT reverted FROM event WHERE campaign_id = ? AND text = ?');
    const reverted = (text: string): unknown => (revertedOf.get(ids.campaignId, text) as Row).reverted;
    expect(reverted('They lashed barrels into a raft.')).toBe(0);
    expect(reverted('The town caught fire.')).toBe(1);
    await client.close();
  });
});
