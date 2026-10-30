import { describe, expect, it } from 'vitest';
import { fullStats, fullStatsMarkdown, groupTurns, parseLog, redundantReads, refusalRates, replyTokens, report, turnStats } from '../scripts/toolstats.mjs';

const T = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const lines = [
  `${T(0)} POST /mcp/<secret>`,
  `${T(1)} tools/call get_state {"x":1}`,
  `${T(1)} tools/result get_state ok 5ms 400B {"hp":3}`,
  `${T(2)} tools/call get_state {"x":1}`,
  `${T(2)} tools/result get_state ok 5ms 800B {"hp":3}`,
  `${T(3)} tools/call act {"op":"attack","target":"goblin"}`,
  `${T(3)} tools/result act error 9ms 40B refused`,
  `${T(4)} error handling MCP request: boom`,
  `${T(5)} tools/call get_state {"x":1}`,
  `${T(5)} tools/result get_state ok 5ms 400B {"hp":2}`,
  `${T(50)} tools/call act {"op":"get","what":"a very long argument that was trunc...`,
  `${T(50)} tools/result act ok 3ms 100B fine`,
  `${T(51)} tools/call act {"op":"get","what":"a very long argument that was trunc...`,
  `${T(51)} tools/result act ok 3ms 100B fine`,
];

describe('toolstats', () => {
  const calls = parseLog(lines);

  it('skips noise and keeps truncated args', () => {
    expect(calls).toHaveLength(6);
    expect(calls[4].op).toBe('get');
  });

  it('groups turns on idle gaps', () => {
    const turns = groupTurns(calls, 20);
    expect(turns.map((t) => t.length)).toEqual([4, 2]);
    expect(turnStats(turns)).toEqual({ turns: 2, mean: 3, median: 3, max: 4 });
  });

  it('counts reads repeated with no change in between', () => {
    expect(redundantReads(calls)).toEqual(new Map([['get_state', 1], ['act', 1]]));
  });

  it('computes refusal rates per tool and op', () => {
    const rates = Object.fromEntries(refusalRates(calls).map((r) => [r.key, r.rate]));
    expect(rates['act']).toBeCloseTo(1 / 3);
    expect(rates['act.attack']).toBe(1);
    expect(rates['act.get']).toBe(0);
    expect(rates['get_state']).toBe(0);
  });

  it('computes reply tokens', () => {
    const [top] = replyTokens(calls);
    expect(top).toMatchObject({ name: 'get_state', calls: 3, max: 200, total: 400 });
    expect(top.mean).toBeCloseTo(400 / 3);
    expect(report(calls)).toContain('Turns: 2, mean 3, median 3, max 4');
  });
});

describe('fullStats', () => {
  const call = (s: number, name: string, args: string, res: string) => [
    `${T(s)} tools/call ${name} ${args}`,
    `${T(s)} tools/result ${name} ${res}`,
  ];
  // Turn 1: ping 1..20ms. Turn 2 (gap): attack refused then retried ok; move refused twice.
  const synth = [
    ...Array.from({ length: 20 }, (_, i) => call(i, 'ping', '{}', `ok ${i + 1}ms 40B pong`)).flat(),
    ...call(100, 'act', '{"op":"attack"}', 'error 10ms 20B no target'),
    ...call(101, 'get_state', '{}', 'ok 4ms 400B state'),
    ...call(102, 'act', '{"op":"attack"}', 'ok 12ms 80B hit'),
    ...call(103, 'act', '{"op":"move"}', 'error 6ms 20B blocked'),
    ...call(104, 'act', '{"op":"move"}', 'error 6ms 20B blocked'),
    ...call(105, 'act', '{"op":"get_log"}', 'ok 2ms 10B x'),
  ];
  const stats = fullStats(parseLog(synth));

  it('computes latency percentiles and sizes', () => {
    const ping = stats.perTool.find((k) => k.key === 'ping')!;
    expect(ping).toMatchObject({ calls: 20, errors: 0 });
    expect(ping.latencyMs).toMatchObject({ n: 20, p50: 10, p95: 19, max: 20 });
    expect(ping.latencyMs.mean).toBeCloseTo(10.5);
    expect(ping.replyTokens).toMatchObject({ mean: 10, max: 10, total: 200 });
    expect(ping.argsBytes).toMatchObject({ mean: 2, max: 2, truncated: 0 });
    expect(stats.perTool.find((k) => k.key === 'act')!.share).toBeCloseTo(5 / 26);
    expect(stats.perOp.map((k) => k.key)).toContain('act.attack');
    expect(stats.perOp.find((k) => k.key === 'act.attack')).toMatchObject({ calls: 2, errors: 1 });
  });

  it('computes time and slowest calls', () => {
    expect(stats.time.totalMs).toBe(210 + 10 + 4 + 12 + 6 + 6 + 2);
    expect(stats.time.perTurnMs.max).toBe(210);
    expect(stats.time.slowest[0]).toEqual({ tool: 'ping', op: undefined, ms: 20 });
    expect(stats.time.slowest).toHaveLength(10);
  });

  it('counts sequences within turns', () => {
    expect(stats.sequences.pairs[0]).toEqual({ seq: 'ping -> ping', count: 19 });
    expect(stats.sequences.pairs).toContainEqual({ seq: 'act.move -> act.move', count: 1 });
    expect(stats.sequences.triples[0]).toEqual({ seq: 'ping -> ping -> ping', count: 18 });
  });

  it('tracks refuse-then-retry', () => {
    const r = Object.fromEntries(stats.refuseRetry.perKey.map((x) => [x.key, x]));
    expect(r['act.attack']).toMatchObject({ errors: 1, retried: 1, retrySucceeded: 1, retryFailed: 0 });
    expect(r['act.move']).toMatchObject({ errors: 2, retried: 1, retrySucceeded: 0, retryFailed: 1 });
    expect(stats.refuseRetry.errorTexts[0]).toEqual({ text: 'blocked', count: 2 });
  });

  it('counts reads right after writes and serialises to JSON', () => {
    expect(stats.readsAfterWrites.find((w) => w.tool === 'act')).toEqual({ tool: 'act', writes: 4, followedByRead: 1 });
    expect(JSON.parse(JSON.stringify(stats))).toMatchObject({ calls: 26, perTool: expect.any(Array), time: expect.any(Object) });
    expect(fullStatsMarkdown(stats)).toContain('## Refuse then retry');
  });
});
