// Publishes playtest run folders to one central, gitignored folder (<main checkout>/playtest-reports) and rebuilds its index.md.
// Usage: node --import tsx scripts/playtest/publish.mts [--all] [runDir...]
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fullStats, parseLog } from '../toolstats.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
/** Fields that name the machine's ports, paths or the MCP secret; never published. */
const DROPPED_META = ['secret', 'port', 'db_path'];
const DROPPED_REPORT_ROWS = /^\| (secret|port|db_path) \|/;

type Meta = Record<string, any>;

const git = (cwd: string, ...args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
};

/** The main checkout's root, resolved from any worktree. */
export function mainCheckout(from = REPO): string {
  const common = git(from, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!common) throw new Error(`not inside a git checkout: ${from}`);
  return dirname(resolve(common));
}

export function reportsRoot(): string {
  return process.env.DND_AI_PLAYTEST_REPORTS ? resolve(process.env.DND_AI_PLAYTEST_REPORTS) : join(mainCheckout(), 'playtest-reports');
}

/** `scripted` or `claude-<model>`. */
const playerSlug = (meta: Meta): string => (meta.player === 'claude' ? `claude-${meta.player_model ?? 'unknown'}` : 'scripted');
const playerLabel = (meta: Meta): string => (meta.player === 'claude' ? `Claude (${meta.player_model ?? 'unknown'})` : 'Scripted');
const playerLine = (meta: Meta): string =>
  meta.player === 'claude' ? `Player: Claude (${meta.player_model ?? 'unknown'}) — free-form` : `Player: scripted (${meta.scenario} lines)`;

/** Copies the allowed files of one run into <root>/<stamp>-<scenario>-<player>/, replacing that folder; returns it. */
export async function publishRun(runDir: string, root: string): Promise<string> {
  const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as Meta;
  const reportFile = join(runDir, 'report.md');
  if (!existsSync(reportFile)) throw new Error(`no report.md in ${runDir}`);
  const out = join(root, `${basename(runDir)}-${meta.scenario}-${playerSlug(meta)}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const published: Meta = { ...meta };
  for (const key of DROPPED_META) delete published[key];
  published.git_branch ??= git(runDir, 'rev-parse', '--abbrev-ref', 'HEAD');
  published.git_commit ??= git(runDir, 'rev-parse', '--short', 'HEAD');
  writeFileSync(join(out, 'meta.json'), `${JSON.stringify(published, null, 2)}\n`);

  const report = readFileSync(reportFile, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !DROPPED_REPORT_ROWS.test(line))
    .join('\n');
  writeFileSync(join(out, 'report.md'), `${playerLine(meta)}\n\n${report}`);

  const log = join(runDir, 'server.log');
  const lines = existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/) : [];
  writeFileSync(join(out, 'toolstats.json'), JSON.stringify(fullStats(parseLog(lines)), null, 2));
  if (existsSync(join(runDir, 'transcript.jsonl'))) cpSync(join(runDir, 'transcript.jsonl'), join(out, 'transcript.jsonl'));
  if (existsSync(join(runDir, 'screenshots'))) cpSync(join(runDir, 'screenshots'), join(out, 'screenshots'), { recursive: true });
  rebuildIndex(root);
  return out;
}

const dash = (v: string | number | null | undefined): string => (v === null || v === undefined || v === '' ? '-' : String(v));
const secs = (ms: unknown): string => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : '-');
const cost = (usd: unknown): string => (typeof usd === 'number' ? `$${usd.toFixed(2)}` : '-');

interface Row {
  startedAt: string;
  player: string;
  cells: string[];
}

const HEADER = [
  'Date', 'Branch @ commit', 'Scenario', 'Player', 'Turns', 'Wall', 'Model time', 'Hops', 'Cost', 'Calls/turn',
  'Tool calls', 'Refusals', 'tools/list tokens', 'Leaks', 'Report',
];

function readRow(root: string, folder: string): Row | null {
  const dir = join(root, folder);
  if (!existsSync(join(dir, 'meta.json'))) return null;
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Meta;
  const report = existsSync(join(dir, 'report.md')) ? readFileSync(join(dir, 'report.md'), 'utf8') : '';
  const stats = existsSync(join(dir, 'toolstats.json')) ? JSON.parse(readFileSync(join(dir, 'toolstats.json'), 'utf8')) : null;
  const totals = (meta.totals ?? {}) as Record<string, number | null>;
  const perTurn = /Calls per player turn \([^)]*\): \d+ turns, mean ([\d.]+)/.exec(report)?.[1];
  const tokens = /weigh \d+ bytes \(~(\d+) tokens\)/.exec(report)?.[1];
  const leaks = /Leaks found: \*\*(\d+)\*\*/.exec(report)?.[1];
  const refusals = stats ? (stats.perTool as Array<{ errors: number }>).reduce((a, t) => a + t.errors, 0) : null;
  const branch = meta.git_branch ? `${meta.git_branch} @ ${meta.git_commit ?? '?'}` : null;
  return {
    startedAt: String(meta.started_at ?? ''),
    player: meta.player === 'claude' ? 'claude' : 'scripted',
    cells: [
      String(meta.started_at ?? '').slice(0, 16).replace('T', ' '),
      dash(branch),
      dash(meta.scenario),
      playerLabel(meta),
      dash(meta.turns_played),
      secs(totals.wall_ms),
      secs(totals.duration_api_ms),
      dash(totals.num_turns),
      cost(totals.total_cost_usd),
      dash(perTurn),
      dash(stats?.calls),
      dash(refusals),
      dash(tokens),
      dash(leaks),
      `[report](${folder}/report.md)`,
    ],
  };
}

/** Rewrites <root>/index.md from every published folder: one table per player kind, newest first. */
export function rebuildIndex(root: string): string {
  const rows = readdirSync(root)
    .filter((f) => statSync(join(root, f)).isDirectory())
    .map((f) => readRow(root, f))
    .filter((r): r is Row => r !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const section = (title: string, kind: string): string[] => [
    `## ${title}`,
    '',
    `| ${HEADER.join(' | ')} |`,
    `| ${HEADER.map(() => '---').join(' | ')} |`,
    ...rows.filter((r) => r.player === kind).map((r) => `| ${r.cells.join(' | ')} |`),
    '',
  ];
  const text = [
    '# Playtest reports',
    '',
    'Cost is the list-price equivalent. Compare runs only within their own table.',
    '',
    ...section('Claude player runs', 'claude'),
    ...section('Scripted player runs', 'scripted'),
  ].join('\n');
  writeFileSync(join(root, 'index.md'), text);
  return text;
}

/** Every logs/playtest/* run folder under the main checkout and all its worktrees. */
export function allRunDirs(): string[] {
  const trees = (git(mainCheckout(), 'worktree', 'list', '--porcelain') ?? '')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => resolve(l.slice('worktree '.length)));
  return [...new Set([mainCheckout(), ...trees])].flatMap((tree) => {
    const base = join(tree, 'logs', 'playtest');
    return existsSync(base) ? readdirSync(base).map((d) => join(base, d)).filter((d) => existsSync(join(d, 'meta.json'))) : [];
  });
}

async function main(argv: string[]): Promise<number> {
  const all = argv.includes('--all');
  const dirs = [...argv.filter((a) => a !== '--all').map((a) => resolve(a)), ...(all ? allRunDirs() : [])];
  if (dirs.length === 0) {
    console.error('usage: node --import tsx scripts/playtest/publish.mts [--all] [runDir...]');
    return 2;
  }
  const root = reportsRoot();
  mkdirSync(root, { recursive: true });
  let failed = 0;
  for (const dir of dirs) {
    try {
      console.log(`published ${dir} -> ${await publishRun(dir, root)}`);
    } catch (err) {
      failed++;
      console.warn(`skipped ${dir}: ${(err as Error).message}`);
    }
  }
  rebuildIndex(root);
  console.log(`Index: ${join(root, 'index.md')}`);
  return failed === dirs.length ? 1 : 0;
}

if (process.argv[1]?.endsWith('publish.mts')) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err: Error) => {
      console.error(err.message);
      process.exitCode = 1;
    },
  );
}
