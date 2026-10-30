import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Tool } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCampaign, loadCampaign } from '../src/core/campaign.js';
import { getSettings, updateSettings } from '../src/core/settings.js';
import {
  CLAUDE_DESCRIPTION_CHARS,
  CLAUDE_REPLY_CHARS,
  CORE_COMBAT_TOOLS,
  FIELD_DESCRIPTION_CHARS,
  OP_LINE_CHARS,
  OPS_PER_TOOL,
  REPEATED_SUBSCHEMA_CHARS,
  REPEATED_SUBSCHEMA_RATCHET,
  TOOL_COUNT,
  TOOL_DESCRIPTION_CHARS,
  TOOL_RATCHETS,
  TOOL_TOKEN_EXCEPTIONS,
  TOOL_TOKENS,
  TOOL_TOKENS_COMBAT,
  TOOLS_LIST_PLAN_MAX,
  TOOLS_LIST_RATCHET,
  TOOLS_LIST_TARGET,
  estimateTokens,
  type SurfaceMetric,
} from '../src/core/token-budget.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { renderBriefing, toolSurfaceHash } from '../src/mcp/tools/campaign.js';
import { GUIDE_SECTIONS } from '../src/mcp/tools/guide.js';

type Reply = { content: Array<{ type: string; text?: string }>; isError?: boolean };

let db: Db;

async function connect(server = createGameServer(db)): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'surface-budget-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown>): Promise<Reply> =>
  (await client.callTool({ name, arguments: args })) as unknown as Reply;

const textOf = (reply: Reply): string => reply.content.map((c) => c.text ?? '').join('');

/** The longest description of any field, at any depth of a JSON schema. */
function longestField(schema: unknown): number {
  let longest = 0;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const props = (node as { properties?: Record<string, { description?: string }> }).properties;
    if (props && !Array.isArray(node)) {
      for (const field of Object.values(props)) longest = Math.max(longest, field?.description?.length ?? 0);
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(schema);
  return longest;
}

/** One tool's size on every per-tool cap. */
function measure(tool: Tool): Record<SurfaceMetric, number> & { ops: number } {
  const description = tool.description ?? '';
  const opLines = description.split('\n').filter((line) => line.startsWith('op='));
  const op = (tool.inputSchema.properties as Record<string, { enum?: unknown[] }> | undefined)?.op;
  return {
    tokens: estimateTokens(JSON.stringify(tool)),
    description: description.length,
    op_line: Math.max(0, ...opLines.map((line) => line.length)),
    field: longestField(tool.inputSchema),
    ops: op?.enum?.length ?? 0,
  };
}

const capFor = (tool: string, metric: SurfaceMetric): number =>
  ({
    tokens: TOOL_TOKEN_EXCEPTIONS[tool]?.tokens ?? (CORE_COMBAT_TOOLS.includes(tool) ? TOOL_TOKENS_COMBAT : TOOL_TOKENS),
    description: TOOL_DESCRIPTION_CHARS,
    op_line: OP_LINE_CHARS,
    field: FIELD_DESCRIPTION_CHARS,
  })[metric];

/** Characters of over-1 KB sub-schemas that repeat one already listed, counted once at the outermost repeat. */
function repeatedSubSchemas(tools: Tool[]): { chars: number; where: string[] } {
  const seen = new Set<string>();
  const where: string[] = [];
  let chars = 0;
  const walk = (node: unknown, tool: string): void => {
    if (!node || typeof node !== 'object') return;
    if (!Array.isArray(node)) {
      const json = JSON.stringify(node);
      if (json.length > REPEATED_SUBSCHEMA_CHARS) {
        if (seen.has(json)) {
          chars += json.length;
          where.push(`${tool} (${json.length})`);
          return;
        }
        seen.add(json);
      }
    }
    for (const child of Object.values(node)) walk(child, tool);
  };
  for (const tool of tools) walk(tool.inputSchema, tool.name);
  return { chars, where };
}

describe('the tool surface budget', () => {
  let client: Client;
  let tools: Tool[];

  beforeAll(async () => {
    db = openDb(':memory:');
    client = await connect();
    tools = (await client.listTools()).tools;
    // Where the bytes are: run with --silent=false to see it.
    const rows = [...tools]
      .map((tool) => ({ name: tool.name, ...measure(tool) }))
      .sort((a, b) => b.tokens - a.tokens)
      .map((r) => `${r.name.padEnd(26)} ${String(r.tokens).padStart(6)} tok  desc ${String(r.description).padStart(5)}  op ${r.op_line}  field ${r.field}  ops ${r.ops}`);
    console.log(
      `tools/list: ${tools.length} tools, ${estimateTokens(JSON.stringify(tools))} tokens (ratchet ${TOOLS_LIST_RATCHET}, target ${TOOLS_LIST_TARGET})\n${rows.join('\n')}`,
    );
  });

  afterAll(async () => {
    await client.close();
  });

  it(`lists at most ${TOOL_COUNT} tools, none with more than ${OPS_PER_TOOL} ops`, () => {
    expect(tools.length).toBeLessThanOrEqual(TOOL_COUNT);
    const crowded = tools.filter((tool) => measure(tool).ops > OPS_PER_TOOL).map((tool) => tool.name);
    expect(crowded).toEqual([]);
  });

  it('keeps tools/list under its ratchet, which only ever comes down toward the target', () => {
    expect(TOOLS_LIST_TARGET).toBeLessThanOrEqual(TOOLS_LIST_PLAN_MAX);
    expect(TOOLS_LIST_RATCHET).toBeGreaterThanOrEqual(TOOLS_LIST_TARGET);
    expect(estimateTokens(JSON.stringify(tools))).toBeLessThanOrEqual(TOOLS_LIST_RATCHET);
  });

  it('keeps every tool within its per-tool caps, or within its ratchet while one is set', () => {
    const over: string[] = [];
    for (const tool of tools) {
      const size = measure(tool);
      for (const metric of ['tokens', 'description', 'op_line', 'field'] as const) {
        const limit = TOOL_RATCHETS[tool.name]?.[metric] ?? capFor(tool.name, metric);
        if (size[metric] > limit) over.push(`${tool.name} ${metric} ${size[metric]} > ${limit}`);
      }
    }
    expect(over).toEqual([]);
  });

  it('sets no ratchet below the cap it relaxes', () => {
    const loose = Object.entries(TOOL_RATCHETS).flatMap(([name, ratchets]) =>
      Object.entries(ratchets)
        .filter(([metric, value]) => value < capFor(name, metric as SurfaceMetric))
        .map(([metric]) => `${name} ${metric}`),
    );
    expect(loose).toEqual([]);
  });

  it('gives each token-cap exception a reason, and no ratchet on top of it', () => {
    for (const [name, exception] of Object.entries(TOOL_TOKEN_EXCEPTIONS)) {
      expect(exception.reason.length, name).toBeGreaterThan(0);
      expect(TOOL_RATCHETS[name]?.tokens, name).toBeUndefined();
    }
  });

  it(`keeps every description inside Claude's ${CLAUDE_DESCRIPTION_CHARS}-character cut unless its ratchet says otherwise`, () => {
    const cut = tools
      .filter((tool) => (tool.description ?? '').length > CLAUDE_DESCRIPTION_CHARS)
      .filter((tool) => TOOL_RATCHETS[tool.name]?.description === undefined)
      .map((tool) => tool.name);
    expect(cut).toEqual([]);
  });

  it('repeats no large sub-schema beyond its ratchet', () => {
    const repeated = repeatedSubSchemas(tools);
    expect(repeated.chars, repeated.where.join(', ')).toBeLessThanOrEqual(REPEATED_SUBSCHEMA_RATCHET);
  });

  it(`keeps the heaviest read replies under Claude's ${CLAUDE_REPLY_CHARS} characters`, async () => {
    const { campaign_id } = createCampaign(db, { name: 'Budget', story_shape: 'sandbox', premise: 'A long road.' });
    const probes: Array<[string, Record<string, unknown>]> = [
      ['load_campaign', {}],
      ['load_campaign', { campaign_id }],
      ['list_character_options', { campaign_id }],
      ...GUIDE_SECTIONS.map((section): [string, Record<string, unknown>] => ['read_guide', { section }]),
      ...['spell', 'species', 'rule', 'feat', 'item', 'creature'].map(
        (kind): [string, Record<string, unknown>] => ['srd_lookup', { kind, query: 'e', limit: 25 }],
      ),
    ];
    const over: string[] = [];
    for (const [name, args] of probes) {
      const reply = await call(client, name, args);
      expect(reply.isError, `${name} ${JSON.stringify(args)}`).toBeFalsy();
      const length = textOf(reply).length;
      if (length > CLAUDE_REPLY_CHARS) over.push(`${name} ${JSON.stringify(args)} ${length}`);
    }
    expect(over).toEqual([]);
  });
});

describe('the stale-connector guard', () => {
  const stampOf = (tools: Tool[]): string | undefined =>
    /Always pass tools_hash "([0-9a-f]{8})"\.$/.exec(tools.find((t) => t.name === 'load_campaign')?.description ?? '')?.[1];

  beforeAll(() => {
    db = openDb(':memory:');
  });

  it('stamps load_campaign with the hash of the surface it serves, and the briefing carries it', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const hash = toolSurfaceHash(tools);
    expect(stampOf(tools)).toBe(hash);

    const { campaign_id } = createCampaign(db, { name: 'Hash', story_shape: 'sandbox' });
    const briefing = await call(client, 'load_campaign', { campaign_id, tools_hash: hash });
    expect(textOf(briefing)).toContain(`Tools hash: ${hash}.`);
    expect(textOf(briefing)).not.toContain('STALE TOOLS');
    expect(/Tools hash: ([0-9a-f]{8})\./.exec(textOf(briefing))?.[1]).toBe(hash);
    expect(JSON.stringify(briefing)).not.toMatch(/tools_warning|STALE TOOLS/);
    // A host that never passes it is not warned: the guard cannot tell.
    expect(textOf(await call(client, 'load_campaign', { campaign_id }))).not.toContain('STALE TOOLS');
    await client.close();
  });

  it('follows the surface: one more tool or a reworded description is a different hash', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const hash = toolSurfaceHash(tools);
    const probe = { name: 'zz_probe', description: 'Probe.', inputSchema: { type: 'object', properties: {} } };
    expect(toolSurfaceHash([...tools, probe])).not.toBe(hash);
    const reworded = tools.map((t, i) => (i === 0 ? { ...t, description: `${t.description} Probe.` } : t));
    expect(toolSurfaceHash(reworded)).not.toBe(hash);
    await client.close();
  });

  it('tells the DM to reconnect, in words that fit any host, when the quoted hash is stale', async () => {
    const client = await connect();
    const { campaign_id } = createCampaign(db, { name: 'Stale', story_shape: 'sandbox' });
    const reconnect =
      'the dnd-ai tools changed - reconnect the dnd-ai server (start a new chat, or /mcp then Reconnect, or restart the app)';

    const briefing = await call(client, 'load_campaign', { campaign_id, tools_hash: '0000beef' });
    const text = textOf(briefing);
    expect(text.startsWith('STALE TOOLS')).toBe(true);
    expect(text).toContain(reconnect);
    expect(text).toContain('0000beef');
    expect(text.split('\n\n')[0]).not.toMatch(/ChatGPT|Claude/);
    expect(text.split('\n\n')[0]).toContain(reconnect);

    const list = await call(client, 'load_campaign', { tools_hash: '0000beef' });
    expect(textOf(list)).toContain(reconnect);
    await client.close();
  });
});

describe('the stale-connector guard when hashing fails', () => {
  beforeAll(() => {
    db = openDb(':memory:');
  });

  afterAll(() => {
    vi.doUnmock('zod');
    vi.resetModules();
  });

  it('still lists every tool, and load_campaign answers without a stamp or a stale warning', async () => {
    const plain = await connect();
    const expected = (await plain.listTools()).tools.map((t) => t.name);
    await plain.close();
    // No test seam: a fresh server whose schema conversion throws, as an SDK or zod change could make it.
    vi.doMock('zod', async (importOriginal) => {
      const real = await importOriginal<typeof import('zod')>();
      const toJSONSchema = (): never => {
        throw new Error('conversion failed');
      };
      return { ...real, toJSONSchema, z: { ...real.z, toJSONSchema } };
    });
    vi.resetModules();
    const fresh = await import('../src/mcp/server.js');
    const client = await connect(fresh.createGameServer(db));

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expected);
    expect(tools.find((t) => t.name === 'load_campaign')?.description).not.toContain('tools_hash "');
    const { campaign_id } = createCampaign(db, { name: 'Unhashed', story_shape: 'sandbox' });
    const briefing = await call(client, 'load_campaign', { campaign_id, tools_hash: '0000beef' });
    expect(briefing.isError).toBeFalsy();
    expect(textOf(briefing)).not.toMatch(/STALE TOOLS|Tools hash:/);
    await client.close();
  });
});

describe('the honest difficulty line', () => {
  beforeAll(() => {
    db = openDb(':memory:');
  });

  it('claims no encounter budget the engine does not compute, at any difficulty', () => {
    const { campaign_id } = createCampaign(db, { name: 'Honest', story_shape: 'sandbox' });
    for (const difficulty of ['story', 'standard', 'deadly'] as const) {
      updateSettings(db, campaign_id, { difficulty });
      const line = renderBriefing(loadCampaign(db, campaign_id), getSettings(db, campaign_id))
        .split('\n')
        .find((l) => l.startsWith('Difficulty:'));
      expect(line).toContain(`Difficulty: ${difficulty} — the engine does not size encounters`);
      expect(line).toContain('the region decides what is out there');
      expect(line).not.toMatch(/budget|normalised/);
    }
  });
});

describe('the briefing settings line', () => {
  beforeAll(() => {
    db = openDb(':memory:');
  });

  /** A story from chat with settings stored as an older server wrote them. */
  function legacyStory(): number {
    const { campaign_id } = createCampaign(db, { name: 'Legacy', story_shape: 'sandbox' });
    const stored = { rules_mode: 'strict', lines: 'no spiders', cheat_mode: true };
    db.prepare('UPDATE campaign SET settings_json = ? WHERE id = ?').run(JSON.stringify(stored), campaign_id);
    return campaign_id;
  }

  it('prints the stored keys with the values the server reads, not the raw stored ones', () => {
    const campaign_id = legacyStory();
    const read = { ...getSettings(db, campaign_id), rules_mode: 'flexible' as const };
    const rendered = renderBriefing(loadCampaign(db, campaign_id), read);
    const line = rendered.split('\n').find((l) => l.startsWith('Settings: '));
    expect(JSON.parse(line!.slice('Settings: '.length))).toEqual({ rules_mode: 'flexible', lines: 'no spiders' });
    expect(rendered).not.toContain('cheat_mode');
  });

  it('reads them through getSettings in load_campaign', async () => {
    const campaign_id = legacyStory();
    const client = await connect();
    const text = textOf(await call(client, 'load_campaign', { campaign_id }));
    const line = text.split('\n').find((l) => l.startsWith('Settings: '));
    expect(JSON.parse(line!.slice('Settings: '.length))).toEqual({
      rules_mode: getSettings(db, campaign_id).rules_mode,
      lines: 'no spiders',
    });
    await client.close();
  });
});
