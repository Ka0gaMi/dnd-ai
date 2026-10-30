// Open kinds (owner decision 2026-10-06): a catalogue field is a plain string in tools/list, and a value outside the
// catalogue is refused while the call is parsed, naming the nearest valid one, so the refusal writes nothing.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Tool } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { upsertEntity } from '../src/core/codex.js';
import { PLAY_TAGS } from '../src/core/progression.js';
import { estimateTokens } from '../src/core/token-budget.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { openKind } from '../src/mcp/tools/op.js';

type Reply = { content: Array<{ type: string; text?: string }>; isError?: boolean };

/** Each converted field's tools/list tokens on 4a59431, while it was still a z.enum. */
const ENUM_TOKENS: Array<[tool: string, field: string, tokens: number]> = [
  ['note_play', 'tags', 58],
  ['entity', 'type', 52],
  ['use_action', 'free_cast', 82],
  ['use_action', 'transmute_to', 41],
  ['attack', 'cunning_strike', 66],
  ['attack', 'brutal_strike', 86],
];

const messageOf = (schema: ReturnType<typeof openKind>, value: unknown): string | undefined =>
  schema.safeParse(value).error?.issues[0]?.message;

describe('openKind', () => {
  it('refuses a value outside the catalogue with the nearest valid one and the whole short list', () => {
    expect(messageOf(openKind('play tag', PLAY_TAGS), 'stealthy')).toBe(
      `No play tag "stealthy". Did you mean stealth? Re-call with one of: ${PLAY_TAGS.join(', ')}.`,
    );
  });

  it.each([
    ['ruler', 'rules'],
    ['member', 'member_of'],
    ['Knock Out', 'knock_out'],
    ['forceful_blow', 'forceful'],
  ])('reads %s as a near miss for %s', (typed, nearest) => {
    const kind = openKind('kind', ['member_of', 'rules', 'serves', 'knock_out', 'forceful', 'hamstring']);
    expect(messageOf(kind, typed)).toContain(`Did you mean ${nearest}? Re-call with one of: member_of, rules,`);
  });

  it('offers no guess when nothing is close, and still lists every value', () => {
    expect(messageOf(openKind('play tag', PLAY_TAGS), 'xyzzy')).toBe(
      `No play tag "xyzzy". Re-call with one of: ${PLAY_TAGS.join(', ')}.`,
    );
  });

  it('names only the nearest past a short list', () => {
    const many = Array.from({ length: 25 }, (_, i) => `kind_${i + 1}`);
    const message = messageOf(openKind('kind', many), 'kind_3x');
    expect(message).toBe('No kind "kind_3x". Did you mean kind_3? Re-call with a kind from the list its description names.');
  });

  it('passes a valid value through unchanged', () => {
    expect(openKind('play tag', PLAY_TAGS).parse('stealth')).toBe('stealth');
  });
});

describe('open kinds on the tool surface', () => {
  let db: Db;
  let client: Client;
  let tools: Tool[];
  let campaign_id: number;
  let character_id: number;

  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> =>
    (await client.callTool({ name, arguments: args })) as unknown as Reply;
  const textOf = (reply: Reply): string => reply.content.map((c) => c.text ?? '').join('');
  const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  beforeAll(async () => {
    db = openDb(':memory:');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'open-kinds-test', version: '0.0.0' });
    await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
    tools = (await client.listTools()).tools;
    campaign_id = createCampaign(db, { name: 'Open kinds', story_shape: 'sandbox' }).campaign_id;
    character_id = createCharacter(db, {
      campaign_id,
      name: 'Vex',
      species: 'Human',
      class: 'Rogue',
      background: 'Criminal',
      ability_method: 'standard_array',
      abilities: { str: 8, dex: 15, con: 14, int: 13, wis: 12, cha: 10 },
      ability_bonuses: { dex: 2, int: 1 },
      skill_choices: ['acrobatics', 'perception', 'persuasion', 'athletics', 'survival'],
    }).character!.id;
  });

  afterAll(async () => {
    await client.close();
  });

  it('lists each converted field as a described plain string, smaller than its enum was', () => {
    for (const [tool, field, before] of ENUM_TOKENS) {
      const schema = (tools.find((t) => t.name === tool)?.inputSchema.properties as Record<string, unknown>)[field];
      const json = JSON.stringify(schema);
      expect(json, `${tool}.${field}`).not.toContain('"enum"');
      expect(json, `${tool}.${field}`).toContain('"description"');
      expect(estimateTokens(json), `${tool}.${field}`).toBeLessThan(before);
    }
  });

  it('refuses an unknown play tag with the nearest one and writes nothing, then takes a valid tag as before', async () => {
    const [notes, events] = [count('play_note'), count('event')];
    const refused = await call('note_play', { campaign_id, character_id, tags: ['stealth', 'stealthy'], text: 'Slipped past.' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('tags.1: No play tag "stealthy". Did you mean stealth? Re-call with one of: improvise,');
    expect([count('play_note'), count('event')]).toEqual([notes, events]);

    const taken = await call('note_play', { campaign_id, character_id, tags: ['stealth'], text: 'Slipped past.' });
    expect(taken.isError).toBeFalsy();
    expect(count('play_note')).toBe(notes + 1);
  });

  it('refuses an unknown relationship type before linking, then links a valid one', async () => {
    upsertEntity(db, { campaign_id, kind: 'npc', name: 'Mira' });
    upsertEntity(db, { campaign_id, kind: 'faction', name: 'Ash Court' });
    const link = { op: 'link', campaign_id, from: 'Mira', to: 'Ash Court' };

    const refused = await call('entity', { ...link, type: 'member' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('type: No relationship type "member". Did you mean member_of? Re-call with one of: parent,');
    expect(count('relationship')).toBe(0);

    expect((await call('entity', { ...link, type: 'member_of' })).isError).toBeFalsy();
    expect(count('relationship')).toBe(1);
  });

  it('refuses unknown combat feature kinds as the call is parsed, and lets valid ones through to the engine', async () => {
    const swing = { campaign_id, attacker_id: 1, target_id: 2, action_name: 'Greataxe' };
    const cast = { campaign_id, actor_id: 1, action_name: 'Fire Bolt' };
    const refusals: Array<[string, Record<string, unknown>, string]> = [
      ['attack', { ...swing, brutal_strike: 'forceful_blow' }, 'No Brutal Strike effect "forceful_blow". Did you mean forceful?'],
      ['attack', { ...swing, brutal_strike: ['hamstring', 'sundring'] }, 'No Brutal Strike effect "sundring". Did you mean sundering?'],
      ['attack', { ...swing, cunning_strike: ['knock out'] }, 'No Cunning Strike effect "knock out". Did you mean knock_out?'],
      ['use_action', { ...cast, transmute_to: 'Fire' }, 'No Transmuted Spell damage type "Fire". Did you mean fire?'],
      ['use_action', { ...cast, free_cast: 'signature_spells' }, 'No free_cast feature "signature_spells". Did you mean signature_spell?'],
    ];
    for (const [tool, args, text] of refusals) expect(textOf(await call(tool, args))).toContain(text);

    const valid: Array<[string, Record<string, unknown>]> = [
      ['attack', { ...swing, brutal_strike: 'forceful' }],
      ['attack', { ...swing, brutal_strike: ['hamstring', 'sundering'] }],
      ['attack', { ...swing, cunning_strike: ['knock_out', 'poison'] }],
      ['use_action', { ...cast, transmute_to: 'fire' }],
      ['use_action', { ...cast, free_cast: 'signature_spell' }],
    ];
    // No encounter is running, so the engine refuses each; what matters is that parsing let it through.
    for (const [tool, args] of valid) expect(textOf(await call(tool, args))).toContain('has no active encounter');
  });
});
