// The playtest report over a small run folder: every section it writes, and the leak scan with and without
// a DM-only value copied into a field the player's window shows.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const T0 = Date.parse('2026-10-30T10:00:00.000Z');
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();

const SECRET_NOTES = 'The abbot is the bell thief.\n- The real bell lies under Saint Orrin chapel.';
const HIDDEN_CLUE = 'Bronze filings under the vestry floor.';
const MCP_SECRET = 'deadbeef0123456789playtestsecret';

const usage = (wall: number, model: number, hops: number, input: number, output: number, cost: number) => ({
  duration_ms: wall,
  duration_api_ms: model,
  num_turns: hops,
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: input * 30,
  cache_creation_input_tokens: hops === 2 ? null : 2000,
  total_cost_usd: cost,
});

const TRANSCRIPT = [
  {
    turn: 1,
    role: 'player',
    text: 'I search the vestry.',
    at: at(0),
    usage: { duration_ms: 2500, duration_api_ms: 2000, num_turns: 1, input_tokens: 500, output_tokens: 40, total_cost_usd: 0.01 },
  },
  {
    turn: 1,
    role: 'dm',
    text: 'You find nothing but dust. The abbot watches you closely from the door.',
    tool_calls: [
      { name: 'mcp__dnd-ai__roll', input: { expr: '1d20+3' } },
      { name: 'mcp__dnd-ai__story', input: { op: 'get' } },
      { name: 'mcp__dnd-ai__story', input: { op: 'get' } },
      { name: 'mcp__dnd-ai__hp', input: { op: 'damage' } },
    ],
    at: at(20),
    started_at: at(1),
    finished_at: at(20),
    usage: usage(19_000, 12_000, 3, 1200, 300, 0.042),
  },
  { turn: 2, role: 'player', text: 'I attack the goblin!', at: at(60) },
  {
    turn: 2,
    role: 'dm',
    text: "The goblin's blade bites before you can swing: you take 7 damage.",
    tool_calls: [{ name: 'mcp__dnd-ai__story', input: { op: 'get' } }],
    at: at(90),
    started_at: at(61),
    finished_at: at(90),
    usage: usage(29_000, 20_000, 2, 1500, 200, 0.05),
  },
  { turn: 3, role: 'player', text: 'We make camp.', at: at(120) },
  {
    turn: 3,
    role: 'dm',
    text: 'Night falls over the city.',
    at: at(181),
    started_at: at(121),
    finished_at: at(181),
    usage: usage(60_000, 55_000, 1, 900, 100, 0.03),
  },
];

const LOG = [
  `${at(0)} GET /api/campaigns/1/story`,
  `${at(5)} tools/call roll {"expr":"1d20+3","purpose":"Investigation"}`,
  `${at(5)} tools/result roll ok 40ms 300B {"total":17}`,
  `${at(6)} tools/call story {"campaign_id":1,"op":"get"}`,
  `${at(6)} tools/result story ok 10ms 2000B {"outline":{}}`,
  `${at(7)} tools/call story {"campaign_id":1,"op":"get"}`,
  `${at(7)} tools/result story ok 12ms 2000B {"outline":{}}`,
  `${at(8)} tools/call hp {"campaign_id":1,"op":"damage","target":"Nobody"}`,
  `${at(8)} tools/result hp error 5ms 120B No combatant or character named Nobody.`,
  `${at(40)} tools/call load_campaign {"campaign_id":1}`,
  `${at(40)} tools/result load_campaign ok 30ms 5000B {"campaign":{}}`,
  `${at(62)} tools/call story {"campaign_id":1,"op":"get"}`,
  `${at(62)} tools/result story ok 9ms 2000B {"outline":{}}`,
  `${at(70)} error handling MCP request: noise`,
];

interface Run {
  leaks: number;
  report: string;
}

let dir: string;
let campaignId: number;
let clean: Run;
let leaky: Run;

beforeAll(async () => {
  // Route modules load through a fresh module graph, as the other route tests do under isolate: false.
  vi.resetModules();
  const { openDb } = await import('../src/db/connection.js');
  const { createCampaign } = await import('../src/core/campaign.js');
  const { createCharacter } = await import('../src/core/character.js');
  const { upsertEntity } = await import('../src/core/codex.js');
  const { addJournalEntry, addPlotThread, plantClue, setStoryOutline } = await import('../src/core/story.js');
  const { writeReport } = await import('../scripts/playtest/report.mjs');

  dir = mkdtempSync(join(tmpdir(), 'dnd-playtest-report-'));
  const dbFile = join(dir, 'game.sqlite');
  let db = openDb(dbFile);
  campaignId = createCampaign(db, { name: 'The Bell Tithe', story_shape: 'structured' }).campaign_id;
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
  setStoryOutline(db, {
    campaign_id: campaignId,
    premise: 'A city of bells.',
    ending: 'The bells ring again.',
    secret_notes: SECRET_NOTES,
  });
  const thread = addPlotThread(db, {
    campaign_id: campaignId,
    title: 'The vestry conspiracy',
    summary: 'The abbot melts the tithe bells.',
    hidden: true,
  });
  plantClue(db, { campaign_id: campaignId, text: HIDDEN_CLUE, thread_id: thread.id, hidden: true });
  upsertEntity(db, {
    campaign_id: campaignId,
    kind: 'npc',
    name: 'Abbot Hollis',
    summary: 'Keeper of the bells.',
    hidden_notes: 'Secretly sells the bronze to smugglers.',
  });
  db.close();

  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      started_at: at(-5),
      finished_at: at(185),
      port: 0,
      secret: MCP_SECRET,
      db_path: dbFile,
      campaign_id: campaignId,
      dm_model: 'claude-opus-test',
      player: 'scripted',
      scenario: 'bell-tithe',
      turns_played: 3,
      dm_session_id: 'session-1',
      usage: { total_cost_usd: 0.132 },
    }),
  );
  writeFileSync(join(dir, 'server.log'), LOG.join('\n'));
  writeFileSync(join(dir, 'transcript.jsonl'), `${TRANSCRIPT.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  mkdirSync(join(dir, 'screenshots'));
  writeFileSync(join(dir, 'screenshots', 'turn-1.png'), '');

  const first = await writeReport(dir);
  clean = { leaks: first.leaks, report: readFileSync(first.reportPath, 'utf8') };

  // The DM copies a hidden clue into the player's journal: a DM-only value in a field the window shows.
  db = openDb(dbFile);
  addJournalEntry(db, { campaign_id: campaignId, text: `Found: ${HIDDEN_CLUE}` });
  db.close();
  const second = await writeReport(dir);
  leaky = { leaks: second.leaks, report: readFileSync(second.reportPath, 'utf8') };
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('the playtest report', () => {
  it('summarises the run from meta.json without printing the MCP secret', () => {
    expect(clean.report).toContain('## Run summary');
    expect(clean.report).toContain('| dm_model | claude-opus-test |');
    expect(clean.report).toContain('| secret | (redacted) |');
    expect(clean.report).not.toContain(MCP_SECRET);
    expect(clean.report).toContain('| duration | 190.0 s |');
  });

  it('reports the model side per turn with totals, means and the slowest turns', () => {
    expect(clean.report).toContain('## Model side per turn');
    expect(clean.report).toContain('| 1 | 19.0 s | 12.0 s | 3 | 1200 | 300 | 36000 | 2000 | $0.0420 |');
    expect(clean.report).toContain('| 2 | 29.0 s | 20.0 s | 2 | 1500 | 200 | 45000 | - | $0.0500 |');
    expect(clean.report).toContain('| **Total** | 108.0 s | 87.0 s | 6 | 3600 | 600 | 108000 | 4000 | $0.1220 |');
    expect(clean.report).toContain('Slowest turns by wall time: turn 3 (60.0 s), turn 2 (29.0 s), turn 1 (19.0 s).');
    expect(clean.report).toContain('Player model (1 turns with usage): $0.0100');
  });

  it('splits each turn into model, tool and overhead time', () => {
    expect(clean.report).toContain('## Time split per turn');
    // 40 + 10 + 12 + 5 ms of tools inside turn 1; the load_campaign call at 40 s sits between turns.
    expect(clean.report).toContain('| 1 | 19.0 s | 12.0 s | 0.1 s | 6.9 s | 4 |');
    expect(clean.report).toContain('| 3 | 60.0 s | 55.0 s | 0.0 s | 5.0 s | 0 |');
  });

  it('counts tool use per transcript turn, with refusals, their messages and redundant reads', () => {
    expect(clean.report).toContain('## Tool use');
    expect(clean.report).toContain('6 calls, 6 answered, 1 refused.');
    expect(clean.report).toContain('(transcript turn windows): 3 turns, mean 1.7, median 1, max 4. 1 calls fell outside every turn.');
    expect(clean.report).toContain('| hp.damage | 1 | 1 | 100.0% |');
    expect(clean.report).toContain('- `hp.damage`: No combatant or character named Nobody.');
    expect(clean.report).toContain('| story | 1 |');
    expect(clean.report).toContain('### Full tool stats');
  });

  it('sets every listed tool against its use in the run', () => {
    expect(clean.report).toContain('## Surface cost vs use');
    expect(clean.report).toMatch(/\| roll \| \d+ \| \d+ \| 1 \| 0 \| 300 \|/);
    expect(clean.report).toMatch(/\| story \| \d+ \| \d+ \| 3 \| 0 \| 2000 \|/);
    expect(clean.report).toMatch(/Never used this run \(\d+\): [^\n]*create_campaign/);
    expect(clean.report).toContain('Heaviest replies by bytes per call: load_campaign (5000 B over 1 replies)');
  });

  it('digests the transcript and flags a narrated number with no dice tool, as a heuristic', () => {
    expect(clean.report).toContain('## Transcript digest');
    expect(clean.report).toContain('- Player: I search the vestry.');
    expect(clean.report).toContain('- Tools: roll, story x2, hp');
    expect(clean.report).toContain('- **Flag (heuristic):** narrates "7 damage" with no dice tool in this turn');
    expect(clean.report.match(/Flag \(heuristic\)/g)).toHaveLength(1);
  });

  it('links the screenshots', () => {
    expect(clean.report).toContain('![turn-1.png](screenshots/turn-1.png)');
  });

  it('finds no leak in a clean run, while checking the planted DM-only values', () => {
    expect(clean.leaks).toBe(0);
    expect(clean.report).toContain('Leaks found: **0**');
    expect(clean.report).toContain('values under 8 characters are skipped');
    expect(clean.report).toMatch(/\| outline_secret_notes \| [^|]+ \| 3 \| 3 \| 0 \| 0 \|/);
    expect(clean.report).toMatch(/\| hidden_clue \| [^|]+ \| 1 \| 1 \| 0 \| 0 \|/);
    expect(clean.report).toMatch(/\| codex_hidden_notes \| [^|]+ \| 1 \| 1 \| 0 \| 0 \|/);
    expect(clean.report).toContain('| `ws snapshot` | 1 | 200: 1 |');
    expect(clean.report).toMatch(/\| `\/api\/campaigns\/:id\/story` \| 1 \| 200: 1 \|/);
  });

  it('catches a DM-only value copied into a player-visible field', () => {
    expect(leaky.leaks).toBeGreaterThanOrEqual(1);
    expect(leaky.report).toMatch(/\| hidden_clue \| [^|]+ \| 1 \| 1 \| 0 \| 1 \|/);
    expect(leaky.report).toContain(`- **hidden_clue**: "${HIDDEN_CLUE}" in `);
    expect(leaky.report).toContain(`/api/campaigns/${campaignId}/journal?limit=200`);
  });
});
