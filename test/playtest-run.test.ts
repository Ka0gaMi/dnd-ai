import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createPendingRoll, getPendingRoll, openPendingRolls } from '../src/core/rolls.js';
import { openDb } from '../src/db/connection.js';
import { startHttpServer } from '../src/transport/http.js';
import {
  answerRolls,
  appendTranscript,
  dmArgs,
  initSummary,
  isolationProblems,
  parseCli,
  parseStream,
  playerArgs,
  playerPrompt,
  runStamp,
  serverEnv,
  sumUsage,
  writeMeta,
  type Meta,
  type Usage,
} from '../scripts/playtest/run.mjs';
import { SCENARIOS, scriptedTurns } from '../scripts/playtest/scenarios.mjs';

const SID = '1a8f8bbe-c5bd-42de-9367-9314983f4ee2';
const init = {
  type: 'system',
  subtype: 'init',
  cwd: 'C:\\run\\dm',
  session_id: SID,
  tools: ['mcp__dnd-ai__load_campaign', 'mcp__dnd-ai__roll'],
  mcp_servers: [{ name: 'dnd-ai', status: 'connected', source: 'dynamic' }],
  model: 'claude-sonnet-5',
  slash_commands: ['mcp__dnd-ai__resume'],
  claude_code_version: '2.1.314',
  output_style: 'default',
  skills: [],
  plugins: [{ name: 'cc-plugin-agents-md', path: 'builtin' }],
};
const msgUsage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 10,
});
const assistant = (id: string, block: object, usage: object) => ({
  type: 'assistant',
  session_id: SID,
  message: { id, type: 'message', role: 'assistant', content: [block], usage },
});

// Shaped after a recorded claude 2.1.314 stream: one assistant event per content block, usage repeated on each.
const turnEvents = [
  init,
  assistant('msg_1', { type: 'thinking', thinking: '' }, msgUsage(5, 40)),
  assistant('msg_1', { type: 'text', text: 'Let me load the story.' }, msgUsage(5, 40)),
  assistant('msg_1', { type: 'tool_use', id: 'toolu_1', name: 'mcp__dnd-ai__load_campaign', input: {} }, msgUsage(5, 40)),
  { type: 'user', session_id: SID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '{"campaigns":[]}' }] }] } },
  assistant('msg_2', { type: 'tool_use', id: 'toolu_2', name: 'mcp__dnd-ai__roll', input: { who: 'player', expr: '1d20+2', dc: 12 } }, msgUsage(3, 20)),
  { type: 'user', session_id: SID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'success' }] }] } },
  assistant('msg_3', { type: 'text', text: 'You stand at the gate of Millbrook. What do you do?' }, msgUsage(2, 30)),
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, session_id: SID },
];
const resultEvent = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 3053,
  duration_api_ms: 849,
  num_turns: 3,
  result: 'You stand at the gate of Millbrook. What do you do?',
  session_id: SID,
  total_cost_usd: 0.00044,
  usage: { input_tokens: 10, cache_creation_input_tokens: 2158, cache_read_input_tokens: 649, output_tokens: 90, service_tier: 'standard' },
};
const stream = (events: object[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

describe('parseStream', () => {
  it('reads the final text, the tool calls, the session id and the result usage', () => {
    const parsed = parseStream(stream([...turnEvents, resultEvent]));
    expect(parsed.sessionId).toBe(SID);
    expect(parsed.text).toBe('You stand at the gate of Millbrook. What do you do?');
    expect(parsed.toolCalls).toEqual([
      { name: 'load_campaign', input: {} },
      { name: 'roll', input: { who: 'player', expr: '1d20+2', dc: 12 } },
    ]);
    expect(parsed.init?.mcp_servers).toEqual(init.mcp_servers);
    expect(parsed.hasResult).toBe(true);
    expect(parsed.isError).toBe(false);
    expect(parsed.usage).toEqual({
      duration_ms: 3053,
      duration_api_ms: 849,
      num_turns: 3,
      input_tokens: 10,
      output_tokens: 90,
      cache_read_input_tokens: 649,
      cache_creation_input_tokens: 2158,
      total_cost_usd: 0.00044,
    });
  });

  it('falls back to per-message usage, counting each message once, when the result lacks it', () => {
    const { usage: _dropped, ...bare } = resultEvent;
    const parsed = parseStream(stream([...turnEvents, bare]));
    expect(parsed.usage).toEqual({
      duration_ms: 3053,
      duration_api_ms: 849,
      num_turns: 3,
      input_tokens: 10,
      output_tokens: 90,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 30,
      total_cost_usd: 0.00044,
    });
  });

  it('keeps the last text and marks an interrupted stream as an error', () => {
    const parsed = parseStream(`${stream(turnEvents)}not json\n`);
    expect(parsed.hasResult).toBe(false);
    expect(parsed.isError).toBe(true);
    expect(parsed.text).toBe('You stand at the gate of Millbrook. What do you do?');
    expect(parsed.usage.duration_ms).toBeNull();
    expect(parsed.usage.total_cost_usd).toBeNull();
    expect(parsed.usage.output_tokens).toBe(90);
  });

  it('turns a resumed session running cost and API time into the turn own figures', () => {
    // Recorded from the second turn of a smoke run (trimmed): cost and API time count from the session start.
    const resumed = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 9448,
      duration_api_ms: 13827,
      num_turns: 3,
      result: 'Your story is created: **The Lantern Under Thistledown**.',
      session_id: 'cea16dec-81f4-41bc-a607-d56a58d73616',
      total_cost_usd: 0.49686640000000004,
      usage: { input_tokens: 6, cache_creation_input_tokens: 3507, cache_read_input_tokens: 219937, output_tokens: 838 },
      model_usage_since_last_result: { 'claude-sonnet-5-5': { outputTokens: 838, costUSD: 0.0444137 } },
    };
    const previous = { duration_api_ms: 5372, total_cost_usd: 0.45245270000000004 };
    const parsed = parseStream(stream([resumed]), previous);
    expect(parsed.usage).toEqual({
      duration_ms: 9448,
      duration_api_ms: 8455,
      num_turns: 3,
      input_tokens: 6,
      output_tokens: 838,
      cache_read_input_tokens: 219937,
      cache_creation_input_tokens: 3507,
      total_cost_usd: 0.0444137,
    });
    expect(parsed.session).toEqual({ duration_api_ms: 13827, total_cost_usd: 0.49686640000000004 });

    const { model_usage_since_last_result: _since, ...older } = resumed;
    expect(parseStream(stream([older]), previous).usage.total_cost_usd).toBeCloseTo(0.0444137, 9);
    expect(parseStream(stream([older]), { duration_api_ms: 99999, total_cost_usd: 9 }).usage.duration_api_ms).toBe(13827);
  });

  it('dedupes a tool_use block streamed twice', () => {
    const block = { type: 'tool_use', id: 'toolu_9', name: 'mcp__dnd-ai__roll', input: {} };
    const parsed = parseStream(stream([assistant('m', block, {}), assistant('m', block, {}), resultEvent]));
    expect(parsed.toolCalls).toHaveLength(1);
  });
});

describe('claude arguments', () => {
  const base = { prompt: 'I attack!', model: 'sonnet', mcpConfig: 'C:\\run\\mcp.json', instructions: 'C:\\repo\\docs\\dm-instructions.md' };

  it('isolates the DM and allows only the dnd-ai tools', () => {
    const args = dmArgs({ ...base, sessionId: null });
    expect(args.slice(0, 2)).toEqual(['-p', 'I attack!']);
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after('--model')).toBe('sonnet');
    expect(after('--mcp-config')).toBe('C:\\run\\mcp.json');
    expect(after('--append-system-prompt-file')).toBe('C:\\repo\\docs\\dm-instructions.md');
    expect(after('--tools')).toBe('');
    expect(after('--allowedTools')).toBe('mcp__dnd-ai');
    expect(after('--setting-sources')).toBe('');
    expect(after('--output-format')).toBe('stream-json');
    expect(args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--disable-slash-commands', '--verbose']));
    expect(args).not.toContain('--resume');
  });

  it('resumes the DM session after the first turn and guards a prompt starting with a dash', () => {
    const args = dmArgs({ ...base, prompt: '-- I run', sessionId: SID });
    expect(args[1]).toBe(' -- I run');
    expect(args.slice(-2)).toEqual(['--resume', SID]);
  });

  it('gives the player no tools, no MCP servers and its own system prompt', () => {
    const args = playerArgs({ prompt: playerPrompt('What do you do?'), model: 'haiku', persona: 'A novice.', sessionId: null });
    expect(args[1]).toContain('What do you do?');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('A novice.');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--allowedTools');
    expect(playerPrompt(null)).toMatch(/session is starting/);
  });
});

describe('server environment', () => {
  it('drops the Cloudflare keys so a run never spends image quota, and keeps the rest', () => {
    const env = serverEnv({ PATH: 'p', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' }, { DND_AI_PORT: '1' });
    expect(env).toEqual({ PATH: 'p', DND_AI_PORT: '1' });
  });
});

describe('isolation check', () => {
  it('passes a DM that sees only the dnd-ai server', () => {
    expect(isolationProblems(init)).toEqual([]);
    expect(initSummary(init)).toMatchObject({ tools: init.tools, plugins: ['cc-plugin-agents-md'], memory_paths: null });
  });

  it('names every leak', () => {
    const leaky = {
      ...init,
      tools: [...init.tools, 'Bash'],
      mcp_servers: [...init.mcp_servers, { name: 'obsidian', status: 'connected' }],
      skills: ['vault'],
      memory_paths: { auto: 'C:\\memory' },
    };
    const problems = isolationProblems(leaky);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain('Bash');
    expect(isolationProblems(null)).toEqual(['the stream had no init event']);
  });
});

describe('scenarios', () => {
  it('yields the first-session lines up to the turn limit', () => {
    expect([...scriptedTurns('first-session', 2)]).toEqual(SCENARIOS['first-session'].lines.slice(0, 2));
    expect([...scriptedTurns('first-session', 99)]).toHaveLength(SCENARIOS['first-session'].lines.length);
    expect(SCENARIOS['first-session'].lines.at(-1)).toMatch(/save/i);
  });

  it('refuses an unknown scenario', () => {
    expect(() => scriptedTurns('nope', 3).next()).toThrow(/Unknown scenario/);
  });
});

describe('cli', () => {
  it('defaults to a short scripted run with a Sonnet DM', () => {
    expect(parseCli([])).toEqual({ scenario: 'first-session', turns: 12, dmModel: 'sonnet', player: 'scripted', playerModel: 'haiku', window: true });
    expect(parseCli(['--turns', '2', '--player', 'claude', '--window']).player).toBe('claude');
    expect(parseCli(['--no-window']).window).toBe(false);
    expect(() => parseCli(['--turns', '0'])).toThrow();
    expect(() => parseCli(['--player', 'robot'])).toThrow();
  });

  it('stamps the run folder as YYYYMMDD-HHMMSS', () => {
    expect(runStamp(new Date(2026, 9, 30, 7, 5, 9))).toBe('20261030-070509');
  });
});

describe('run folder', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const usage = (cost: number | null, input: number | null): Usage => ({
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: 2,
    input_tokens: input,
    output_tokens: 50,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 100,
    total_cost_usd: cost,
  });

  it('sums usage field by field and keeps all-missing fields null', () => {
    expect(sumUsage([usage(0.5, null), usage(0.25, 7)])).toEqual({
      duration_ms: 2000,
      duration_api_ms: 1600,
      num_turns: 4,
      input_tokens: 7,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 200,
      total_cost_usd: 0.75,
    });
    expect(sumUsage([usage(null, null)]).total_cost_usd).toBeNull();
  });

  it('writes meta.json and transcript.jsonl per the contract', () => {
    dir = mkdtempSync(join(tmpdir(), 'dnd-ai-playtest-'));
    const meta: Meta = {
      started_at: '2026-10-30T07:00:00.000Z',
      finished_at: null,
      port: 51234,
      secret: 'abc',
      db_path: join(dir, 'game.sqlite'),
      campaign_id: null,
      dm_model: 'sonnet',
      player: 'scripted',
      player_model: null,
      scenario: 'first-session',
      turns_played: 1,
      dm_session_id: SID,
      dm_init: initSummary(init),
      totals: { ...sumUsage([usage(0.5, 3)]), wall_ms: 5000 },
      player_totals: null,
      error: null,
    };
    writeMeta(dir, meta);
    meta.campaign_id = 1;
    writeMeta(dir, meta);
    const read = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    for (const key of ['started_at', 'finished_at', 'port', 'secret', 'db_path', 'campaign_id', 'dm_model', 'player', 'scenario', 'turns_played', 'dm_session_id']) {
      expect(read).toHaveProperty(key);
    }
    expect(read.campaign_id).toBe(1);
    expect(read.totals.total_cost_usd).toBe(0.5);

    const parsed = parseStream(stream([...turnEvents, resultEvent]));
    appendTranscript(dir, { turn: 1, role: 'player', text: 'Hi', at: '2026-10-30T07:00:01.000Z' });
    appendTranscript(dir, {
      turn: 1,
      role: 'dm',
      text: parsed.text,
      tool_calls: parsed.toolCalls,
      at: '2026-10-30T07:00:09.000Z',
      started_at: '2026-10-30T07:00:01.000Z',
      finished_at: '2026-10-30T07:00:09.000Z',
      usage: parsed.usage,
    });
    const lines = readFileSync(join(dir, 'transcript.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ turn: 1, role: 'player', text: 'Hi', at: '2026-10-30T07:00:01.000Z' });
    expect(lines[1].tool_calls).toEqual([
      { name: 'load_campaign', input: {} },
      { name: 'roll', input: { who: 'player', expr: '1d20+2', dc: 12 } },
    ]);
    expect(Object.keys(lines[1].usage)).toEqual([
      'duration_ms',
      'duration_api_ms',
      'num_turns',
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
      'total_cost_usd',
    ]);
  });
});

describe('player rolls without the window', () => {
  it('resolves every open card through the API the Roll button uses', async () => {
    const db = openDb(':memory:');
    const campaignId = createCampaign(db, { name: 'Playtest', story_shape: 'sandbox' }).campaign_id;
    const pending = createPendingRoll(db, { campaign_id: campaignId, expr: '1d20+3', purpose: 'Stealth check', roller: 'player' });
    const server = await startHttpServer(db, { port: 0, secret: 'playtest-secret' });
    try {
      await answerRolls(`http://127.0.0.1:${server.port}`, campaignId);
    } finally {
      await server.close();
    }
    expect(openPendingRolls(db, campaignId)).toEqual([]);
    expect(getPendingRoll(db, pending.id)?.source).toBe('player');
  });
});
