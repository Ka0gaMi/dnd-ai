// Reputation: memories fade by the size of the deed, a deed is known only within its range of travel,
// a rival's backlash reaches only rivals who would hear of it, and knownFor stays DM-only.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';
import type { WorldFaction } from '../src/core/world-store.js';
import type { WorldPlace } from '../src/core/region.js';

const medium = JSON.parse(readFileSync(new URL('./fixtures/realm-medium.json', import.meta.url), 'utf8')) as unknown;

let db: Db;
let base: string;
let stop: () => Promise<void>;
let openDb: (typeof import('../src/db/connection.js'))['openDb'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let saveCheckpoint: (typeof import('../src/core/campaign.js'))['saveCheckpoint'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let findPlace: (typeof import('../src/core/region.js'))['findPlace'];
let getRegion: (typeof import('../src/core/region.js'))['getRegion'];
let ensureWorld: (typeof import('../src/core/world-seed.js'))['ensureWorld'];
let currentGameDay: (typeof import('../src/core/world-store.js'))['currentGameDay'];
let insertFaction: (typeof import('../src/core/world-store.js'))['insertFaction'];
let insertAgenda: (typeof import('../src/core/world-store.js'))['insertAgenda'];
let travelDays: (typeof import('../src/core/world-news.js'))['travelDays'];
let memory: typeof import('../src/core/world-memory.js');
let captureCheckpoint: (typeof import('../src/core/rewind.js'))['captureCheckpoint'];
let rewindToCheckpoint: (typeof import('../src/core/rewind.js'))['rewindToCheckpoint'];
let createGameServer: (typeof import('../src/mcp/server.js'))['createGameServer'];

beforeAll(async () => {
  // Fresh modules so the seeded world draws on the real dice, whatever an earlier suite left behind.
  vi.resetModules();
  ({ openDb } = await import('../src/db/connection.js'));
  ({ createCampaign, saveCheckpoint } = await import('../src/core/campaign.js'));
  ({ importRegion, findPlace, getRegion } = await import('../src/core/region.js'));
  ({ ensureWorld } = await import('../src/core/world-seed.js'));
  ({ currentGameDay, insertFaction, insertAgenda } = await import('../src/core/world-store.js'));
  ({ travelDays } = await import('../src/core/world-news.js'));
  memory = await import('../src/core/world-memory.js');
  ({ captureCheckpoint, rewindToCheckpoint } = await import('../src/core/rewind.js'));
  ({ createGameServer } = await import('../src/mcp/server.js'));
  const { HOST, startHttpServer } = await import('../src/transport/http.js');
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'reputation0123456789abcdef01234' });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const textOf = (result: unknown): string => (result as { content: Array<{ text: string }> }).content[0]!.text;

interface DeedData {
  place: { id: number; name: string } | null;
  realm_id: number | null;
  known_within_days: number | null;
  recorded: Array<{ subject_id: number; value: number; reason: string; total: number; band: string }>;
}

interface AttitudeRow {
  subject_id: number;
  value: number;
  place_id: number | null;
  realm_id: number | null;
  permanent: number;
  rival_of: number | null;
}

/** The medium map with its world seeded, every seeded agenda set aside so only a test's rivalries count. */
function worldCampaign(): number {
  const id = createCampaign(db, { name: 'Reputation', story_shape: 'sandbox' }).campaign_id;
  importRegion(db, id, medium, { source: 'generated' });
  ensureWorld(db, id);
  db.prepare("UPDATE world_agenda SET status = 'abandoned' WHERE campaign_id = ?").run(id);
  return id;
}

function place(campaignId: number, name: string): WorldPlace {
  return findPlace(db, campaignId, name)!;
}

function realmIdOf(campaignId: number, name: string): number {
  const faction = db
    .prepare("SELECT realm_id FROM world_faction WHERE campaign_id = ? AND type = 'realm' AND place_id = ?")
    .get(campaignId, place(campaignId, name).id) as { realm_id: number };
  return faction.realm_id;
}

/** A guild seated at a settlement, so each test controls exactly where its factions sit. */
function seatFaction(campaignId: number, name: string, seat: string, realmId: number): WorldFaction {
  return insertFaction(db, campaignId, {
    name,
    type: 'guild',
    realm_id: realmId,
    county_id: null,
    place_id: place(campaignId, seat).id,
    secrecy: 'open',
    resources: 3,
    capacities: {},
    created_day: currentGameDay(db, campaignId),
  });
}

function rivals(campaignId: number, a: WorldFaction, b: WorldFaction): void {
  insertAgenda(db, campaignId, {
    faction_id: a.id,
    template: 'trade_monopoly',
    target_kind: 'rival_faction',
    target_id: b.id,
    target_name: b.name,
    clock_size: 8,
    clock_filled: 0,
    portents: [],
    status: 'active',
    started_day: currentGameDay(db, campaignId),
  });
}

function attitudeRows(campaignId: number): AttitudeRow[] {
  return db
    .prepare(
      'SELECT subject_id, value, place_id, realm_id, permanent, rival_of FROM world_attitude WHERE campaign_id = ? ORDER BY id',
    )
    .all(campaignId) as AttitudeRow[];
}

describe('fading by deed size', () => {
  let campaignId: number;
  const subject = { kind: 'faction', id: 1 } as const;

  beforeEach(() => {
    campaignId = createCampaign(db, { name: 'Fading', story_shape: 'sandbox' }).campaign_id;
  });

  it('gives each size its tier: 30 and 90 days, then 180 and 720, then never', () => {
    const tiers: Array<[number, number, boolean]> = [
      [1, 30, false],
      [2, 30, false],
      [-1, 90, false],
      [-2, 90, false],
      [3, 180, false],
      [4, 180, false],
      [-3, 720, false],
      [-4, 720, false],
      [5, 180, true],
      [-5, 720, true],
    ];
    for (const [value, fade, permanent] of tiers) {
      expect(memory.defaultFadeDays(value)).toBe(fade);
      expect(memory.isPermanentDeed(value)).toBe(permanent);
      const stored = memory.addAttitude(db, campaignId, subject, { value, reason: `deed ${value}`, day: 0 });
      expect(stored.fade_days).toBe(fade);
      expect(stored.permanent).toBe(permanent);
    }
  });

  it('decays each tier linearly and keeps a deed of 5 in full', () => {
    const at = (value: number, day: number): number => {
      const id = createCampaign(db, { name: `Decay ${value}`, story_shape: 'sandbox' }).campaign_id;
      memory.addAttitude(db, id, subject, { value, reason: 'a deed', day: 100 });
      return memory.attitudeOf(db, id, subject, day).total;
    };
    expect(at(2, 115)).toBe(1);
    expect(at(2, 130)).toBe(0);
    expect(at(-2, 145)).toBe(-1);
    expect(at(-2, 190)).toBe(0);
    expect(at(4, 190)).toBe(2);
    expect(at(4, 280)).toBe(0);
    expect(at(-4, 460)).toBe(-2);
    expect(at(-4, 820)).toBe(0);
    // The audit's case: a +5 for saving the realm is still whole two months on, and years on.
    expect(at(5, 160)).toBe(5);
    expect(at(5, 100 + 3650)).toBe(5);
    expect(at(-5, 100 + 3650)).toBe(-5);
  });

  it('leaves a row written before the scope columns fading on its own fade_days', () => {
    db.prepare(
      `INSERT INTO world_attitude (campaign_id, subject_kind, subject_id, value, reason, day, fade_days)
       VALUES (?, 'faction', 1, 5, 'an old triumph', 100, 60)`,
    ).run(campaignId);
    const view = memory.attitudeOf(db, campaignId, subject, 130);
    expect(view.total).toBe(2.5);
    expect(view.reasons[0]).toMatchObject({ permanent: false, place_id: null, realm_id: null, rival_of: null });
  });

  it('keeps the clamp at +10 with permanent deeds', () => {
    for (const reason of ['a', 'b', 'c']) memory.addAttitude(db, campaignId, subject, { value: 5, reason, day: 0 });
    expect(memory.attitudeOf(db, campaignId, subject, 5000).total).toBe(10);
  });
});

describe('where a deed is known', () => {
  it('reaches places within its days of travel and no further', () => {
    const campaignId = worldCampaign();
    const view = getRegion(db, campaignId)!;
    const ember = place(campaignId, 'Emberpoint');
    expect(memory.DEED_KNOWN_DAYS).toEqual({ 1: 1, 2: 2, 3: 5, 4: 10, 5: Number.POSITIVE_INFINITY });

    // A deed of 3 is known 5 days out, at Blackwing, but not 6 days out, at Comon.
    expect(travelDays(view, ember, place(campaignId, 'Blackwing'))).toBe(5);
    expect(travelDays(view, ember, place(campaignId, 'Comon'))).toBe(6);
    expect(memory.deedKnownAt(view, ember, 3, place(campaignId, 'Blackwing'))).toBe(true);
    expect(memory.deedKnownAt(view, ember, -3, place(campaignId, 'Comon'))).toBe(false);

    const settlements = view.places.filter((entry) => entry.kind === 'settlement');
    for (const value of [1, 2, 3, 4, -1, -4]) {
      const range = memory.DEED_KNOWN_DAYS[Math.abs(value)]!;
      const known = settlements.filter((entry) => memory.deedKnownAt(view, ember, value, entry));
      expect(known.length).toBeGreaterThan(0);
      expect(known.length).toBeLessThan(settlements.length);
      for (const entry of settlements) {
        expect(memory.deedKnownAt(view, ember, value, entry)).toBe(travelDays(view, ember, entry) <= range);
      }
    }
    expect(settlements.every((entry) => memory.deedKnownAt(view, ember, 5, entry))).toBe(true);
  });
});

describe('deed backlash', () => {
  it("defaults to the party's place and turns only a rival seated within range", async () => {
    const client = await connect();
    const campaignId = worldCampaign();
    const realm = realmIdOf(campaignId, 'Goldcaster');
    const ember = place(campaignId, 'Emberpoint');
    const target = seatFaction(campaignId, 'Emberpoint Wardens', 'Emberpoint', realm);
    const near = seatFaction(campaignId, 'River Gate Wardens', 'River Gate', realm);
    const far = seatFaction(campaignId, 'Kaz Wardens', 'Kaz', realm);
    rivals(campaignId, target, near);
    rivals(campaignId, far, target);
    saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'At the docks.', scene_location: 'the Emberpoint docks' });
    const view = getRegion(db, campaignId)!;
    expect(travelDays(view, ember, place(campaignId, 'River Gate'))).toBeLessThanOrEqual(5);
    expect(travelDays(view, ember, place(campaignId, 'Kaz'))).toBeGreaterThan(5);

    const result = await client.callTool({
      name: 'world',
      arguments: { campaign_id: campaignId, op: 'deed', target: target.name, value: 3, reason: 'saved their caravan' },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as unknown as DeedData;
    expect(data.place).toEqual({ id: ember.id, name: 'Emberpoint' });
    expect(data.known_within_days).toBe(5);
    expect(data.recorded.map((entry) => [entry.subject_id, entry.value])).toEqual([
      [target.id, 3],
      [near.id, -1],
    ]);
    expect(data.recorded[0]).toMatchObject({ total: 3, band: 'friendly' });
    expect(textOf(result)).toContain('Emberpoint Wardens: +3 saved their caravan; now friendly (+3)');
    expect(textOf(result)).toContain('River Gate Wardens: -1 saved their caravan (rival of Emberpoint Wardens); now neutral (-1)');

    const realmOfEmber = data.realm_id;
    expect(realmOfEmber).toBe(realm);
    expect(attitudeRows(campaignId)).toEqual([
      { subject_id: target.id, value: 3, place_id: ember.id, realm_id: realm, permanent: 0, rival_of: null },
      { subject_id: near.id, value: -1, place_id: ember.id, realm_id: realm, permanent: 0, rival_of: target.id },
    ]);

    // A deed of 4 is known 10 days out, so the far rival hears of it too.
    const larger = await client.callTool({
      name: 'world',
      arguments: { campaign_id: campaignId, op: 'deed', target: target.name, value: -4, reason: 'burned their warehouse' },
    });
    const largerData = larger.structuredContent as unknown as DeedData;
    expect(largerData.recorded.map((entry) => [entry.subject_id, entry.value])).toEqual([
      [target.id, -4],
      [near.id, 2],
      [far.id, 2],
    ]);
    await client.close();
  });

  it('takes an explicit place, and refuses an unknown one without writing', async () => {
    const client = await connect();
    const campaignId = worldCampaign();
    const realm = realmIdOf(campaignId, 'Goldcaster');
    const target = seatFaction(campaignId, 'Emberpoint Wardens', 'Emberpoint', realm);
    const far = seatFaction(campaignId, 'Kaz Wardens', 'Kaz', realm);
    rivals(campaignId, far, target);

    const atKaz = await client.callTool({
      name: 'world',
      arguments: { campaign_id: campaignId, op: 'deed', target: target.name, value: 3, reason: 'paid their debts', place: 'Kaz' },
    });
    const data = atKaz.structuredContent as unknown as DeedData;
    expect(data.place?.name).toBe('Kaz');
    expect(data.recorded.map((entry) => entry.subject_id)).toEqual([target.id, far.id]);

    const before = attitudeRows(campaignId);
    const refused = await client.callTool({
      name: 'world',
      arguments: { campaign_id: campaignId, op: 'deed', target: target.name, value: 3, reason: 'a test', place: 'Atlantis' },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('No place "Atlantis"');
    expect(attitudeRows(campaignId)).toEqual(before);
    await client.close();
  });

  it('with no place, turns only rivals in the same realm, unless the deed is known everywhere', async () => {
    const client = await connect();
    const campaignId = worldCampaign();
    const home = realmIdOf(campaignId, 'Goldcaster');
    const other = realmIdOf(campaignId, 'Mirkwind');
    expect(other).not.toBe(home);
    const target = seatFaction(campaignId, 'Emberpoint Wardens', 'Emberpoint', home);
    const sameRealm = seatFaction(campaignId, 'Kaz Wardens', 'Kaz', home);
    const otherRealm = seatFaction(campaignId, 'Ambercot Wardens', 'Ambercot', other);
    rivals(campaignId, target, sameRealm);
    rivals(campaignId, target, otherRealm);

    const result = await client.callTool({
      name: 'world',
      arguments: { campaign_id: campaignId, op: 'deed', target: target.name, value: 3, reason: 'saved their caravan' },
    });
    const data = result.structuredContent as unknown as DeedData;
    expect(data.place).toBeNull();
    expect(data.realm_id).toBe(home);
    expect(data.recorded.map((entry) => entry.subject_id)).toEqual([target.id, sameRealm.id]);
    expect(textOf(result)).toContain('only rivals in its realm');

    const whole = await client.callTool({
      name: 'world',
      arguments: { campaign_id: campaignId, op: 'deed', target: target.name, value: 5, reason: 'saved the realm' },
    });
    const wholeData = whole.structuredContent as unknown as DeedData;
    expect(wholeData.known_within_days).toBeNull();
    expect(wholeData.recorded.map((entry) => entry.subject_id)).toEqual([target.id, sameRealm.id, otherRealm.id]);
    const rows = attitudeRows(campaignId).slice(-3);
    expect(rows.map((row) => [row.permanent, row.place_id, row.realm_id])).toEqual([
      [1, null, home],
      [0, null, home],
      [0, null, home],
    ]);
    await client.close();
  });
});

describe('knownFor', () => {
  it('lists the strongest living memories in a realm in words, with deeds of 5 known everywhere', () => {
    const campaignId = worldCampaign();
    const home = realmIdOf(campaignId, 'Goldcaster');
    const other = realmIdOf(campaignId, 'Mirkwind');
    const wardens = seatFaction(campaignId, 'Emberpoint Wardens', 'Emberpoint', home);
    const millers = seatFaction(campaignId, 'Kaz Millers', 'Kaz', home);
    const envoys = seatFaction(campaignId, 'Ambercot Envoys', 'Ambercot', other);
    const ember = place(campaignId, 'Emberpoint').id;
    const ambercot = place(campaignId, 'Ambercot').id;
    const add = (faction: WorldFaction, value: number, reason: string, placeId: number, realmId: number, rivalOf?: number) =>
      memory.addAttitude(
        db,
        campaignId,
        { kind: 'faction', id: faction.id },
        { value, reason, day: 100, place_id: placeId, realm_id: realmId, rival_of: rivalOf ?? null },
      );
    add(wardens, 3, 'saved their caravan', ember, home);
    add(millers, -4, 'burned the granary', ember, home);
    add(wardens, 1, 'carried a letter', ember, home);
    add(millers, -1, 'saved their caravan (rival of Emberpoint Wardens)', ember, home, wardens.id);
    add(envoys, 2, 'escorted the envoy', ambercot, other);
    add(envoys, 5, 'slew the dragon', ambercot, other);

    expect(memory.knownFor(db, campaignId, home, 100)).toEqual([
      'slew the dragon (helped Ambercot Envoys)',
      'burned the granary (harmed Kaz Millers)',
      'saved their caravan (helped Emberpoint Wardens)',
    ]);
    expect(memory.knownFor(db, campaignId, home, 100, 5)).toEqual([
      'slew the dragon (helped Ambercot Envoys)',
      'burned the granary (harmed Kaz Millers)',
      'saved their caravan (helped Emberpoint Wardens)',
      'carried a letter (helped Emberpoint Wardens)',
    ]);
    // Two hundred days on, the gratitude has faded while the grudge and the dragon remain.
    expect(memory.knownFor(db, campaignId, home, 300)).toEqual([
      'slew the dragon (helped Ambercot Envoys)',
      'burned the granary (harmed Kaz Millers)',
    ]);
    expect(memory.knownFor(db, campaignId, other, 100)).toEqual([
      'slew the dragon (helped Ambercot Envoys)',
      'escorted the envoy (helped Ambercot Envoys)',
    ]);
    expect(memory.knownFor(db, campaignId, home, 100, 5).join(' ')).not.toMatch(/\d/);
  });
});

describe("the player's regard list", () => {
  it('still shows attitudes and reasons, and nothing of a deed beyond its reason', async () => {
    const client = await connect();
    const campaignId = worldCampaign();
    const realm = realmIdOf(campaignId, 'Goldcaster');
    const target = seatFaction(campaignId, 'Emberpoint Wardens', 'Emberpoint', realm);
    const near = seatFaction(campaignId, 'River Gate Wardens', 'River Gate', realm);
    rivals(campaignId, target, near);
    const danger = db
      .prepare("SELECT name FROM world_place WHERE campaign_id = ? AND kind = 'danger' AND known_to_party = 0 LIMIT 1")
      .get(campaignId) as { name: string };

    const deed = await client.callTool({
      name: 'world',
      arguments: {
        campaign_id: campaignId,
        op: 'deed',
        target: target.name,
        value: 5,
        reason: 'saved their caravan',
        place: danger.name,
      },
    });
    expect(deed.isError).toBeFalsy();

    const res = await fetch(`${base}/api/campaigns/${campaignId}/world`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const { world } = JSON.parse(text) as {
      world: { regard: Array<Record<string, unknown> & { id: number; reasons: Array<Record<string, unknown>> }> };
    };
    const shown = world.regard.filter((entry) => entry.id === target.id || entry.id === near.id);
    expect(shown).toEqual([
      { id: target.id, faction: target.name, value: 5, reasons: [{ reason: 'saved their caravan', value: 5 }], emblem: null },
      {
        id: near.id,
        faction: near.name,
        value: -2,
        reasons: [{ reason: 'saved their caravan (rival of Emberpoint Wardens)', value: -2 }],
        emblem: null,
      },
    ]);
    expect(text).not.toContain(danger.name);
    for (const key of ['place_id', 'realm_id', 'permanent', 'rival_of', 'fade_days']) expect(text).not.toContain(key);
    expect(text).not.toContain('(helped ');
    await client.close();
  });
});

describe('rewind', () => {
  it('keeps the scope columns through a checkpoint, and restores an older snapshot with defaults', () => {
    const campaignId = worldCampaign();
    const realm = realmIdOf(campaignId, 'Goldcaster');
    const target = seatFaction(campaignId, 'Emberpoint Wardens', 'Emberpoint', realm);
    const near = seatFaction(campaignId, 'River Gate Wardens', 'River Gate', realm);
    const ember = place(campaignId, 'Emberpoint').id;
    memory.addAttitude(db, campaignId, { kind: 'faction', id: target.id }, {
      value: 5,
      reason: 'saved the realm',
      day: 10,
      place_id: ember,
      realm_id: realm,
    });
    memory.addAttitude(db, campaignId, { kind: 'faction', id: near.id }, {
      value: -2,
      reason: 'saved the realm (rival of Emberpoint Wardens)',
      day: 10,
      place_id: ember,
      realm_id: realm,
      rival_of: target.id,
    });
    const before = db.prepare('SELECT * FROM world_attitude WHERE campaign_id = ? ORDER BY id').all(campaignId);
    const checkpointId = captureCheckpoint(db, campaignId, null);

    memory.addAttitude(db, campaignId, { kind: 'faction', id: target.id }, { value: -3, reason: 'later insult', day: 20 });
    db.prepare('UPDATE world_attitude SET permanent = 0, place_id = NULL, realm_id = NULL, rival_of = NULL WHERE campaign_id = ?').run(
      campaignId,
    );
    rewindToCheckpoint(db, campaignId);
    expect(db.prepare('SELECT * FROM world_attitude WHERE campaign_id = ? ORDER BY id').all(campaignId)).toEqual(before);

    // A snapshot written before migration 035 has no scope columns; its rows come back with the defaults.
    const row = db.prepare('SELECT snapshot_json FROM checkpoint WHERE id = ?').get(checkpointId) as { snapshot_json: string };
    const snapshot = JSON.parse(row.snapshot_json) as { tables: Record<string, Array<Record<string, unknown>>> };
    for (const attitude of snapshot.tables.world_attitude!) {
      for (const key of ['place_id', 'realm_id', 'permanent', 'rival_of']) delete attitude[key];
    }
    db.prepare('UPDATE checkpoint SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(snapshot), checkpointId);
    rewindToCheckpoint(db, campaignId);
    const restored = db
      .prepare('SELECT reason, value, place_id, realm_id, permanent, rival_of FROM world_attitude WHERE campaign_id = ? ORDER BY id')
      .all(campaignId);
    expect(restored).toEqual([
      { reason: 'saved the realm', value: 5, place_id: null, realm_id: null, permanent: 0, rival_of: null },
      {
        reason: 'saved the realm (rival of Emberpoint Wardens)',
        value: -2,
        place_id: null,
        realm_id: null,
        permanent: 0,
        rival_of: null,
      },
    ]);
  });
});
