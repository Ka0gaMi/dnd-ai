// Permanent campaign deletion: every campaign-scoped row, the child rows without a campaign_id and
// the portrait folder go, while a second campaign sharing the database keeps every one of its rows.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startEncounter } from '../src/combat/engine.js';
import { advanceTime } from '../src/core/calendar.js';
import { UnknownCampaignError, deleteCampaign } from '../src/core/campaign-delete.js';
import { createCampaign, rollAndRecord, saveCheckpoint, upsertQuests } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { upsertEntity } from '../src/core/codex.js';
import { portraitsDir, savePortraitUpload } from '../src/core/portraits.js';
import { importRegion } from '../src/core/region.js';
import { captureCheckpoint } from '../src/core/rewind.js';
import { ensureWorld } from '../src/core/world-seed.js';
import { openDb, type Db } from '../src/db/connection.js';
import { HOST, startHttpServer } from '../src/transport/http.js';
import { deleteCampaignError } from '../src/transport/routes/campaign-delete.js';

const realmSafe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Child tables that carry no campaign_id: the delete reaches them through their parent's scope. */
const CHILD_SCOPE: ReadonlyArray<readonly [child: string, fk: string, parent: string]> = [
  ['quest_step', 'quest_id', 'quest'],
  ['combatant', 'encounter_id', 'encounter'],
  ['effect', 'encounter_id', 'encounter'],
  ['combat_log', 'encounter_id', 'encounter'],
  ['combat_undo', 'encounter_id', 'encounter'],
  ['world_packet_arrival', 'packet_id', 'world_packet'],
];

function campaignTables(db: Db): string[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return tables
    .filter(({ name }) => db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(name, 'campaign_id'))
    .map(({ name }) => name);
}

/** Every row of one campaign, including the campaign-scoped children, so another campaign can be compared. */
function scopedCounts(db: Db, campaignId: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of campaignTables(db)) {
    out[table] = (
      db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE campaign_id = ?`).get(campaignId) as { n: number }
    ).n;
  }
  for (const [child, fk, parent] of CHILD_SCOPE) {
    out[child] = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM "${child}" WHERE "${fk}" IN (SELECT id FROM "${parent}" WHERE campaign_id = ?)`)
        .get(campaignId) as { n: number }
    ).n;
  }
  return out;
}

/** A campaign with rows in the areas deletion has to reach: character, quest, checkpoint, codex,
 * encounter, portraits, a region with its world, time passing and faiths. */
async function seedCampaign(db: Db, campaignId: number): Promise<void> {
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

  upsertQuests(db, campaignId, [
    { title: 'Find the relic', kind: 'main', steps: [{ text: 'Ask the smith' }, { text: 'Cross the ford' }] },
  ]);
  saveCheckpoint(db, {
    campaign_id: campaignId,
    scene_title: 'Departure',
    scene_summary: 'They left Emberwatch at dawn.',
    canon_facts: [{ subject: 'Emberwatch', fact: 'Its east gate is barred at night.' }],
    glossary: [{ term: 'Emberwatch', definition: 'A watchtower on the ash road.' }],
  });
  captureCheckpoint(db, campaignId, null);
  upsertEntity(db, { campaign_id: campaignId, kind: 'npc', name: `Mira ${campaignId}` });
  rollAndRecord(db, { expr: '1d20+3', purpose: 'Stealth check', dc: 12, campaign_id: campaignId });
  savePortraitUpload({
    db,
    campaign_id: campaignId,
    subject: { creature: `Goblin ${campaignId}` },
    bytes: Buffer.from(PNG_BASE64, 'base64'),
  });

  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: 2 }],
  });

  importRegion(db, campaignId, realmSafe, { source: 'generated' });
  ensureWorld(db, campaignId);
  advanceTime(db, campaignId, { days: 40 });
  advanceTime(db, campaignId, { days: 40 });
}

let db: Db;
let portraitsRoot: string;
let doomed: number;
let keeper: number;

beforeEach(async () => {
  db = openDb(':memory:');
  portraitsRoot = mkdtempSync(join(tmpdir(), 'dnd-delete-portraits-'));
  process.env.DND_AI_PORTRAITS_DIR = portraitsRoot;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  doomed = createCampaign(db, { name: 'Doomed', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  keeper = createCampaign(db, { name: 'Keeper', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  await seedCampaign(db, doomed);
  await seedCampaign(db, keeper);
});

afterEach(() => {
  delete process.env.DND_AI_PORTRAITS_DIR;
  rmSync(portraitsRoot, { recursive: true, force: true });
});

describe('deleteCampaign', () => {
  it('removes every row of the campaign and leaves no dangling reference', () => {
    const before = scopedCounts(db, doomed);
    // The seed reaches each area the deletion has to cover, so a silent miss cannot pass.
    expect(before.quest).toBeGreaterThan(0);
    expect(before.quest_step).toBeGreaterThan(0);
    expect(before.checkpoint).toBeGreaterThan(0);
    expect(before.entity).toBeGreaterThan(0);
    expect(before.creature_portrait).toBeGreaterThan(0);
    expect(before.encounter).toBeGreaterThan(0);
    expect(before.combatant).toBeGreaterThan(0);
    expect(before.combat_log).toBeGreaterThan(0);
    expect(before.world_faith).toBeGreaterThan(0);
    expect(before.world_event).toBeGreaterThan(0);
    expect(before.world_packet).toBeGreaterThan(0);
    expect(before.world_packet_arrival).toBeGreaterThan(0);

    const { deleted_rows } = deleteCampaign(db, doomed);
    const totalBefore = Object.values(before).reduce((sum, n) => sum + n, 0);
    expect(deleted_rows).toBeGreaterThanOrEqual(totalBefore);

    for (const [table, count] of Object.entries(scopedCounts(db, doomed))) {
      expect(count, `${table} still has rows for the deleted campaign`).toBe(0);
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it("leaves a second campaign's rows untouched, table for table", () => {
    const otherBefore = scopedCounts(db, keeper);
    const sharedGlossary = (
      db.prepare('SELECT COUNT(*) AS n FROM glossary_entry WHERE campaign_id IS NULL').get() as { n: number }
    ).n;

    deleteCampaign(db, doomed);

    expect(scopedCounts(db, keeper)).toEqual(otherBefore);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM glossary_entry WHERE campaign_id IS NULL').get() as { n: number }).n,
    ).toBe(sharedGlossary);
  });

  it('removes the campaign portrait folder and keeps the other campaign folder', () => {
    const doomedDir = join(portraitsDir(), String(doomed));
    const keeperDir = join(portraitsDir(), String(keeper));
    expect(existsSync(doomedDir)).toBe(true);
    expect(existsSync(keeperDir)).toBe(true);

    deleteCampaign(db, doomed);

    expect(existsSync(doomedDir)).toBe(false);
    expect(existsSync(keeperDir)).toBe(true);
  });

  it('throws for an unknown campaign and changes nothing', () => {
    expect(() => deleteCampaign(db, 999999)).toThrow(/No campaign with id 999999/);
    expect(db.prepare('SELECT id FROM campaign WHERE id = ?').get(keeper)).toBeTruthy();
  });

  it("deletes despite a dangling reference another campaign left behind", () => {
    // Legacy data can leave a violation elsewhere; the whole-database check used to trip over it.
    db.pragma('foreign_keys = OFF');
    db.prepare(
      "INSERT INTO canon_fact (campaign_id, subject, fact, established_scene_id, created_at) VALUES (?, 'Ghost', 'A fact with no scene', 999999, '2026-01-01T00:00:00Z')",
    ).run(keeper);
    db.pragma('foreign_keys = ON');
    expect(db.pragma('foreign_key_check')).not.toEqual([]);

    expect(() => deleteCampaign(db, doomed)).not.toThrow();
    expect(db.prepare('SELECT id FROM campaign WHERE id = ?').get(keeper)).toBeTruthy();
  });
});

describe('deleteCampaignError', () => {
  it('maps an unknown campaign to 404 and any other failure to 500', () => {
    expect(deleteCampaignError(new UnknownCampaignError('No campaign with id 7.'))).toEqual({
      status: 404,
      error: 'no such campaign',
    });
    expect(deleteCampaignError(new Error('database is locked'))).toEqual({
      status: 500,
      error: 'failed to delete campaign',
    });
  });
});

describe('DELETE /api/campaigns/:id', () => {
  let routeDb: Db;
  let routePortraitsRoot: string;
  let base: string;
  let stop: () => Promise<void>;
  let routeDoomed: number;

  beforeAll(async () => {
    routePortraitsRoot = mkdtempSync(join(tmpdir(), 'dnd-delete-route-'));
    process.env.DND_AI_PORTRAITS_DIR = routePortraitsRoot;
    routeDb = openDb(':memory:');
    routeDoomed = createCampaign(routeDb, { name: 'Route Doomed', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
    await seedCampaign(routeDb, routeDoomed);
    const started = await startHttpServer(routeDb, { port: 0, secret: 'delete0123456789abcdef0123456' });
    base = `http://${HOST}:${started.port}`;
    stop = started.close;
  });

  afterAll(async () => {
    await stop();
    delete process.env.DND_AI_PORTRAITS_DIR;
    rmSync(routePortraitsRoot, { recursive: true, force: true });
  });

  it('400s a non-integer id', async () => {
    const res = await fetch(`${base}/api/campaigns/abc`, { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad campaign id' });
  });

  it('404s an unknown campaign', async () => {
    const res = await fetch(`${base}/api/campaigns/999999`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such campaign' });
  });

  it('200s and deletes the campaign for real', async () => {
    const res = await fetch(`${base}/api/campaigns/${routeDoomed}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean; deleted_rows: number };
    expect(body).toMatchObject({ deleted: true });
    expect(body.deleted_rows).toBeGreaterThan(0);

    const list = (await (await fetch(`${base}/api/campaigns?include_deleted=1`)).json()) as Array<{ id: number }>;
    expect(list.map((c) => c.id)).not.toContain(routeDoomed);

    const again = await fetch(`${base}/api/campaigns/${routeDoomed}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });
});
