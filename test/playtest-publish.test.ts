// Publishing playtest runs: allowed files only, secret stripped, player kind in name/header/index, idempotent, newest first.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishRun, rebuildIndex } from '../scripts/playtest/publish.mjs';

const SECRET = 'deadbeefsecret0123456789';
let tmp: string;
let target: string;

function makeRun(stamp: string, o: { player: 'scripted' | 'claude'; started: string; cost: number }): string {
  const dir = join(tmp, 'runs', stamp);
  mkdirSync(join(dir, 'screenshots'), { recursive: true });
  mkdirSync(join(dir, 'streams'), { recursive: true });
  const meta = {
    started_at: o.started,
    port: 4242,
    secret: SECRET,
    db_path: 'C:\\x\\game.sqlite',
    scenario: 'first-session',
    player: o.player,
    player_model: o.player === 'claude' ? 'haiku' : null,
    git_branch: 'kk/test',
    git_commit: 'abc1234',
    turns_played: 3,
    dm_init: { model: 'sonnet', cwd: 'C:\\x\\dm', memory_paths: ['C:\\x\\memory'] },
    totals: { wall_ms: 90000, duration_api_ms: 60000, num_turns: 9, total_cost_usd: o.cost },
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  writeFileSync(join(dir, 'transcript.jsonl'), '{"turn":1,"role":"player","text":"hi"}\n');
  writeFileSync(join(dir, 'screenshots', 'turn-01.png'), 'png');
  for (const f of ['game.sqlite', 'mcp.json', 'streams/dm-01.jsonl']) writeFileSync(join(dir, f), SECRET);
  const T = '2026-10-30T08:00:0';
  writeFileSync(
    join(dir, 'server.log'),
    [
      `${T}0.000Z tools/call roll {"op":"roll"}`,
      `${T}0.100Z tools/result roll ok 5ms 400B x`,
      `${T}1.000Z tools/call get_codex {}`,
      `${T}1.100Z tools/result get_codex error 5ms 80B nope`,
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'report.md'),
    [
      '# Playtest report',
      '| port | 4242 |',
      '| db_path | C:\\x |',
      '| secret | (redacted) |',
      'Leaks found: **2** (see Leak scan).',
      'Calls per player turn (transcript turn windows): 3 turns, mean 1.5, median 1, max 2.',
      '12 tools listed; their definitions weigh 4000 bytes (~1000 tokens) in every tools/list.',
    ].join('\n'),
  );
  return dir;
}

const files = (dir: string): string[] => readdirSync(dir).sort();

describe('playtest publish', () => {
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'playtest-publish-'));
    target = join(tmp, 'out');
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('copies only allowed files, strips secrets, names and heads the report by player kind', async () => {
    const out = await publishRun(makeRun('20261030-090000', { player: 'claude', started: '2026-10-30T08:00:00Z', cost: 1.5 }), target);
    expect(out.endsWith('20261030-090000-first-session-claude-haiku')).toBe(true);
    expect(files(out)).toEqual(['meta.json', 'report.md', 'screenshots', 'toolstats.json', 'transcript.jsonl']);
    expect(existsSync(join(out, 'screenshots', 'turn-01.png'))).toBe(true);
    const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'));
    expect(meta).not.toHaveProperty('secret');
    expect(meta).not.toHaveProperty('port');
    expect(meta).not.toHaveProperty('db_path');
    expect(meta.dm_init).toEqual({ model: 'sonnet' });
    expect(meta.git_commit).toBe('abc1234');
    const report = readFileSync(join(out, 'report.md'), 'utf8');
    expect(report.split('\n')[0]).toBe('Player: Claude (haiku) \u2014 free-form');
    expect(report).not.toMatch(/4242|db_path|secret/);
    expect(JSON.parse(readFileSync(join(out, 'toolstats.json'), 'utf8')).calls).toBe(2);
    for (const f of files(out)) if (f.endsWith('.json')) expect(readFileSync(join(out, f), 'utf8')).not.toContain(SECRET);
  });

  it('lists runs newest first in a table per player kind, with the right numbers, and is idempotent', async () => {
    const scripted = makeRun('20261030-100000', { player: 'scripted', started: '2026-10-30T09:00:00Z', cost: 0.25 });
    const out = await publishRun(scripted, target);
    expect(out.endsWith('20261030-100000-first-session-scripted')).toBe(true);
    expect(readFileSync(join(out, 'report.md'), 'utf8').split('\n')[0]).toBe('Player: scripted (first-session lines)');
    await publishRun(makeRun('20261030-110000', { player: 'scripted', started: '2026-10-30T10:00:00Z', cost: 0.5 }), target);

    const before = readFileSync(join(target, 'index.md'), 'utf8');
    await publishRun(scripted, target);
    expect(readdirSync(target).filter((f) => f !== 'index.md')).toHaveLength(3);
    expect(rebuildIndex(target)).toBe(before);

    const claudeAt = before.indexOf('## Claude player runs');
    const scriptedAt = before.indexOf('## Scripted player runs');
    expect(claudeAt).toBeGreaterThanOrEqual(0);
    expect(scriptedAt).toBeGreaterThan(claudeAt);
    const claudeRows = before.slice(claudeAt, scriptedAt).split('\n').filter((l) => l.includes('/report.md'));
    const scriptedRows = before.slice(scriptedAt).split('\n').filter((l) => l.includes('/report.md'));
    expect(claudeRows).toHaveLength(1);
    expect(claudeRows[0]).toContain('Claude (haiku)');
    expect(scriptedRows).toHaveLength(2);
    expect(scriptedRows[0]).toContain('20261030-110000');
    expect(scriptedRows[1]).toBe(
      '| 2026-10-30 09:00 | kk/test @ abc1234 | first-session | Scripted | 3 | 90.0 s | 60.0 s | 9 | $0.25 | 1.5 | 2 | 1 | 1000 | 2 | ' +
        '[report](20261030-100000-first-session-scripted/report.md) |',
    );
  });
});
