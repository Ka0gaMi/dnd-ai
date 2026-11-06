// Reveal on arrival and prose nudges, through the MCP client: a save or move whose scene_location is exactly an unknown
// settlement or area marks it known with a codex entry; prose that names one only earns a DM-only reminder.
import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot, createCampaign, moveParty } from '../src/core/campaign.js';
import { upsertEntity } from '../src/core/codex.js';
import { importRegion, type PlaceKind } from '../src/core/region.js';
import { rewindToCheckpoint } from '../src/core/rewind.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { replyText } from './helpers/reply.js';

const REALM = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;

let db: Db;
let client: Client;
let campaignId: number;

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const next = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), next.connect(clientTransport)]);
  return next;
}

/** The reply text of a call that must succeed. */
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: { campaign_id: campaignId, ...args } });
  expect(result.isError ?? false, replyText(result)).toBe(false);
  return replyText(result);
}

const arrivalLines = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('Revealed on the'));
const nudgeLines = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('Named in visible text'));
const dangerLines = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('Danger '));
const arrival = (name: string): string => `Revealed on the player's map (the party arrived): ${name}.`;
const nudge = (name: string): string =>
  `Named in visible text but not on the player's map: ${name} — region {op: reveal, place: "${name}"} once the party has heard of it.`;

function known(name: string): boolean {
  const row = db.prepare('SELECT known_to_party FROM world_place WHERE campaign_id = ? AND name = ?').get(campaignId, name) as
    | { known_to_party: number }
    | undefined;
  return row?.known_to_party === 1;
}

function codexKind(name: string): string | undefined {
  const row = db.prepare('SELECT kind FROM entity WHERE campaign_id = ? AND name = ?').get(campaignId, name) as
    | { kind: string }
    | undefined;
  return row?.kind;
}

function addPlace(kind: PlaceKind, name: string): void {
  db.prepare(
    `INSERT INTO world_place (campaign_id, kind, name, q, r, hexes_json, tags_json, info, link, seed, known_to_party, created_at)
     VALUES (?, ?, ?, 0, 0, '["q0_r0"]', '{}', '', ?, NULL, 0, '2024-01-01T00:00:00.000Z')`,
  ).run(campaignId, kind, name, kind === 'danger' ? 'https://example.test/dungeon' : null);
}

/** The campaign's player character, without which nothing reveals or nudges. */
function addHero(): void {
  const ts = '2024-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO character (campaign_id, name, is_pc, class, level, hp_current, hp_max, abilities_json, created_at, updated_at)
     VALUES (?, 'Bran', 1, 'Fighter', 1, 10, 10, '{"str":12}', ?, ?)`,
  ).run(campaignId, ts, ts);
}

beforeEach(async () => {
  db = openDb(':memory:');
  client = await connect();
  campaignId = createCampaign(db, { name: 'Reveal', story_shape: 'sandbox' }).campaign_id;
  importRegion(db, campaignId, REALM, { source: 'generated' });
  addHero();
});

describe('reveal on arrival', () => {
  it('reveals the settlement a save arrives at, with its codex entry and one reply line', async () => {
    const text = await call('checkpoint', { op: 'save', scene_summary: 'The party made camp.', scene_location: 'Ficengwind' });
    expect(arrivalLines(text)).toEqual([arrival('Ficengwind')]);
    expect(nudgeLines(text)).toEqual([]);
    expect(known('Ficengwind')).toBe(true);
    expect(codexKind('Ficengwind')).toBe('place');
  });

  it('matches whatever the case and a leading "the" on either name', async () => {
    addPlace('settlement', 'Tallowmere');
    addPlace('area', 'The Greywater');
    expect(arrivalLines(await call('checkpoint', { op: 'move', scene_location: 'the Tallowmere' }))).toEqual([
      arrival('Tallowmere'),
    ]);
    const saved = await call('checkpoint', { op: 'save', scene_summary: 'They waded on.', scene_location: '  GREYWATER ' });
    expect(arrivalLines(saved)).toEqual([arrival('The Greywater')]);
    expect(known('Tallowmere')).toBe(true);
    expect(codexKind('The Greywater')).toBe('place');
  });

  it('never reveals a danger the party arrives at, only flags it', async () => {
    addPlace('danger', 'Hollow Barrow');
    const text = await call('checkpoint', { op: 'move', scene_location: 'Hollow Barrow' });
    expect(arrivalLines(text)).toEqual([]);
    expect(dangerLines(text)).toEqual([
      'Danger Hollow Barrow is named in player-visible text: region {op: reveal, place: "Hollow Barrow"} if the party has heard of it, or reword it.',
    ]);
    expect(known('Hollow Barrow')).toBe(false);
    expect(codexKind('Hollow Barrow')).toBeUndefined();
  });

  it('reveals nothing for a location that only mentions a place, and nudges instead', async () => {
    addPlace('settlement', 'Tallowmere');
    const text = await call('checkpoint', { op: 'move', scene_location: 'the road to Tallowmere' });
    expect(arrivalLines(text)).toEqual([]);
    expect(nudgeLines(text)).toEqual([nudge('Tallowmere')]);
    expect(known('Tallowmere')).toBe(false);
    expect(codexKind('Tallowmere')).toBeUndefined();
  });

  it("passes on the reveal's warning when the codex name is taken", async () => {
    upsertEntity(db, { campaign_id: campaignId, kind: 'npc', name: 'Hotfield' });
    const text = await call('checkpoint', { op: 'save', scene_summary: 'The party walked on.', scene_location: 'Hotfield' });
    const lines = text.split('\n');
    const at = lines.indexOf(arrival('Hotfield'));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toBe('The codex already has a npc named "Hotfield", so no place entry was made.');
    expect(known('Hotfield')).toBe(true);
    expect(codexKind('Hotfield')).toBe('npc');
  });

  it('reveals and nudges nothing before the campaign has its hero', async () => {
    campaignId = createCampaign(db, { name: 'Unborn', story_shape: 'sandbox' }).campaign_id;
    importRegion(db, campaignId, REALM, { source: 'generated' });
    const saved = await call('checkpoint', { op: 'save', scene_summary: 'Word came from Hotfield.', scene_location: 'Redham' });
    const moved = await call('checkpoint', { op: 'move', scene_location: 'Coldwood' });
    for (const text of [saved, moved]) {
      expect(arrivalLines(text)).toEqual([]);
      expect(nudgeLines(text)).toEqual([]);
    }
    for (const place of ['Redham', 'Hotfield', 'Coldwood']) expect(known(place), place).toBe(false);
    addHero();
    expect(arrivalLines(await call('checkpoint', { op: 'move', scene_location: 'Redham' }))).toEqual([arrival('Redham')]);
  });

  it('reveals and nudges nothing on a refused call', async () => {
    const refused = await client.callTool({
      name: 'checkpoint',
      arguments: {
        op: 'save',
        campaign_id: campaignId,
        scene_summary: 'The party reached Redham.',
        scene_location: 'Hotfield',
        facts: [{ subject: 'Redham', fact: 'Redham has a new reeve.', supersedes_id: 9999 }],
      },
    });
    expect(refused.isError).toBe(true);
    expect(arrivalLines(replyText(refused))).toEqual([]);
    expect(nudgeLines(replyText(refused))).toEqual([]);
    for (const place of ['Redham', 'Hotfield']) {
      expect(known(place), place).toBe(false);
      expect(codexKind(place), place).toBeUndefined();
    }
  });

  it('never reports an arrival its call rolled back', async () => {
    const failed = db.transaction(() => {
      moveParty(db, { campaign_id: campaignId, scene_location: 'Redham' });
      throw new Error('a later step failed');
    });
    expect(failed).toThrow('a later step failed');
    expect(known('Redham')).toBe(false);
    expect(arrivalLines(await call('log_event', { kind: 'narration', text: 'The wind rose.' }))).toEqual([]);
  });

  it('keeps the reveal out of the scene the save opens, so end_session still drops that scene', async () => {
    await call('checkpoint', { op: 'save', scene_summary: 'The party rode in.', scene_location: 'Redham' });
    const next = (db.prepare('SELECT current_scene_id AS id FROM campaign WHERE id = ?').get(campaignId) as { id: number }).id;
    expect(known('Redham')).toBe(true);
    await call('checkpoint', { op: 'end_session' });
    expect(db.prepare('SELECT 1 FROM scene WHERE id = ?').get(next)).toBeUndefined();
  });

  it("reveals before the save's snapshot, so a rewind keeps the codex events of a place still known", async () => {
    await call('checkpoint', { op: 'save', scene_summary: 'The party rode in.', scene_location: 'Redham' });
    await call('log_event', { kind: 'narration', text: 'The bells rang at noon.' });
    rewindToCheckpoint(db, campaignId);
    const reverted = (text: string): unknown =>
      db.prepare('SELECT reverted FROM event WHERE campaign_id = ? AND text = ?').all(campaignId, text);
    expect(reverted('The bells rang at noon.')).toEqual([{ reverted: 1 }]);
    expect(reverted('Codex: added place Redham.')).toEqual([{ reverted: 0 }]);
    expect(known('Redham')).toBe(true);
    expect(codexKind('Redham')).toBe('place');
  });

  it('does nothing in a campaign without a region map', async () => {
    campaignId = createCampaign(db, { name: 'Unmapped', story_shape: 'sandbox' }).campaign_id;
    addHero();
    const text = await call('checkpoint', { op: 'save', scene_summary: 'The party rode into Redham.', scene_location: 'Redham' });
    expect(arrivalLines(text)).toEqual([]);
    expect(nudgeLines(text)).toEqual([]);
    expect(codexKind('Redham')).toBeUndefined();
  });
});

describe('prose nudges', () => {
  it('nudges about a settlement a checkpoint summary names and reveals nothing', async () => {
    const text = await call('checkpoint', { op: 'save', scene_summary: 'The party rode into Redham at dusk and took rooms.' });
    expect(nudgeLines(text)).toEqual([nudge('Redham')]);
    expect(arrivalLines(text)).toEqual([]);
    expect(known('Redham')).toBe(false);
    expect(codexKind('Redham')).toBeUndefined();
    expect(known('Hotfield')).toBe(false);
  });

  it('nudges about an area named in a canon fact', async () => {
    const text = await call('remember', { op: 'fact', subject: 'The woods', fact: 'Wolves hunt the Coldwood in winter.' });
    expect(nudgeLines(text)).toEqual([nudge('Coldwood')]);
    expect(known('Coldwood')).toBe(false);
    expect(codexKind('Coldwood')).toBeUndefined();
  });

  it('nudges about a place only the subject of a canon fact names', async () => {
    const text = await call('remember', { op: 'fact', subject: 'Raven Marshes', fact: 'Marsh lights lead travellers astray there.' });
    expect(nudgeLines(text)).toEqual([nudge('Raven Marshes')]);
    expect(known('Raven Marshes')).toBe(false);
  });

  it('nudges about a place the DM writes up in the codex under its own name, leaving that entry alone', async () => {
    const text = await call('entity', { op: 'upsert', kind: 'place', name: 'Stormcourtby', summary: 'A town of courts.' });
    expect(nudgeLines(text)).toEqual([nudge('Stormcourtby')]);
    expect(known('Stormcourtby')).toBe(false);
    const rows = db.prepare('SELECT summary FROM entity WHERE campaign_id = ? AND name = ?').all(campaignId, 'Stormcourtby');
    expect(rows).toEqual([{ summary: 'A town of courts.' }]);
  });

  it('puts several places on one line', async () => {
    const text = await call('log_event', { kind: 'travel', text: 'The road from Redham to Hotfield was quiet.' });
    expect(nudgeLines(text)).toEqual([
      `Named in visible text but not on the player's map: Redham, Hotfield — region {op: reveal, place: "<name>"} once the party has heard of it.`,
    ]);
  });

  it('matches a name only where its capitalised words are capitalised', async () => {
    addPlace('settlement', 'Dark Gate');
    addPlace('settlement', 'New Mine');
    for (const quiet of ['At the end of the lane a dark gate looms.', 'Dark gate stones line the road.']) {
      expect(nudgeLines(await call('log_event', { kind: 'narration', text: quiet })), quiet).toEqual([]);
    }
    const text = await call('log_event', { kind: 'narration', text: 'Beyond the ridge the Dark Gate looms.' });
    expect(nudgeLines(text)).toEqual([nudge('Dark Gate')]);
    const shouted = await call('log_event', { kind: 'narration', text: 'A sign reads: NEW MINE, KEEP OUT.' });
    expect(nudgeLines(shouted)).toEqual([nudge('New Mine')]);
    expect(known('Dark Gate')).toBe(false);
    expect(known('New Mine')).toBe(false);
  });

  it('skips a name inside a longer capitalised name, looking past a "the" before it', async () => {
    addPlace('settlement', 'Dark Gate');
    addPlace('settlement', 'Copper Well');
    const saved = await call('checkpoint', {
      op: 'save',
      scene_title: 'Through The Dark Gate',
      scene_summary: 'They took rooms at the Copper Well Tavern.',
    });
    expect(nudgeLines(saved)).toEqual([]);
    for (const named of ['The Dark Gate looms.', '"Go on," said Bram. Dark Gate is near.', 'At last we reached Dark Gate, Bram.']) {
      expect(nudgeLines(await call('log_event', { kind: 'narration', text: named })), named).toEqual([nudge('Dark Gate')]);
    }
    expect(known('Dark Gate')).toBe(false);
    expect(known('Copper Well')).toBe(false);
  });

  it('lets the small words of a generated name go lowercase in prose', async () => {
    addPlace('area', 'Vale Of The Hollow King');
    const text = await call('log_event', { kind: 'narration', text: 'They crossed into the Vale of the Hollow King at dusk.' });
    expect(nudgeLines(text)).toEqual([nudge('Vale Of The Hollow King')]);
    expect(nudgeLines(await call('log_event', { kind: 'narration', text: 'A vale of the hollow king, they said.' }))).toEqual([]);
  });

  it('names only places the party does not already know', async () => {
    await call('region', { op: 'reveal', place: 'Redham' });
    const both = await call('log_event', { kind: 'travel', text: 'The party left Redham on the road to Hotfield.' });
    expect(nudgeLines(both)).toEqual([nudge('Hotfield')]);
    await call('region', { op: 'reveal', place: 'Hotfield' });
    const again = await call('log_event', { kind: 'travel', text: 'They came back from Hotfield to Redham.' });
    expect(nudgeLines(again)).toEqual([]);
  });

  it('matches whole names only and skips names under four letters', async () => {
    addPlace('area', 'Moor');
    addPlace('settlement', 'Ash');
    const text = await call('log_event', {
      kind: 'narration',
      text: 'The moorland around Blackmoor was grey with ash. The Ash road ran on.',
    });
    expect(nudgeLines(text)).toEqual([]);
    expect(known('Moor')).toBe(false);
    expect(known('Ash')).toBe(false);
  });

  it('flags a danger named in visible text but never reveals it, and keeps every line from the player', async () => {
    addPlace('danger', 'Hollow Barrow');
    const text = await call('checkpoint', {
      op: 'save',
      scene_summary: 'A shepherd near Southern Landing spoke of lights at the Hollow Barrow.',
    });
    expect(nudgeLines(text)).toEqual([nudge('Southern Landing')]);
    expect(dangerLines(text)).toEqual([
      'Danger Hollow Barrow is named in player-visible text: region {op: reveal, place: "Hollow Barrow"} if the party has heard of it, or reword it.',
    ]);
    expect(known('Southern Landing')).toBe(false);
    expect(known('Hollow Barrow')).toBe(false);
    expect(codexKind('Hollow Barrow')).toBeUndefined();
    // The reply lines are the DM's alone: nothing the window reads or the database keeps carries them.
    const snapshot = JSON.stringify(campaignSnapshot(db, campaignId, { forPlayer: true }));
    for (const phrase of ["not on the player's map", 'named in player-visible text', 'example.test/dungeon']) {
      expect(snapshot).not.toContain(phrase);
    }
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const rows = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all());
      expect(rows, name).not.toContain("not on the player's map");
      expect(rows, name).not.toContain('named in player-visible text');
    }
  });

  it('nudges nothing from fields the player never sees', async () => {
    const hidden = [
      ['entity', { op: 'upsert', kind: 'npc', name: 'Hesper Dunmow', summary: 'A watch captain.', hidden_notes: 'Smuggles through Coldwood.' }],
      ['thread', { op: 'add', title: 'Who rings the bell?', summary: 'The bell is rung in Hotfield.', hidden: true }],
      ['story', { op: 'outline', ending: 'The party burns Redham.', secret_notes: 'Raven Marshes hides the cult.' }],
      ['rumour', { op: 'add', text: 'They say Ironfall Fens swallows travellers.' }],
    ] as const;
    for (const [name, args] of hidden) expect(nudgeLines(await call(name, args)), name).toEqual([]);
    for (const place of ['Coldwood', 'Hotfield', 'Redham', 'Raven Marshes', 'Ironfall Fens']) expect(known(place), place).toBe(false);
  });
});
