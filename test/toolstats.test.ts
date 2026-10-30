import { describe, expect, it } from 'vitest';
import { groupTurns, parseLog, redundantReads, refusalRates, replyTokens, report, turnStats } from '../scripts/toolstats.mjs';

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
