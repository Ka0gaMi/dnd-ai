// Metrics over the server's tool-call log: calls per turn, redundant reads, refusal rate, reply size.
// Usage: node --import tsx scripts/toolstats.mts [--gap seconds] [log files...] (default logs/server*.log)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const READ_TOOL = /^(get_|list_|load_campaign$|read_guide$|srd_lookup$)/;
export const READ_OPS = /^(get|list|read|lookup|load|describe|show|search)(_|$)/;

export interface Call {
  time: number;
  name: string;
  args: string;
  op: string | undefined;
  error?: boolean;
  bytes?: number;
}

const LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (tools\/call|tools\/result) (\S+) ?(.*)$/;
const RESULT = /^(ok|error) (\d+)ms (\d+)B/;
const OP = /"op"\s*:\s*"([^"]*)"/;

/** Parses log lines into calls; results are paired with the oldest unanswered call of the same tool. */
export function parseLog(lines: string[]): Call[] {
  const calls: Call[] = [];
  const open = new Map<string, Call[]>();
  for (const line of lines) {
    const m = LINE.exec(line);
    if (!m) continue;
    const [, ts, kind, name, rest] = m;
    if (kind === 'tools/call') {
      const call: Call = { time: Date.parse(ts), name, args: rest, op: OP.exec(rest)?.[1] };
      calls.push(call);
      open.set(name, [...(open.get(name) ?? []), call]);
    } else {
      const r = RESULT.exec(rest);
      const call = open.get(name)?.shift();
      if (r && call) {
        call.error = r[1] === 'error';
        call.bytes = Number(r[3]);
      }
    }
  }
  return calls.sort((a, b) => a.time - b.time);
}

export function isRead(call: Call): boolean {
  return call.op !== undefined ? READ_OPS.test(call.op) : READ_TOOL.test(call.name);
}

/** Splits calls into turns at idle gaps of at least gapSeconds. */
export function groupTurns(calls: Call[], gapSeconds = 20): Call[][] {
  const turns: Call[][] = [];
  for (const call of calls) {
    const last = turns.at(-1);
    if (last && call.time - last.at(-1)!.time < gapSeconds * 1000) last.push(call);
    else turns.push([call]);
  }
  return turns;
}

export function turnStats(turns: Call[][]) {
  const sizes = turns.map((t) => t.length).sort((a, b) => a - b);
  const n = sizes.length;
  const median = n === 0 ? 0 : n % 2 ? sizes[(n - 1) / 2] : (sizes[n / 2 - 1] + sizes[n / 2]) / 2;
  return { turns: n, mean: n ? sizes.reduce((a, b) => a + b, 0) / n : 0, median, max: n ? sizes[n - 1] : 0 };
}

/** Counts, per tool, reads repeated with identical arguments and no state-changing call in between. */
export function redundantReads(calls: Call[]): Map<string, number> {
  const out = new Map<string, number>();
  const seen = new Set<string>();
  for (const call of calls) {
    if (!isRead(call)) {
      seen.clear();
      continue;
    }
    const key = `${call.name}|${call.args}`;
    if (seen.has(key)) out.set(call.name, (out.get(call.name) ?? 0) + 1);
    seen.add(key);
  }
  return out;
}

/** Errors over answered calls, keyed by tool and by tool.op. */
export function refusalRates(calls: Call[]): Array<{ key: string; calls: number; errors: number; rate: number }> {
  const acc = new Map<string, { calls: number; errors: number }>();
  const bump = (key: string, error: boolean) => {
    const e = acc.get(key) ?? { calls: 0, errors: 0 };
    e.calls++;
    if (error) e.errors++;
    acc.set(key, e);
  };
  for (const c of calls) {
    if (c.error === undefined) continue;
    bump(c.name, c.error);
    if (c.op) bump(`${c.name}.${c.op}`, c.error);
  }
  return [...acc]
    .map(([key, v]) => ({ key, ...v, rate: v.errors / v.calls }))
    .sort((a, b) => b.rate - a.rate || b.calls - a.calls);
}

/** Reply tokens (bytes / 4) per tool, largest total first. */
export function replyTokens(calls: Call[], top = 10) {
  const acc = new Map<string, number[]>();
  for (const c of calls) if (c.bytes !== undefined) acc.set(c.name, [...(acc.get(c.name) ?? []), c.bytes / 4]);
  return [...acc]
    .map(([name, t]) => {
      const total = t.reduce((a, b) => a + b, 0);
      return { name, calls: t.length, mean: total / t.length, max: Math.max(...t), total };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, top);
}

export function report(calls: Call[], gapSeconds = 20): string {
  const f = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  const s = turnStats(groupTurns(calls, gapSeconds));
  const out = [
    '# Tool-call metrics',
    '',
    `${calls.length} calls.`,
    '',
    `## Calls per turn (gap ${gapSeconds}s)`,
    '',
    `Turns: ${s.turns}, mean ${f(s.mean)}, median ${f(s.median)}, max ${s.max}`,
    '',
    '## Redundant reads (identical repeat, no change between)',
    '',
    '| Tool | Repeats |',
    '| --- | --- |',
  ];
  for (const [name, n] of [...redundantReads(calls)].sort((a, b) => b[1] - a[1])) out.push(`| ${name} | ${n} |`);
  out.push('', '## Refusal rate', '', '| Tool / op | Calls | Errors | Rate |', '| --- | --- | --- | --- |');
  for (const r of refusalRates(calls)) out.push(`| ${r.key} | ${r.calls} | ${r.errors} | ${(r.rate * 100).toFixed(1)}% |`);
  out.push('', '## Reply tokens (bytes/4), top 10', '', '| Tool | Calls | Mean | Max | Total |', '| --- | --- | --- | --- | --- |');
  for (const r of replyTokens(calls)) out.push(`| ${r.name} | ${r.calls} | ${f(r.mean)} | ${f(r.max)} | ${f(r.total)} |`);
  return out.join('\n');
}

function main(argv: string[]): void {
  let gap = 20;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--gap') gap = Number(argv[++i]);
    else files.push(argv[i]);
  }
  if (files.length === 0) {
    const names = readdirSync('logs').filter((f) => /^server.*\.log$/.test(f) && !f.includes('.err.'));
    files.push(...names.map((f) => join('logs', f)));
  }
  const lines = files.flatMap((f) => readFileSync(f, 'utf8').split(/\r?\n/));
  console.log(report(parseLog(lines), gap));
}

if (process.argv[1]?.endsWith('toolstats.mts')) main(process.argv.slice(2));
