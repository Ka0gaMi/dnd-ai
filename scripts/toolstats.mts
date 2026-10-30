// Metrics over the server's tool-call log: calls per turn, redundant reads, refusal rate, reply size.
// Usage: node --import tsx scripts/toolstats.mts [--gap seconds] [--json file] [log files...] (default logs/server*.log)
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
  ms?: number;
  text?: string;
}

const LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (tools\/call|tools\/result) (\S+) ?(.*)$/;
const RESULT = /^(ok|error) (\d+)ms (\d+)B ?(.*)$/;
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
        call.ms = Number(r[2]);
        call.text = r[4];
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

export interface Summary {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}
export interface KeyStats {
  key: string;
  calls: number;
  share: number;
  errors: number;
  latencyMs: Summary;
  argsBytes: { mean: number; max: number; truncated: number };
  replyBytes: { mean: number; max: number; total: number };
  replyTokens: { mean: number; max: number; total: number };
}
export interface RetryStats {
  key: string;
  errors: number;
  retried: number;
  retrySucceeded: number;
  retryFailed: number;
}
export interface FullStats {
  calls: number;
  perTool: KeyStats[];
  perOp: KeyStats[];
  time: {
    totalMs: number;
    perTurnMs: { mean: number; median: number; max: number };
    slowest: Array<{ tool: string; op: string | undefined; ms: number }>;
  };
  sequences: { pairs: Array<{ seq: string; count: number }>; triples: Array<{ seq: string; count: number }> };
  refuseRetry: { perKey: RetryStats[]; errorTexts: Array<{ text: string; count: number }> };
  readsAfterWrites: Array<{ tool: string; writes: number; followedByRead: number }>;
}

const ARGS_LIMIT = 300;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const label = (c: Call) => (c.op ? `${c.name}.${c.op}` : c.name);

/** Nearest-rank percentiles over the values. */
function summarize(xs: number[]): Summary {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const at = (q: number) => (n ? s[Math.max(0, Math.ceil(q * n) - 1)] : 0);
  return { n, mean: mean(s), p50: at(0.5), p95: at(0.95), max: n ? s[n - 1] : 0 };
}

function bump(m: Map<string, number>, key: string) {
  m.set(key, (m.get(key) ?? 0) + 1);
}

function topCounts(m: Map<string, number>, top: number) {
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top);
}

/** Full per-tool and per-op optimisation data; turns split at idle gaps (opts.gapSeconds, default 20). */
export function fullStats(entries: Call[], opts: { gapSeconds?: number } = {}): FullStats {
  const turns = groupTurns(entries, opts.gapSeconds ?? 20);
  const groups = new Map<string, Call[]>();
  const toolKeys = new Set<string>();
  for (const c of entries) {
    for (const k of c.op ? [c.name, label(c)] : [c.name]) groups.set(k, [...(groups.get(k) ?? []), c]);
    toolKeys.add(c.name);
  }
  const keyStats = (key: string, cs: Call[]): KeyStats => {
    const argB = cs.map((c) => Buffer.byteLength(c.args));
    const bytes = cs.filter((c) => c.bytes !== undefined).map((c) => c.bytes!);
    return {
      key,
      calls: cs.length,
      share: cs.length / entries.length,
      errors: cs.filter((c) => c.error).length,
      latencyMs: summarize(cs.filter((c) => c.ms !== undefined).map((c) => c.ms!)),
      argsBytes: { mean: mean(argB), max: Math.max(0, ...argB), truncated: cs.filter((c) => c.args.length >= ARGS_LIMIT).length },
      replyBytes: { mean: mean(bytes), max: Math.max(0, ...bytes), total: sum(bytes) },
      replyTokens: { mean: mean(bytes) / 4, max: Math.max(0, ...bytes) / 4, total: sum(bytes) / 4 },
    };
  };
  const all = [...groups].map(([k, cs]) => keyStats(k, cs)).sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));

  const turnMs = turns.map((t) => sum(t.map((c) => c.ms ?? 0)));
  const perTurn = summarize(turnMs);
  const slowest = entries
    .filter((c) => c.ms !== undefined)
    .sort((a, b) => b.ms! - a.ms!)
    .slice(0, 10)
    .map((c) => ({ tool: c.name, op: c.op, ms: c.ms! }));

  const pairs = new Map<string, number>();
  const triples = new Map<string, number>();
  const retry = new Map<string, RetryStats>();
  const errTexts = new Map<string, number>();
  const writes = new Map<string, { writes: number; followedByRead: number }>();
  for (const t of turns) {
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (i + 1 < t.length) bump(pairs, `${label(c)} -> ${label(t[i + 1])}`);
      if (i + 2 < t.length) bump(triples, `${label(c)} -> ${label(t[i + 1])} -> ${label(t[i + 2])}`);
      if (c.error) {
        const r = retry.get(label(c)) ?? { key: label(c), errors: 0, retried: 0, retrySucceeded: 0, retryFailed: 0 };
        r.errors++;
        const next = t.slice(i + 1, i + 4).find((n) => n.name === c.name && n.op === c.op);
        if (next) {
          r.retried++;
          if (next.error === false) r.retrySucceeded++;
          else if (next.error) r.retryFailed++;
        }
        retry.set(r.key, r);
        bump(errTexts, (c.text ?? '').slice(0, 120));
      }
      if (!isRead(c)) {
        const w = writes.get(c.name) ?? { writes: 0, followedByRead: 0 };
        w.writes++;
        const n = t[i + 1];
        if (n && n.name === c.name && isRead(n)) w.followedByRead++;
        writes.set(c.name, w);
      }
    }
  }
  const seq = (m: Map<string, number>, top: number) => topCounts(m, top).map(([s, count]) => ({ seq: s, count }));
  return {
    calls: entries.length,
    perTool: all.filter((k) => toolKeys.has(k.key)),
    perOp: all.filter((k) => !toolKeys.has(k.key)),
    time: { totalMs: sum(turnMs), perTurnMs: { mean: perTurn.mean, median: perTurn.p50, max: perTurn.max }, slowest },
    sequences: { pairs: seq(pairs, 15), triples: seq(triples, 10) },
    refuseRetry: {
      perKey: [...retry.values()].sort((a, b) => b.errors - a.errors || a.key.localeCompare(b.key)),
      errorTexts: topCounts(errTexts, 10).map(([text, count]) => ({ text, count })),
    },
    readsAfterWrites: [...writes]
      .map(([tool, w]) => ({ tool, ...w }))
      .sort((a, b) => b.followedByRead - a.followedByRead || a.tool.localeCompare(b.tool)),
  };
}

export function fullStatsMarkdown(s: FullStats): string {
  const f = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  const cell = (x: string) => x.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const out = ['# Full tool stats', '', `${s.calls} calls. Args are logged truncated at ${ARGS_LIMIT} chars, so args bytes cap near that.`];
  const table = (title: string, rows: KeyStats[]) => {
    out.push('', `## ${title}`, '', '| Key | Calls | Share | Errors | ms mean | p50 | p95 | max | Args mean/max (trunc) | Reply B mean/max | Reply tok mean/max/total |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of rows) {
      const l = r.latencyMs;
      out.push(`| ${r.key} | ${r.calls} | ${(r.share * 100).toFixed(1)}% | ${r.errors} | ${f(l.mean)} | ${l.p50} | ${l.p95} | ${l.max} | ${f(r.argsBytes.mean)}/${r.argsBytes.max} (${r.argsBytes.truncated}) | ${f(r.replyBytes.mean)}/${r.replyBytes.max} | ${f(r.replyTokens.mean)}/${f(r.replyTokens.max)}/${f(r.replyTokens.total)} |`);
    }
  };
  table('Per tool', s.perTool);
  table('Per tool.op', s.perOp);
  const t = s.time;
  out.push('', '## Time', '', `Total tool time ${t.totalMs}ms; per turn mean ${f(t.perTurnMs.mean)}ms, median ${f(t.perTurnMs.median)}ms, max ${t.perTurnMs.max}ms.`, '', '| Slowest calls | ms |', '| --- | --- |');
  for (const c of t.slowest) out.push(`| ${c.tool}${c.op ? `.${c.op}` : ''} | ${c.ms} |`);
  for (const [title, rows] of [['Top call pairs', s.sequences.pairs], ['Top call triples', s.sequences.triples]] as const) {
    out.push('', `## ${title}`, '', '| Sequence | Count |', '| --- | --- |');
    for (const r of rows) out.push(`| ${r.seq} | ${r.count} |`);
  }
  out.push('', '## Refuse then retry (same tool and op within 3 calls)', '', '| Key | Errors | Retried | Retry ok | Retry failed |', '| --- | --- | --- | --- | --- |');
  for (const r of s.refuseRetry.perKey) out.push(`| ${r.key} | ${r.errors} | ${r.retried} | ${r.retrySucceeded} | ${r.retryFailed} |`);
  out.push('', '| Error text (first 120) | Count |', '| --- | --- |');
  for (const e of s.refuseRetry.errorTexts) out.push(`| ${cell(e.text)} | ${e.count} |`);
  out.push('', '## Reads right after writes (same tool)', '', '| Tool | Writes | Followed by read |', '| --- | --- | --- |');
  for (const r of s.readsAfterWrites) out.push(`| ${r.tool} | ${r.writes} | ${r.followedByRead} |`);
  return out.join('\n');
}

function main(argv: string[]): void {
  let gap = 20;
  let jsonOut: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--gap') gap = Number(argv[++i]);
    else if (argv[i] === '--json') jsonOut = argv[++i];
    else files.push(argv[i]);
  }
  if (files.length === 0) {
    const names = readdirSync('logs').filter((f) => /^server.*\.log$/.test(f) && !f.includes('.err.'));
    files.push(...names.map((f) => join('logs', f)));
  }
  const lines = files.flatMap((f) => readFileSync(f, 'utf8').split(/\r?\n/));
  const calls = parseLog(lines);
  const stats = fullStats(calls, { gapSeconds: gap });
  console.log(report(calls, gap));
  console.log('\n' + fullStatsMarkdown(stats));
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(stats, null, 2));
}

if (process.argv[1]?.endsWith('toolstats.mts')) main(process.argv.slice(2));
