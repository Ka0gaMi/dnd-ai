// Auto-reveal, through the MCP client: a write that names an unknown settlement or area in player-visible text marks
// it known with a codex entry and says so in one DM-only line; dangers, hidden fields and refused calls reveal nothing.
import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot, createCampaign } from '../src/core/campaign.js';
import { upsertEntity } from '../src/core/codex.js';
import { importRegion, type PlaceKind } from '../src/core/region.js';
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

const revealLines = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('Revealed on the'));
const dangerLines = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('Danger '));

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

beforeEach(async () => {
  db = openDb(':memory:');
  client = await connect();
  campaignId = createCampaign(db, { name: 'Reveal', story_shape: 'sandbox' }).campaign_id;
  importRegion(db, campaignId, REALM, { source: 'generated' });
});

describe('auto-reveal', () => {
  it('reveals a settlement a checkpoint summary names, with its codex entry and one reply line', async () => {
    const text = await call('checkpoint', { op: 'save', scene_summary: 'The party rode into Redham at dusk and took rooms.' });
    expect(revealLines(text)).toEqual(["Revealed on the player's map (named in visible text): Redham."]);
    expect(known('Redham')).toBe(true);
    expect(codexKind('Redham')).toBe('place');
    expect(known('Hotfield')).toBe(false);
  });

  it('reveals an area named in a canon fact', async () => {
    const text = await call('remember', { op: 'fact', subject: 'The woods', fact: 'Wolves hunt the Coldwood in winter.' });
    expect(revealLines(text)).toEqual(["Revealed on the player's map (named in visible text): Coldwood."]);
    expect(known('Coldwood')).toBe(true);
    expect(codexKind('Coldwood')).toBe('place');
  });

  it('reveals a place only the subject of a canon fact names', async () => {
    const text = await call('remember', { op: 'fact', subject: 'Raven Marshes', fact: 'Marsh lights lead travellers astray there.' });
    expect(revealLines(text)).toEqual(["Revealed on the player's map (named in visible text): Raven Marshes."]);
    expect(known('Raven Marshes')).toBe(true);
  });

  it('reveals a place the DM writes up in the codex under its own name, keeping that entry', async () => {
    const text = await call('entity', { op: 'upsert', kind: 'place', name: 'Stormcourtby', summary: 'A town of courts.' });
    expect(revealLines(text)).toEqual(["Revealed on the player's map (named in visible text): Stormcourtby."]);
    const rows = db.prepare('SELECT summary FROM entity WHERE campaign_id = ? AND name = ?').all(campaignId, 'Stormcourtby');
    expect(rows).toEqual([{ summary: 'A town of courts.' }]);
  });

  it('matches a name only where its capitalised words are capitalised', async () => {
    addPlace('settlement', 'Dark Gate');
    addPlace('settlement', 'New Mine');
    for (const quiet of ['At the end of the lane a dark gate looms.', 'Dark gate stones line the road.']) {
      expect(revealLines(await call('log_event', { kind: 'narration', text: quiet })), quiet).toEqual([]);
    }
    expect(known('Dark Gate')).toBe(false);
    const text = await call('log_event', { kind: 'narration', text: 'Beyond the ridge the Dark Gate looms.' });
    expect(revealLines(text)).toEqual(["Revealed on the player's map (named in visible text): Dark Gate."]);
    const shouted = await call('log_event', { kind: 'narration', text: 'A sign reads: NEW MINE, KEEP OUT.' });
    expect(revealLines(shouted)).toEqual(["Revealed on the player's map (named in visible text): New Mine."]);
  });

  it('lets the small words of a generated name go lowercase in prose', async () => {
    addPlace('area', 'Vale Of The Hollow King');
    const text = await call('log_event', { kind: 'narration', text: 'They crossed into the Vale of the Hollow King at dusk.' });
    expect(revealLines(text)).toEqual(["Revealed on the player's map (named in visible text): Vale Of The Hollow King."]);
    expect(revealLines(await call('log_event', { kind: 'narration', text: 'A vale of the hollow king, they said.' }))).toEqual([]);
  });

  it("passes on the reveal's warning when the codex name is taken", async () => {
    upsertEntity(db, { campaign_id: campaignId, kind: 'npc', name: 'Hotfield' });
    const text = await call('log_event', { kind: 'travel', text: 'The party walked to Hotfield.' });
    const lines = text.split('\n');
    const at = lines.indexOf("Revealed on the player's map (named in visible text): Hotfield.");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toBe('The codex already has a npc named "Hotfield", so no place entry was made.');
    expect(known('Hotfield')).toBe(true);
    expect(codexKind('Hotfield')).toBe('npc');
  });

  it('names only places the party did not already know', async () => {
    await call('region', { op: 'reveal', place: 'Redham' });
    const both = await call('log_event', { kind: 'travel', text: 'The party left Redham on the road to Hotfield.' });
    expect(revealLines(both)).toEqual(["Revealed on the player's map (named in visible text): Hotfield."]);
    const again = await call('log_event', { kind: 'travel', text: 'They came back from Hotfield to Redham.' });
    expect(revealLines(again)).toEqual([]);
  });

  it('matches whole names only and skips names under four letters', async () => {
    addPlace('area', 'Moor');
    addPlace('settlement', 'Ash');
    const text = await call('log_event', {
      kind: 'narration',
      text: 'The moorland around Blackmoor was grey with ash. The Ash road ran on.',
    });
    expect(revealLines(text)).toEqual([]);
    expect(known('Moor')).toBe(false);
    expect(known('Ash')).toBe(false);
  });

  it('nudges about a danger named in visible text but never reveals it', async () => {
    addPlace('danger', 'Hollow Barrow');
    const text = await call('checkpoint', {
      op: 'save',
      scene_summary: 'A shepherd near Southern Landing spoke of lights at the Hollow Barrow.',
    });
    expect(revealLines(text)).toEqual(["Revealed on the player's map (named in visible text): Southern Landing."]);
    expect(dangerLines(text)).toEqual([
      'Danger Hollow Barrow is named in player-visible text: region {op: reveal, place: "Hollow Barrow"} if the party has heard of it, or reword it.',
    ]);
    expect(known('Hollow Barrow')).toBe(false);
    expect(codexKind('Hollow Barrow')).toBeUndefined();
    // The reply lines are the DM's alone: nothing the window reads or the database keeps carries them.
    const snapshot = JSON.stringify(campaignSnapshot(db, campaignId, { forPlayer: true }));
    expect(snapshot).not.toContain('named in visible text');
    expect(snapshot).not.toContain('example.test/dungeon');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    for (const { name } of tables) {
      expect(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()), name).not.toContain('named in visible text');
    }
  });

  it('reveals nothing from fields the player never sees', async () => {
    const hidden = [
      ['entity', { op: 'upsert', kind: 'npc', name: 'Hesper Dunmow', summary: 'A watch captain.', hidden_notes: 'Smuggles through Coldwood.' }],
      ['thread', { op: 'add', title: 'Who rings the bell?', summary: 'The bell is rung in Hotfield.', hidden: true }],
      ['story', { op: 'outline', ending: 'The party burns Redham.', secret_notes: 'Raven Marshes hides the cult.' }],
      ['rumour', { op: 'add', text: 'They say Ironfall Fens swallows travellers.' }],
    ] as const;
    for (const [name, args] of hidden) expect(revealLines(await call(name, args)), name).toEqual([]);
    for (const place of ['Coldwood', 'Hotfield', 'Redham', 'Raven Marshes', 'Ironfall Fens']) expect(known(place), place).toBe(false);
  });

  it('reveals nothing on a refused call', async () => {
    const refused = await client.callTool({
      name: 'checkpoint',
      arguments: {
        op: 'save',
        campaign_id: campaignId,
        scene_summary: 'The party reached Redham.',
        facts: [{ subject: 'Redham', fact: 'Redham has a new reeve.', supersedes_id: 9999 }],
      },
    });
    expect(refused.isError).toBe(true);
    expect(revealLines(replyText(refused))).toEqual([]);
    expect(known('Redham')).toBe(false);
    expect(codexKind('Redham')).toBeUndefined();
  });

  it("reveals the place a checkpoint's scene_location alone names", async () => {
    const text = await call('checkpoint', { op: 'save', scene_summary: 'The party made camp.', scene_location: 'Ficengwind' });
    expect(revealLines(text)).toEqual(["Revealed on the player's map (named in visible text): Ficengwind."]);
    expect(known('Ficengwind')).toBe(true);
  });

  it('does nothing in a campaign without a region map', async () => {
    campaignId = createCampaign(db, { name: 'Unmapped', story_shape: 'sandbox' }).campaign_id;
    const text = await call('checkpoint', { op: 'save', scene_summary: 'The party rode into Redham.', scene_location: 'Redham' });
    expect(revealLines(text)).toEqual([]);
    expect(codexKind('Redham')).toBeUndefined();
  });
});
