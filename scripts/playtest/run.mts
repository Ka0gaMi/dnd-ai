// Self-playtest: headless Claude Code plays the DM against a throwaway server while a scripted or Claude player answers.
// Usage: node --import tsx scripts/playtest/run.mts [--scenario first-session] [--turns 12] [--dm-model sonnet] [--player scripted|claude] [--player-model haiku] [--no-window]
//   [--dm-timeout 10] [--player-timeout 10] (minutes per turn) [--session-every N] (turns per game session, 0 for none; default from the scenario). Screenshots are on by default.
//   [--no-judge] skips the Opus judge (scripts/playtest/judge.mts) that otherwise writes judge.md after the report.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDb } from '../../src/db/connection.js';
import { SCENARIOS, scriptedTurns } from './scenarios.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
// The server reads its MCP secret only from here; a run never writes it, only reads what the server made.
const SECRET_FILE = join(REPO, 'tunnel', 'secret.txt');
export const MCP_PREFIX = 'mcp__dnd-ai__';

/** With the ISOLATION flags, keeps the owner's CLAUDE.md, auto-memory, settings (hooks, plugins, MCP servers) and skills out of both sessions. */
export const CLAUDE_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' };
export const ISOLATION = ['--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands'];

export interface Usage {
  duration_ms: number | null;
  duration_api_ms: number | null;
  num_turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  total_cost_usd: number | null;
}
const USAGE_KEYS = [
  'duration_ms',
  'duration_api_ms',
  'num_turns',
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'total_cost_usd',
] as const;
const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;

export interface ToolCall {
  name: string;
  input: unknown;
}

export interface TranscriptEntry {
  turn: number;
  /** `session` marks a session break, not a message. */
  role: 'player' | 'dm' | 'session';
  text: string;
  tool_calls?: ToolCall[];
  at: string;
  started_at?: string;
  finished_at?: string;
  usage?: Usage;
  stalled?: Stall;
  session_break?: SessionBreak;
}

/** A claude child killed for running past its per-turn timeout; the run ends on that turn. */
export interface Stall {
  turn: number;
  role: 'player' | 'dm';
  elapsed_ms: number;
}

/** A fresh DM session (no --resume) starting on `turn` from the save the previous one made. */
export interface SessionBreak {
  turn: number;
  old_dm_session_id: string | null;
  new_dm_session_id: string | null;
  /** Set when the DM ended the session itself; a scheduled break has none. */
  reason?: 'dm_ended';
}

export interface Meta {
  started_at: string;
  finished_at: string | null;
  port: number;
  secret: string;
  db_path: string;
  campaign_id: number | null;
  dm_model: string;
  player: 'scripted' | 'claude';
  player_model: string | null;
  scenario: string;
  /** The code that ran; absent in runs from before these were recorded. */
  git_branch?: string | null;
  git_commit?: string | null;
  turns_played: number;
  dm_session_id: string | null;
  dm_init: ReturnType<typeof initSummary> | null;
  /** Sums over the DM turns, plus the run's wall time. */
  totals: Usage & { wall_ms: number | null };
  /** Sums over the Claude player's turns; null for a scripted player. */
  player_totals: Usage | null;
  error: string | null;
  /** Why the window was dropped, after which rolls go over the API; null while it is healthy. Absent in older runs, as are the fields below. */
  window_error?: string | null;
  /** Ids of player rolls the window left waiting past MISSED_ROLL_MS, answered over the API instead. */
  window_missed_rolls?: number[];
  stalled?: Stall | null;
  session_breaks?: SessionBreak[];
}

export interface ParsedStream {
  sessionId: string | null;
  /** Every assistant text block of the turn, in order; the result's text when none was seen. */
  text: string;
  /** True when a `checkpoint` call with `op: "end_session"` came back without an error. */
  endedSession: boolean;
  toolCalls: ToolCall[];
  init: Record<string, any> | null;
  usage: Usage;
  /** The result's running totals, passed back in for the next turn of the same session. */
  session: SessionTotals;
  hasResult: boolean;
  isError: boolean;
}

export interface SessionTotals {
  duration_api_ms: number | null;
  total_cost_usd: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Reads a `--output-format stream-json --verbose` run: the turn's text, tool calls, session id, init event and usage. */
export function parseStream(raw: string, previous: SessionTotals | null = null): ParsedStream {
  let sessionId: string | null = null;
  let init: Record<string, any> | null = null;
  let result: Record<string, any> | null = null;
  const texts: string[] = [];
  const endCalls = new Set<string>();
  let endedSession = false;
  const toolCalls: ToolCall[] = [];
  const seenTools = new Set<string>();
  // An assistant message is streamed once per content block, each repeating its usage, so usage is kept per message id.
  const messageUsage = new Map<string, Record<string, unknown>>();
  for (const line of raw.split(/\r?\n/)) {
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    if (typeof event.session_id === 'string') sessionId = event.session_id;
    if (event.type === 'system' && event.subtype === 'init') init = event;
    else if (event.type === 'result') result = event;
    else if (event.type === 'user') {
      for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (block?.type === 'tool_result' && endCalls.has(block.tool_use_id) && block.is_error !== true) endedSession = true;
      }
    } else if (event.type === 'assistant') {
      const message = event.message ?? {};
      if (typeof message.id === 'string' && message.usage) messageUsage.set(message.id, message.usage);
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          if (!texts.includes(block.text.trim())) texts.push(block.text.trim());
        }
        if (block?.type === 'tool_use' && !seenTools.has(block.id)) {
          seenTools.add(block.id);
          const name = String(block.name);
          if (name === `${MCP_PREFIX}checkpoint` && block.input?.op === 'end_session') endCalls.add(block.id);
          toolCalls.push({ name: name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name, input: block.input ?? {} });
        }
      }
    }
  }
  const perMessage = (key: string): number | null => {
    let total: number | null = null;
    for (const u of messageUsage.values()) {
      const v = num(u[key]);
      if (v !== null) total = (total ?? 0) + v;
    }
    return total;
  };
  const usage = Object.fromEntries(USAGE_KEYS.map((k) => [k, num(result?.[k])])) as unknown as Usage;
  for (const k of TOKEN_KEYS) usage[k] = num(result?.usage?.[k]) ?? perMessage(k);
  // A resumed session reports the running cost and API time, so those are differenced against the previous turn.
  const session = { duration_api_ms: usage.duration_api_ms, total_cost_usd: usage.total_cost_usd };
  const delta = (now: number | null, before: number | null | undefined) =>
    now !== null && before != null && now >= before ? now - before : now;
  const since = Object.values((result?.model_usage_since_last_result ?? {}) as Record<string, { costUSD?: unknown }>)
    .map((m) => num(m?.costUSD))
    .filter((v): v is number => v !== null);
  usage.duration_api_ms = delta(session.duration_api_ms, previous?.duration_api_ms);
  usage.total_cost_usd = since.length ? since.reduce((a, b) => a + b, 0) : delta(session.total_cost_usd, previous?.total_cost_usd);
  return {
    sessionId,
    text: texts.length ? texts.join('\n\n') : typeof result?.result === 'string' ? result.result : '',
    endedSession,
    toolCalls,
    init,
    usage,
    session,
    hasResult: result !== null,
    isError: result === null || result.is_error === true,
  };
}

/** Field-wise sum; a field stays null only when every entry lacks it. */
export function sumUsage(list: Usage[]): Usage {
  const out = Object.fromEntries(USAGE_KEYS.map((k) => [k, null])) as unknown as Usage;
  for (const u of list) for (const k of USAGE_KEYS) if (u[k] !== null) out[k] = (out[k] ?? 0) + u[k]!;
  return out;
}

// Commander would read a leading dash as an option, so such a prompt gets a leading space.
const safePrompt = (prompt: string): string => (prompt.startsWith('-') ? ` ${prompt}` : prompt);

/** The DM's claude arguments; the prompt sits right after -p because the variadic options would swallow it later. */
export function dmArgs(o: { prompt: string; model: string; mcpConfig: string; instructions: string; sessionId: string | null }): string[] {
  return [
    ...['-p', safePrompt(o.prompt), '--model', o.model],
    ...['--mcp-config', o.mcpConfig, '--append-system-prompt-file', o.instructions],
    ...['--tools', '', '--allowedTools', 'mcp__dnd-ai', ...ISOLATION],
    ...['--output-format', 'stream-json', '--verbose'],
    ...(o.sessionId ? ['--resume', o.sessionId] : []),
  ];
}

/** The Claude player's arguments: no tools, no MCP servers, its own short system prompt. */
export function playerArgs(o: { prompt: string; model: string; persona: string; sessionId: string | null }): string[] {
  return [
    ...['-p', safePrompt(o.prompt), '--model', o.model, '--system-prompt', o.persona],
    ...['--tools', '', ...ISOLATION],
    ...['--output-format', 'stream-json', '--verbose'],
    ...(o.sessionId ? ['--resume', o.sessionId] : []),
  ];
}

export function personaPrompt(goal: string, brief?: string): string {
  return [
    'You are a novice player in a solo D&D game run by an AI Dungeon Master.',
    'Speak only as the player: say what your character does or answer the DM, in one or two plain sentences.',
    'Never narrate outcomes, describe the world, roll dice, invent numbers or play the DM.',
    `What you want from this session: ${goal}`,
    'The harness handles session breaks: never ask to stop, save or end the session yourself unless your brief says so.',
    ...(brief ? [`Your aims over the whole game, pursued in character: ${brief}`] : []),
  ].join(' ');
}

export function playerPrompt(lastDm: string | null): string {
  if (lastDm === null) return 'The session is starting and the DM is waiting for you. What do you say?';
  return `The DM says:\n\n${lastDm.trim() || '(nothing)'}\n\nWhat do you say or do?`;
}

/** The throwaway server's environment: the owner's minus the Cloudflare keys, so a run never spends image quota. */
export function serverEnv(env: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('CLOUDFLARE_'))), ...extra };
}

/** What the DM session sees, from its init event. */
export function initSummary(init: Record<string, any>) {
  return {
    model: init.model ?? null,
    claude_code_version: init.claude_code_version ?? null,
    cwd: init.cwd ?? null,
    mcp_servers: init.mcp_servers ?? [],
    tools: (init.tools ?? []) as string[],
    slash_commands: init.slash_commands ?? [],
    skills: init.skills ?? [],
    plugins: ((init.plugins ?? []) as Array<{ name?: string }>).map((p) => p.name),
    memory_paths: init.memory_paths ?? null,
    output_style: init.output_style ?? null,
  };
}

/** Anything the DM sees beyond the dnd-ai server's tools is a leak of the owner's setup. */
export function isolationProblems(init: Record<string, any> | null): string[] {
  if (!init) return ['the stream had no init event'];
  const problems: string[] = [];
  const tools = (init.tools ?? []) as string[];
  const foreign = tools.filter((t) => !t.startsWith(MCP_PREFIX));
  if (foreign.length) problems.push(`tools outside dnd-ai: ${foreign.join(', ')}`);
  if (tools.length === foreign.length) problems.push('no dnd-ai tools');
  const servers = (init.mcp_servers ?? []) as Array<{ name?: string; status?: string }>;
  if (servers.length !== 1 || servers[0].name !== 'dnd-ai' || servers[0].status !== 'connected') {
    problems.push(`MCP servers: ${JSON.stringify(servers)}`);
  }
  if ((init.skills ?? []).length) problems.push(`skills: ${init.skills.join(', ')}`);
  if (init.memory_paths) problems.push('auto-memory is on');
  return problems;
}

export function runStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function writeMeta(runDir: string, meta: Meta): void {
  writeFileSync(join(runDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
}

export function appendTranscript(runDir: string, entry: TranscriptEntry): void {
  appendFileSync(join(runDir, 'transcript.jsonl'), `${JSON.stringify(entry)}\n`);
}

export const SESSION_END_LINE = "Let's stop here for today. Please save the game and end the session so we can pick it up next time.";
export const SESSION_RESUME_LINE = "Let's continue our campaign. Please load the saved game and remind us where we left off.";

/** The harness's line for the player at a session break: the save on a session's last turn, the resume opening on the next one's first. */
export function sessionLine(turn: number, every: number, lastTurn: number, offset = 0): string | null {
  if (every < 2) return null;
  const t = turn - offset; // `offset` is the last turn of a session the DM ended early, restarting the schedule
  if (t % every === 0 && turn < lastTurn) return SESSION_END_LINE;
  if (t > every && (t - 1) % every === 0) return SESSION_RESUME_LINE;
  return null;
}

/** Notes a session break in meta and the transcript once the fresh DM session has its id. */
export function recordSessionBreak(runDir: string, meta: Meta, b: SessionBreak): void {
  meta.session_breaks = [...(meta.session_breaks ?? []), b];
  appendTranscript(runDir, {
    turn: b.turn,
    role: 'session',
    text: `New DM session ${b.new_dm_session_id ?? '(no id)'} resumes from the save of ${b.old_dm_session_id ?? '(no id)'}.`,
    at: new Date().toISOString(),
    session_break: b,
  });
}

export interface Options {
  scenario: string;
  turns: number;
  dmModel: string;
  player: 'scripted' | 'claude';
  playerModel: string;
  window: boolean;
  dmTimeoutMs: number;
  playerTimeoutMs: number;
  /** Turns per game session; 0 plays the whole run as one session. */
  sessionEvery: number;
}

export function parseCli(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    allowNegative: true,
    options: {
      scenario: { type: 'string', default: 'first-session' },
      turns: { type: 'string', default: '12' },
      'dm-model': { type: 'string', default: 'sonnet' },
      player: { type: 'string', default: 'scripted' },
      'player-model': { type: 'string', default: 'haiku' },
      window: { type: 'boolean', default: true },
      'dm-timeout': { type: 'string', default: '10' },
      'player-timeout': { type: 'string', default: '10' },
      'session-every': { type: 'string' },
    },
  });
  const turns = Number(values.turns);
  if (!Number.isInteger(turns) || turns < 1) throw new Error('--turns must be a positive integer');
  if (values.player !== 'scripted' && values.player !== 'claude') throw new Error('--player is scripted or claude');
  const scenario = SCENARIOS[values.scenario];
  if (!scenario) throw new Error(`Unknown scenario "${values.scenario}"; known: ${Object.keys(SCENARIOS).join(', ')}`);
  const minutes = (flag: 'dm-timeout' | 'player-timeout'): number => {
    const n = Number(values[flag]);
    if (!(n > 0)) throw new Error(`--${flag} must be a positive number of minutes`);
    return n * 60_000;
  };
  const sessionEvery = values['session-every'] === undefined ? (scenario.sessionEvery ?? 0) : Number(values['session-every']);
  if (!Number.isInteger(sessionEvery) || sessionEvery < 0 || sessionEvery === 1) throw new Error('--session-every is 0 or a whole number of turns from 2');
  return {
    scenario: values.scenario,
    turns,
    dmModel: values['dm-model'],
    player: values.player,
    playerModel: values['player-model'],
    window: values.window,
    dmTimeoutMs: minutes('dm-timeout'),
    playerTimeoutMs: minutes('player-timeout'),
    sessionEvery,
  };
}

/** Takes the harness-only `--no-judge` off the arguments, leaving the rest for parseCli. */
export function judgeFlag(argv: string[]): { judge: boolean; rest: string[] } {
  return { judge: !argv.includes('--no-judge'), rest: argv.filter((arg) => arg !== '--no-judge') };
}

const gitOut = (...args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
};

interface PublishModule {
  publishRun(runDir: string, root: string): Promise<string>;
  reportsRoot(): string;
}
interface ReportModule {
  writeReport(runDir: string): Promise<{ reportPath: string; leaks: number }>;
}
interface JudgeModule {
  judgeRun(runDir: string): Promise<{ judgePath: string; verdict: string | null }>;
}
interface WindowHandle {
  setCampaign(id: number): Promise<void>;
  screenshot(label: string): Promise<string>;
  close(): Promise<void>;
}
interface WindowModule {
  startWindow(opts: { port: number; campaignId: number | null; outDir: string; answerRolls: boolean }): Promise<WindowHandle>;
}

/** A sibling package's module, or null when that package has not landed on this branch. */
async function sibling<T>(file: string): Promise<T | null> {
  const url = new URL(file, import.meta.url);
  if (!existsSync(fileURLToPath(url))) return null;
  return (await import(url.href)) as T;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

let running: ChildProcess | null = null;

/** Runs one claude turn; past `timeoutMs` the child is killed and the result marked stalled. */
export function runClaude(
  args: string[],
  cwd: string,
  streamFile: string,
  timeoutMs: number,
  command = 'claude',
): Promise<{ raw: string; code: number | null; stderr: string; stalled: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...CLAUDE_ENV }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    running = child;
    let raw = '';
    let stderr = '';
    let stalled = false;
    const timer = setTimeout(() => {
      stalled = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (raw += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      running = null;
      writeFileSync(streamFile, raw);
      resolve({ raw, code, stderr, stalled });
    });
  });
}

/** Builds the companion window from this checkout, so screenshots never show a missing or stale web/dist. */
function buildWeb(logFile: string): void {
  console.log('Building the companion window (npm --prefix web run build)...');
  const out = spawnSync('npm --prefix web run build', { cwd: REPO, shell: true, encoding: 'utf8', windowsHide: true });
  writeFileSync(logFile, `${out.stdout ?? ''}${out.stderr ?? ''}${out.error ? `\n${out.error.message}` : ''}`);
  if (out.status !== 0) throw new Error(`The web build failed (exit ${out.status}), so the window would show "Not found"; see ${logFile}`);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

/** A player roll still open after this long is one the window missed; the server's own auto-roll waits far longer. */
export const MISSED_ROLL_MS = 10_000;

/** Answers open player rolls (only those older than `olderThanMs`) the way the window's Roll button does: the server rolls, nothing is edited. Returns the ids resolved. */
export async function answerRolls(base: string, campaignId: number, olderThanMs = 0): Promise<number[]> {
  const rolls = await getJson<Array<{ id: number; purpose?: string; created_at: string }>>(`${base}/api/campaigns/${campaignId}/pending-rolls`);
  const answered: number[] = [];
  for (const roll of rolls) {
    if (Date.now() - Date.parse(roll.created_at) < olderThanMs) continue;
    const res = await fetch(`${base}/api/rolls/${roll.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    console.log(`  rolled for the player: #${roll.id} ${roll.purpose ?? ''} -> ${res.status}`);
    if (res.ok) answered.push(roll.id);
  }
  return answered;
}

/** Writes the report, has the judge write judge.md unless skipped, then publishes; a failing judge is logged and never stops the rest. */
export async function afterRun(runDir: string, judge: boolean, load: <T>(file: string) => Promise<T | null> = sibling): Promise<void> {
  try {
    const report = await load<ReportModule>('./report.mts');
    if (report) {
      const { reportPath, leaks } = await report.writeReport(runDir);
      console.log(`Report: ${reportPath} (${leaks} leaks)`);
      if (judge) {
        try {
          const mod = await load<JudgeModule>('./judge.mts');
          if (mod) {
            const { judgePath, verdict } = await mod.judgeRun(runDir);
            console.log(`Judge: ${judgePath}${verdict ? ` - ${verdict}` : ''}`);
            // Written again so the report points at the verdict.
            await report.writeReport(runDir);
          }
        } catch (err) {
          console.error(`Judge failed: ${(err as Error).message}`);
        }
      }
      const publish = await load<PublishModule>('./publish.mts');
      if (publish) console.log(`Published: ${await publish.publishRun(runDir, publish.reportsRoot())}`);
    } else {
      console.log('report.mts is not on this branch; no report written.');
    }
  } catch (err) {
    console.error(`Report failed: ${(err as Error).message}`);
  }
}

async function main(argv: string[]): Promise<number> {
  const { judge, rest } = judgeFlag(argv);
  const opts = parseCli(rest);
  const scenario = SCENARIOS[opts.scenario];
  const runDir = join(REPO, 'logs', 'playtest', runStamp());
  const dmDir = join(runDir, 'dm');
  const playerDir = join(runDir, 'player');
  const streamsDir = join(runDir, 'streams');
  for (const dir of [dmDir, streamsDir, join(runDir, 'screenshots')]) mkdirSync(dir, { recursive: true });
  if (opts.player === 'claude') mkdirSync(playerDir, { recursive: true });
  const startedMs = Date.now();
  console.log(`Run folder: ${runDir}`);
  if (opts.window) buildWeb(join(runDir, 'web-build.log'));

  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log('Interrupted; shutting down (Ctrl-C again to force).');
    running?.kill();
  });

  const logFd = openSync(join(runDir, 'server.log'), 'a');
  let server: ChildProcess | null = null;
  let window: WindowHandle | null = null;
  let meta: Meta | null = null;
  const dmUsage: Usage[] = [];
  const playerUsage: Usage[] = [];
  const save = () => {
    if (!meta) return;
    meta.totals = { ...sumUsage(dmUsage), wall_ms: Date.now() - startedMs };
    meta.player_totals = opts.player === 'claude' ? sumUsage(playerUsage) : null;
    writeMeta(runDir, meta);
  };

  try {
    const port = await freePort();
    const dbPath = join(runDir, 'game.sqlite');
    server = spawn(process.execPath, ['--import', 'tsx', 'src/bin/http.ts'], {
      cwd: REPO,
      env: serverEnv(process.env, {
        DND_AI_PORT: String(port),
        DND_AI_DB: dbPath,
        DND_BACKUP_DIR: join(runDir, 'backups'),
        DND_AI_PORTRAITS_DIR: join(runDir, 'portraits'),
      }),
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      if (server.exitCode !== null) throw new Error(`server exited with ${server.exitCode}; see server.log`);
      if (interrupted) throw new Error('interrupted');
      if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) break;
      if (i > 240) throw new Error('server did not answer /healthz within 60 s');
      await delay(250);
    }
    const secret = readFileSync(SECRET_FILE, 'utf8').trim();
    const mcpConfig = join(runDir, 'mcp.json');
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { 'dnd-ai': { type: 'http', url: `${base}/mcp/${secret}` } } }, null, 2));
    meta = {
      started_at: new Date(startedMs).toISOString(),
      finished_at: null,
      port,
      secret,
      db_path: dbPath,
      campaign_id: null,
      dm_model: opts.dmModel,
      player: opts.player,
      player_model: opts.player === 'claude' ? opts.playerModel : null,
      scenario: opts.scenario,
      git_branch: gitOut('rev-parse', '--abbrev-ref', 'HEAD'),
      git_commit: gitOut('rev-parse', '--short', 'HEAD'),
      turns_played: 0,
      dm_session_id: null,
      dm_init: null,
      totals: { ...sumUsage([]), wall_ms: null },
      player_totals: null,
      error: null,
      window_error: null,
      window_missed_rolls: [],
      stalled: null,
      session_breaks: [],
    };
    if (scenario.seed) {
      // The server is already up on this file (WAL), so a second connection seeds what the DM will find.
      const seedDb = openDb(dbPath);
      try {
        meta.campaign_id = scenario.seed(seedDb);
      } finally {
        seedDb.close();
      }
      console.log(`  seeded campaign ${meta.campaign_id}`);
    }
    save();

    /** Records why the window is gone; from here on rolls are answered over the API and no screenshots are taken. */
    const dropWindow = async (reason: string): Promise<void> => {
      meta!.window_error = reason;
      save();
      console.warn(`\n!!! PLAYTEST WINDOW FAILED: ${reason}\n!!! No more screenshots; player rolls are answered over the API for the rest of the run.\n`);
      const broken = window;
      window = null;
      await broken?.close().catch((err: Error) => console.warn(`window close: ${err.message}`));
    };

    if (opts.window) {
      const mod = await sibling<WindowModule>('./window.mts');
      if (!mod) console.warn('window.mts is not on this branch; rolls are answered over the API instead.');
      else {
        window = await mod
          .startWindow({ port, campaignId: meta.campaign_id, outDir: join(runDir, 'screenshots'), answerRolls: true })
          .catch(async (err: Error) => {
            await dropWindow(`the window failed to start: ${err.message}`);
            return null;
          });
      }
    }

    const watch = async () => {
      const campaigns = await getJson<Array<{ id: number }>>(`${base}/api/campaigns`);
      const latest = campaigns.at(-1)?.id ?? null;
      if (latest !== null && latest !== meta!.campaign_id) {
        meta!.campaign_id = latest;
        save();
        console.log(`  campaign ${latest}`);
        await window?.setCampaign(latest).catch((err: Error) => dropWindow(err.message));
      }
      const id = meta!.campaign_id;
      if (id === null) return;
      if (!window) {
        await answerRolls(base, id);
        return;
      }
      const missed = await answerRolls(base, id, MISSED_ROLL_MS);
      if (missed.length) {
        meta!.window_missed_rolls = [...(meta!.window_missed_rolls ?? []), ...missed];
        save();
        console.warn(`  the window missed roll ${missed.map((r) => `#${r}`).join(', ')}; answered over the API`);
      }
    };

    /** Ends the run on a turn whose claude child was killed for running past its timeout. */
    const stall = (turn: number, role: 'player' | 'dm', started_at: string): void => {
      const finished_at = new Date().toISOString();
      const stalled = { turn, role, elapsed_ms: Date.parse(finished_at) - Date.parse(started_at) };
      const text = `(stalled: no reply after ${Math.round(stalled.elapsed_ms / 1000)} s; the ${role} was stopped and the run ends here)`;
      meta!.stalled = stalled;
      appendTranscript(runDir, { turn, role, text, at: finished_at, started_at, finished_at, stalled });
      save();
      console.warn(`[turn ${turn}] ${text}`);
    };

    const scripted = scriptedTurns(opts.scenario, opts.turns);
    const persona = personaPrompt(scenario.goal, scenario.playerBrief);
    const instructions = join(REPO, 'docs', 'dm-instructions.md');
    let playerSession: string | null = null;
    let playerTotals: SessionTotals | null = null;
    let dmTotals: SessionTotals | null = null;
    let lastDm: string | null = null;
    let endedAt = 0;

    for (let turn = 1; turn <= opts.turns && !interrupted; turn++) {
      const nn = String(turn).padStart(2, '0');
      const dmEnded = endedAt > 0 && turn === endedAt + 1;
      const breakLine = dmEnded ? SESSION_RESUME_LINE : sessionLine(turn, opts.sessionEvery, opts.turns, endedAt);
      let playerText: string;
      if (breakLine !== null) {
        playerText = breakLine;
        appendTranscript(runDir, { turn, role: 'player', text: playerText, at: new Date().toISOString() });
      } else if (opts.player === 'scripted') {
        const next = scripted.next();
        if (next.done) break;
        playerText = next.value;
        appendTranscript(runDir, { turn, role: 'player', text: playerText, at: new Date().toISOString() });
      } else {
        const started_at = new Date().toISOString();
        const args = playerArgs({ prompt: playerPrompt(lastDm), model: opts.playerModel, persona, sessionId: playerSession });
        const run = await runClaude(args, playerDir, join(streamsDir, `player-${nn}.jsonl`), opts.playerTimeoutMs);
        const parsed = parseStream(run.raw, playerTotals);
        if (interrupted) throw new Error('interrupted');
        if (run.stalled) {
          stall(turn, 'player', started_at);
          break;
        }
        if (parsed.isError || !parsed.text.trim()) throw new Error(`player claude failed (exit ${run.code}): ${run.stderr.slice(-500) || parsed.text}`);
        playerSession = parsed.sessionId;
        playerTotals = parsed.session;
        playerText = parsed.text.trim();
        playerUsage.push(parsed.usage);
        const finished_at = new Date().toISOString();
        appendTranscript(runDir, { turn, role: 'player', text: playerText, at: finished_at, started_at, finished_at, usage: parsed.usage });
      }
      console.log(`[turn ${turn}] player: ${playerText}`);

      let sessionBreak: SessionBreak | null = null;
      if (breakLine === SESSION_RESUME_LINE) {
        // A fresh DM session tests resuming from the save; its running totals count from zero again.
        sessionBreak = { turn, old_dm_session_id: meta.dm_session_id, new_dm_session_id: null, ...(dmEnded ? { reason: 'dm_ended' as const } : {}) };
        meta.dm_session_id = null;
        dmTotals = null;
        console.log(`[turn ${turn}] session break: a fresh DM session resumes from the save`);
      }
      const started_at = new Date().toISOString();
      let stopped = false;
      const watcher = (async () => {
        while (!stopped) {
          await watch().catch((err: Error) => console.warn(`  watch: ${err.message}`));
          await delay(1000);
        }
      })();
      const args = dmArgs({ prompt: playerText, model: opts.dmModel, mcpConfig, instructions, sessionId: meta.dm_session_id });
      const run = await runClaude(args, dmDir, join(streamsDir, `dm-${nn}.jsonl`), opts.dmTimeoutMs).finally(async () => {
        stopped = true;
        await watcher;
      });
      await watch().catch((err: Error) => console.warn(`  watch: ${err.message}`));
      const parsed = parseStream(run.raw, dmTotals);
      dmTotals = parsed.session;
      if (sessionBreak) recordSessionBreak(runDir, meta, { ...sessionBreak, new_dm_session_id: parsed.sessionId });
      const finished_at = new Date().toISOString();
      if (parsed.hasResult) {
        appendTranscript(runDir, {
          turn,
          role: 'dm',
          text: parsed.text,
          tool_calls: parsed.toolCalls,
          at: finished_at,
          started_at,
          finished_at,
          usage: parsed.usage,
        });
        dmUsage.push(parsed.usage);
      }
      if (interrupted) throw new Error('interrupted');
      if (run.stalled) {
        stall(turn, 'dm', started_at);
        break;
      }
      if (turn === 1) {
        meta.dm_init = parsed.init ? initSummary(parsed.init) : null;
        save();
        const problems = isolationProblems(parsed.init);
        if (problems.length) throw new Error(`DM session is not isolated: ${problems.join('; ')}`);
      }
      if (parsed.isError) throw new Error(`DM claude failed (exit ${run.code}): ${run.stderr.slice(-500) || parsed.text}`);
      meta.dm_session_id = parsed.sessionId ?? meta.dm_session_id;
      meta.turns_played = turn;
      lastDm = parsed.text;
      if (parsed.endedSession && breakLine !== SESSION_END_LINE) endedAt = turn;
      save();
      const seconds = ((Date.parse(finished_at) - Date.parse(started_at)) / 1000).toFixed(0);
      console.log(`[turn ${turn}] dm (${parsed.toolCalls.length} tool calls, ${seconds}s): ${parsed.text.slice(0, 300)}`);
      if (window) await window.screenshot(`turn-${nn}`).catch((err: Error) => console.warn(`  screenshot: ${err.message}`));
    }
  } catch (err) {
    console.error(`Run failed: ${(err as Error).message}`);
    if (meta) meta.error = (err as Error).message;
  } finally {
    running?.kill();
    await window?.close().catch((err: Error) => console.warn(`window close: ${err.message}`));
    if (server && server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    closeSync(logFd);
    if (meta) {
      meta.finished_at = new Date().toISOString();
      save();
    }
  }

  await afterRun(runDir, judge && !interrupted);
  console.log(`Run folder: ${runDir}`);
  return meta?.error || meta?.stalled ? 1 : 0;
}

if (process.argv[1]?.endsWith('run.mts')) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err: Error) => {
      console.error(err.message);
      process.exitCode = 1;
    },
  );
}
