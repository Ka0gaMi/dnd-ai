// The playtest judge without a real model: the bundle from a seeded run folder, the judge's arguments, judge.md from a
// fake claude, and the run's post-run hook with --no-judge and with a failing judge.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { addCanonFact, createCampaign, upsertQuests } from '../src/core/campaign.js';
import { adjustGold, applyDamage, createCharacter } from '../src/core/character.js';
import { upsertEntity } from '../src/core/codex.js';
import { addRumour, setStoryOutline } from '../src/core/story.js';
import { openDb } from '../src/db/connection.js';
import { buildBundle, BUNDLE_FILE, JUDGE_FILE, JUDGE_PROMPT, judgeArgs, judgeRun, SPOILER_WARNING } from '../scripts/playtest/judge.mjs';
import { afterRun, judgeFlag, parseCli, runClaude } from '../scripts/playtest/run.mjs';

const T0 = Date.parse('2026-10-30T10:00:00.000Z');
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();
const MCP_SECRET = 'deadbeef0123456789judgesecret';
const SECRET_NOTES = 'The abbot is the bell thief.\nThe real bell lies under Saint Orrin chapel.';
const FALSE_RUMOUR = 'The bishop has fled to the coast with the tithe.';
const HIDDEN_NOTES = 'Secretly sells the bronze to smugglers.';
const stream = (events: object[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

let dir: string;
let dbFile: string;
let pc: { hp_current: number; hp_max: number; gold: number; level: number; xp: number };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dnd-playtest-judge-'));
  dbFile = join(dir, 'game.sqlite');
  const db = openDb(dbFile);
  const campaignId = createCampaign(db, { name: 'The Bell Tithe', story_shape: 'structured' }).campaign_id;
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
  applyDamage(db, { campaign_id: campaignId, amount: 3, type: 'slashing', source: 'goblin' });
  adjustGold(db, { campaign_id: campaignId, delta: 7, reason: 'goblin purse' });
  setStoryOutline(db, { campaign_id: campaignId, premise: 'A city of bells.', ending: 'The bells ring again.', secret_notes: SECRET_NOTES });
  addRumour(db, { campaign_id: campaignId, text: FALSE_RUMOUR, truth: 'false' });
  upsertEntity(db, { campaign_id: campaignId, kind: 'npc', name: 'Abbot Hollis', summary: 'Keeper of the bells.', hidden_notes: HIDDEN_NOTES });
  upsertEntity(db, { campaign_id: campaignId, kind: 'npc', name: 'Brother Tam', summary: 'The bell-ringer.', status: 'dead' });
  addCanonFact(db, { campaign_id: campaignId, subject: 'Saint Orrin chapel', fact: 'The chapel bell cracked in the great frost.' });
  upsertQuests(db, campaignId, [{ title: 'Find the tithe bell', steps: [{ text: 'Search the vestry', done: true }, { text: 'Confront the abbot' }] }]);
  pc = db.prepare('SELECT hp_current, hp_max, gold, level, xp FROM character WHERE is_pc = 1').get() as typeof pc;
  db.close();

  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      started_at: at(0),
      finished_at: at(200),
      port: 4242,
      secret: MCP_SECRET,
      db_path: dbFile,
      campaign_id: campaignId,
      dm_model: 'sonnet',
      player: 'scripted',
      player_model: null,
      scenario: 'first-session',
      turns_played: 2,
      totals: { wall_ms: 150_000, duration_api_ms: 90_000, num_turns: 7, total_cost_usd: 0.31 },
      session_breaks: [{ turn: 2, old_dm_session_id: 'A', new_dm_session_id: 'B' }],
    }),
  );
  const transcript = [
    { turn: 1, role: 'player', text: 'I search the vestry.', at: at(1) },
    {
      turn: 1,
      role: 'dm',
      text: 'Dust, and a glint of bronze.\n\nWhat do you do?',
      tool_calls: [{ name: 'roll', input: {} }],
      at: at(30),
      started_at: at(2),
      finished_at: at(30),
      usage: { duration_ms: 28_000, num_turns: 3, total_cost_usd: 0.12 },
    },
    { turn: 2, role: 'player', text: "Let's continue our campaign.", at: at(60) },
    { turn: 2, role: 'session', text: 'New DM session B resumes from the save of A.', at: at(90) },
    { turn: 2, role: 'dm', text: 'Last time, you found bronze filings.', at: at(100), started_at: at(61), finished_at: at(100) },
  ];
  writeFileSync(join(dir, 'transcript.jsonl'), `${transcript.map((e) => JSON.stringify(e)).join('\n')}\n`);
  mkdirSync(join(dir, 'streams'));
  const toolUse = (id: string, name: string, input: object) => ({
    type: 'assistant',
    message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: `mcp__dnd-ai__${name}`, input }] },
  });
  const toolResult = (id: string, text: string, isError = false) => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] }] },
  });
  writeFileSync(
    join(dir, 'streams', 'dm-01.jsonl'),
    stream([
      toolUse('t1', 'roll', { expr: '1d20+3', purpose: 'Investigation' }),
      toolResult('t1', '{"total":17,"outcome":"success"}'),
      toolUse('t2', 'hp', { op: 'damage', target: 'Nobody' }),
      toolResult('t2', 'No combatant or character named Nobody.', true),
      { type: 'result', is_error: false, result: 'Dust, and a glint of bronze.' },
    ]),
  );
  // Turn 2 has no stream, so its calls come from server.log inside the turn's window.
  writeFileSync(
    join(dir, 'server.log'),
    [
      `${at(5)} tools/call roll {"expr":"1d20+3","purpose":"Investigation"}`,
      `${at(5)} tools/result roll ok 40ms 300B {"total":17,"outcome":"success"}`,
      `${at(6)} tools/call hp {"op":"damage","target":"Nobody"}`,
      `${at(6)} tools/result hp error 5ms 120B No combatant or character named Nobody.`,
      `${at(70)} tools/call load_campaign {"campaign_id":1}`,
      `${at(70)} tools/result load_campaign ok 30ms 5000B # The Bell Tithe (campaign 1, structured)`,
    ].join('\n'),
  );
  mkdirSync(join(dir, 'screenshots'));
  writeFileSync(join(dir, 'screenshots', '01-turn-01.png'), '');
  writeFileSync(
    join(dir, 'report.md'),
    ['# Playtest report', 'Leaks found: **1** (see Leak scan).', '### Leaks', '', '- **hidden_clue**: "Bronze filings" in `ws snapshot`', '', '### Surfaces scanned'].join('\n'),
  );
}, 60_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('the judge bundle', () => {
  let bundle: string;
  let before: string;
  beforeAll(() => {
    before = sha(dbFile);
    bundle = buildBundle(dir);
  });

  it('never writes to the run database', () => {
    expect(sha(dbFile)).toBe(before);
  });

  it('dumps the state with the DM secrets, rumour truth, codex status and the sheet numbers', () => {
    for (const line of SECRET_NOTES.split('\n')) expect(bundle).toContain(`  ${line}`);
    expect(bundle).toContain('- Ending: The bells ring again.');
    expect(bundle).toMatch(new RegExp(`"truth":"false","text":"${FALSE_RUMOUR}"[^\\n]*"heard_at":null`));
    expect(bundle).toContain(`"hidden_notes":"${HIDDEN_NOTES}"`);
    expect(bundle).toMatch(/"name":"Brother Tam","status":"dead"/);
    expect(bundle).toContain(`"level":${pc.level},"xp":${pc.xp},"hp_current":${pc.hp_current},"hp_max":${pc.hp_max}`);
    expect(pc.hp_current).toBe(pc.hp_max - 3);
    expect(bundle).toContain(`"gold":${pc.gold}`);
    expect(bundle).toMatch(/\n {2}inventory: \S/);
    expect(bundle).toContain('"steps":[{"text":"Search the vestry","done":1},{"text":"Confront the abbot","done":0}]');
    expect(bundle).toContain('"fact":"The chapel bell cracked in the great frost."');
    expect(bundle).toContain('"dc_disclosure":"hidden"');
  });

  it('gives each turn its narration and tool calls with short results, from the stream or else server.log', () => {
    expect(bundle).toContain('### Turn 1 (DM 28.0 s, 3 model hops, $0.120)');
    expect(bundle).toContain('Dust, and a glint of bronze.\n\nWhat do you do?');
    expect(bundle).toContain('- roll {"expr":"1d20+3","purpose":"Investigation"} -> ok: {"total":17,"outcome":"success"}');
    expect(bundle).toContain('- hp {"op":"damage","target":"Nobody"} -> REFUSED: No combatant or character named Nobody.');
    expect(bundle).toContain('---- Session break: New DM session B resumes from the save of A. ----');
    expect(bundle).toContain('- load_campaign {"campaign_id":1} -> ok: # The Bell Tithe (campaign 1, structured)');
    expect(bundle.indexOf('---- Session break')).toBeLessThan(bundle.indexOf('### Turn 2'));
  });

  it('carries the run facts, coverage, leak scan, screenshots and the DM instructions, but not the MCP secret', () => {
    expect(bundle).toContain("- Scenario: first-session; the player's goal:");
    expect(bundle).toContain('- Session breaks at turns: 2');
    expect(bundle).toContain('| hp/conditions | 1 | 1 | hp.damage |');
    expect(bundle).toContain('- (1x) No combatant or character named Nobody.');
    expect(bundle).toContain('- **hidden_clue**: "Bronze filings" in `ws snapshot`');
    expect(bundle).toContain(`- ${join(dir, 'screenshots', '01-turn-01.png')}`);
    expect(bundle).toContain('You are the DM of a solo D&D 5e game');
    expect(bundle).not.toContain(MCP_SECRET);
  });

  it('lists the line each section starts on', () => {
    const lines = bundle.split('\n');
    const contents = lines.filter((l) => /^- line \d+: /.test(l));
    expect(contents.length).toBeGreaterThanOrEqual(8);
    for (const entry of contents) {
      const [, n, title] = /^- line (\d+): (.*)$/.exec(entry)!;
      expect(lines[Number(n) - 1]).toBe(`## ${title}`);
    }
  });
});

describe('the judge call', () => {
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('runs isolated like the DM, with Opus by default and only the Read tool', () => {
    const args = judgeArgs({ prompt: 'Judge it.', model: 'opus' });
    expect(args.slice(0, 2)).toEqual(['-p', 'Judge it.']);
    expect(after(args, '--model')).toBe('opus');
    expect(after(args, '--tools')).toBe('Read');
    expect(after(args, '--allowedTools')).toBe('Read');
    expect(after(args, '--setting-sources')).toBe('');
    expect(after(args, '--system-prompt')).toBe(JUDGE_PROMPT);
    expect(after(args, '--output-format')).toBe('stream-json');
    expect(args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--disable-slash-commands', '--verbose']));
    for (const flag of ['--mcp-config', '--resume', '--append-system-prompt-file']) expect(args).not.toContain(flag);
  });

  it('puts the rubric, the gap rule and the output shape in the prompt', () => {
    for (const area of ['Narration', 'Story', 'NPCs', 'World and canon', 'Rumours', 'Quests and clues', 'Rules honesty', 'Bookkeeping', 'Combat', 'Time and place', 'Saves and resume', 'Table craft', 'Companion window', 'Efficiency']) {
      expect(JUDGE_PROMPT).toContain(`${area}`);
    }
    expect(JUDGE_PROMPT).toContain('not-built-yet');
    expect(JUDGE_PROMPT).toContain('**Verdict:**');
    expect(JUDGE_PROMPT).toContain('## Fix list');
  });

  const fake = (result: object | null, opts: { stalled?: boolean } = {}) => {
    const seen: Array<{ args: string[]; cwd: string }> = [];
    const runner: typeof runClaude = async (args, cwd, file) => {
      seen.push({ args, cwd });
      const raw = result ? stream([{ type: 'system', subtype: 'init', model: 'claude-opus-test' }, result]) : '';
      writeFileSync(file, raw);
      return { raw, code: result ? 0 : 1, stderr: result ? '' : 'boom', stalled: opts.stalled ?? false };
    };
    return { runner, seen };
  };

  it('writes judge.md with a spoiler warning, the verdict and no MCP secret, from the run folder', async () => {
    const text = `**Verdict:** Fun, until the recap forgets the bell.\n\n## Scores\n\nThe judge read mcp.json: ${MCP_SECRET}`;
    const { runner, seen } = fake({ type: 'result', is_error: false, result: text, duration_ms: 61_000, total_cost_usd: 1.25 });
    const before = sha(dbFile);
    const r = await judgeRun(dir, { runner });
    expect(r.verdict).toBe('Fun, until the recap forgets the bell.');
    expect(r.judgePath).toBe(join(dir, JUDGE_FILE));
    const judge = readFileSync(r.judgePath, 'utf8');
    expect(judge.startsWith(`${SPOILER_WARNING}\n\n_Judged by claude-opus-test on `)).toBe(true);
    expect(judge).toContain(': 61.0 s, $1.250 list price._');
    expect(judge).toContain('**Verdict:** Fun, until the recap forgets the bell.');
    expect(judge).toContain('The judge read mcp.json: <secret>');
    expect(judge).not.toContain(MCP_SECRET);
    expect(existsSync(join(dir, BUNDLE_FILE))).toBe(true);
    expect(existsSync(join(dir, 'streams', 'judge.jsonl'))).toBe(true);
    expect(seen[0]!.cwd).toBe(dir);
    expect(seen[0]!.args[seen[0]!.args.indexOf('--model') + 1]).toBe('opus');
    expect(seen[0]!.args[1]).toContain(join(dir, BUNDLE_FILE));
    expect(sha(dbFile)).toBe(before);

    const other = fake({ type: 'result', is_error: false, result: '**Verdict:** Fine.' });
    await judgeRun(dir, { runner: other.runner, model: 'sonnet' });
    expect(other.seen[0]!.args[other.seen[0]!.args.indexOf('--model') + 1]).toBe('sonnet');
  });

  it('fails on an error result, an empty stream or a timeout', async () => {
    await expect(judgeRun(dir, { runner: fake({ type: 'result', is_error: true, result: 'overloaded' }).runner })).rejects.toThrow(/judge claude failed/);
    await expect(judgeRun(dir, { runner: fake(null).runner })).rejects.toThrow(/boom/);
    await expect(judgeRun(dir, { runner: fake(null, { stalled: true }).runner, timeoutMs: 60_000 })).rejects.toThrow(/ran past 1 min/);
  });
});

describe('the post-run hook', () => {
  afterEach(() => vi.restoreAllMocks());

  const modules = (judge: () => Promise<{ judgePath: string; verdict: string | null }>) => {
    const steps: string[] = [];
    const loaded: string[] = [];
    const mods: Record<string, unknown> = {
      './report.mts': {
        writeReport: async () => {
          steps.push('report');
          return { reportPath: 'report.md', leaks: 0 };
        },
      },
      './judge.mts': {
        judgeRun: async () => {
          steps.push('judge');
          return judge();
        },
      },
      './publish.mts': {
        publishRun: async () => {
          steps.push('publish');
          return 'published';
        },
        reportsRoot: () => 'root',
      },
    };
    const load = async <T>(file: string): Promise<T | null> => {
      loaded.push(file);
      return (mods[file] as T) ?? null;
    };
    return { steps, loaded, load };
  };

  it('splits --no-judge off before the playtest flags are parsed', () => {
    const { judge, rest } = judgeFlag(['--turns', '3', '--no-judge']);
    expect(judge).toBe(false);
    expect(parseCli(rest).turns).toBe(3);
    expect(judgeFlag(['--turns', '3'])).toEqual({ judge: true, rest: ['--turns', '3'] });
  });

  it('skips the judge with --no-judge and still reports and publishes', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { steps, loaded, load } = modules(async () => ({ judgePath: 'judge.md', verdict: null }));
    await afterRun(dir, false, load);
    expect(steps).toEqual(['report', 'publish']);
    expect(loaded).not.toContain('./judge.mts');
  });

  it('rewrites the report after a verdict so it points at judge.md', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { steps, load } = modules(async () => ({ judgePath: 'judge.md', verdict: 'Smooth.' }));
    await afterRun(dir, true, load);
    expect(steps).toEqual(['report', 'judge', 'report', 'publish']);
    expect(log).toHaveBeenCalledWith('Judge: judge.md - Smooth.');
  });

  it('logs a failing judge and carries on to publish', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { steps, load } = modules(async () => {
      throw new Error('opus is overloaded');
    });
    await expect(afterRun(dir, true, load)).resolves.toBeUndefined();
    expect(steps).toEqual(['report', 'judge', 'publish']);
    expect(error).toHaveBeenCalledWith('Judge failed: opus is overloaded');
  });
});
