// The world route: the player-safe World tab. Unknown campaigns and bad ids are refused, and only
// what the party has learned - heard news, known clocks and standing - reaches the reply.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

let base: string;
let db: Db;
let stop: () => Promise<void>;
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let findPlace: (typeof import('../src/core/region.js'))['findPlace'];
let ensureWorld: (typeof import('../src/core/world-seed.js'))['ensureWorld'];
let currentGameDay: (typeof import('../src/core/world-store.js'))['currentGameDay'];
let listFactions: (typeof import('../src/core/world-store.js'))['listFactions'];
let listAgendas: (typeof import('../src/core/world-store.js'))['listAgendas'];
let updateAgenda: (typeof import('../src/core/world-store.js'))['updateAgenda'];
let insertAgenda: (typeof import('../src/core/world-store.js'))['insertAgenda'];
let insertFaction: (typeof import('../src/core/world-store.js'))['insertFaction'];
let updateFaction: (typeof import('../src/core/world-store.js'))['updateFaction'];
let upsertEntity: (typeof import('../src/core/codex.js'))['upsertEntity'];
let addAttitude: (typeof import('../src/core/world-memory.js'))['addAttitude'];
let addRumour: (typeof import('../src/core/story.js'))['addRumour'];

beforeAll(async () => {
  // Match the region-map route test's reset for consistency: the server is imported fresh after a reset.
  vi.resetModules();
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ importRegion, findPlace } = await import('../src/core/region.js'));
  ({ ensureWorld } = await import('../src/core/world-seed.js'));
  ({ currentGameDay, listFactions, listAgendas, updateAgenda, insertAgenda, insertFaction, updateFaction } =
    await import('../src/core/world-store.js'));
  ({ upsertEntity } = await import('../src/core/codex.js'));
  ({ addAttitude } = await import('../src/core/world-memory.js'));
  ({ addRumour } = await import('../src/core/story.js'));
  const { openDb } = await import('../src/db/connection.js');
  const { HOST, startHttpServer } = await import('../src/transport/http.js');
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'worldroute0123456789abcdef0123' });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

function newCampaign(name = 'World Route Campaign'): number {
  return createCampaign(db, { name, story_shape: 'sandbox' }).campaign_id;
}

function worldCampaign(realm: unknown = safe): number {
  const id = newCampaign();
  importRegion(db, id, realm, { source: 'generated' });
  ensureWorld(db, id);
  return id;
}

function getWorld(campaignId: number | string): Promise<Response> {
  return fetch(`${base}/api/campaigns/${campaignId}/world`);
}

function heardWorldRumour(campaignId: number, text: string, scope: 'world' | 'location' = 'world'): number {
  const rumour = addRumour(db, { campaign_id: campaignId, text, scope, truth: 'false', source_kind: 'world' });
  db.prepare('UPDATE rumour SET heard_at = ? WHERE id = ?').run(new Date().toISOString(), rumour.id);
  return rumour.id;
}

/** Row counts across every world table and the rumour table, to prove a read wrote nothing. */
function counts(): Record<string, number> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'world_%' OR name = 'rumour')")
    .all() as Array<{ name: string }>;
  const out: Record<string, number> = {};
  for (const { name } of tables) {
    out[name] = (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n;
  }
  return out;
}

describe('GET /api/campaigns/:id/world', () => {
  it('400s a non-integer id', async () => {
    const res = await getWorld('abc');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad id' });
  });

  it('404s an unknown campaign', async () => {
    const res = await getWorld(999999);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such campaign' });
  });

  it('answers null before the campaign has a world, without creating one', async () => {
    const withRegion = newCampaign();
    importRegion(db, withRegion, safe, { source: 'generated' });

    const res = await getWorld(withRegion);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ world: null });

    const state = db.prepare('SELECT COUNT(*) AS n FROM world_state WHERE campaign_id = ?').get(withRegion) as {
      n: number;
    };
    expect(state.n).toBe(0);

    const noRegion = await getWorld(newCampaign());
    expect(await noRegion.json()).toEqual({ world: null });
  });
});

describe('GET /api/campaigns/:id/world with a world', () => {
  it('lists only heard world news, never its truth', async () => {
    const id = worldCampaign();
    const heardId = heardWorldRumour(id, 'The bridge at Redham is out.', 'location');
    addRumour(db, { campaign_id: id, text: 'A whisper nobody heard.', scope: 'world', source_kind: 'world' });
    const gossip = addRumour(db, { campaign_id: id, text: 'Tavern gossip.', scope: 'world', source_kind: 'tavern' });
    db.prepare('UPDATE rumour SET heard_at = ? WHERE id = ?').run(new Date().toISOString(), gossip.id);

    const res = await getWorld(id);
    const text = await res.text();
    const { world } = JSON.parse(text) as { world: { news: Array<{ id: number; text: string; local: boolean }> } };
    expect(world.news).toEqual([{ id: heardId, text: 'The bridge at Redham is out.', local: true }]);
    expect(text).not.toContain('truth');
    expect(text).not.toContain('A whisper nobody heard.');
    expect(text).not.toContain('Tavern gossip.');
  });

  it('shows only known agendas, with the signs the party heard', async () => {
    const id = worldCampaign();
    const agendas = listAgendas(db, id);
    const known = agendas[1]!;

    const before = await getWorld(id);
    const beforeBody = (await before.json()) as { world: { clocks: Array<{ id: number }> } };
    expect(beforeBody.world.clocks).toEqual([]);

    updateAgenda(db, id, known.id, {
      known_to_party: true,
      portents: [
        { text: 'Smoke on the ridge.', fired_day: currentGameDay(db, id), heard: true },
        { text: 'A secret nobody heard.', fired_day: currentGameDay(db, id), heard: false },
      ],
    });

    const res = await getWorld(id);
    const text = await res.text();
    const { world } = JSON.parse(text) as {
      world: {
        clocks: Array<{ id: number; faction: string; goal: string; filled: number; size: number; signs: string[] }>;
      };
    };
    expect(world.clocks.map((clock) => clock.id)).toEqual([known.id]);
    const clock = world.clocks[0]!;
    expect(clock.signs).toEqual(['Smoke on the ridge.']);
    expect(clock.filled).toBe(known.clock_filled);
    expect(clock.size).toBe(known.clock_size);
    expect(clock.faction.length).toBeGreaterThan(0);
    expect(clock.goal).toContain(':');
    expect(text).not.toContain('A secret nobody heard.');
  });

  it('never leaks a danger name from a monster faction or a danger target', async () => {
    const id = worldCampaign(dangerous);
    const factions = listFactions(db, id);
    const agendas = listAgendas(db, id);
    const monster = factions.find((faction) => faction.type === 'monsters')!;
    const monsterAgenda = agendas.find((agenda) => agenda.faction_id === monster.id)!;
    updateAgenda(db, id, monsterAgenda.id, {
      known_to_party: true,
      portents: monsterAgenda.portents.map((portent, index) => ({ ...portent, heard: index === 0 })),
    });

    const home = factions.find((faction) => faction.type !== 'monsters')!;
    const danger = findPlace(db, id, 'Hidden Keep')!;
    insertAgenda(db, id, {
      faction_id: home.id,
      template: 'hunt_monster',
      target_kind: 'danger',
      target_id: danger.id,
      target_name: danger.name,
      clock_size: 6,
      clock_filled: 2,
      portents: [{ text: 'Hunters ask after the beast.', fired_day: currentGameDay(db, id), heard: true }],
      status: 'active',
      known_to_party: true,
      started_day: currentGameDay(db, id),
    });

    const res = await getWorld(id);
    const text = await res.text();
    const { world } = JSON.parse(text) as { world: { clocks: Array<{ faction: string; goal: string }> } };
    expect(world.clocks.some((clock) => clock.faction === 'A monstrous brood')).toBe(true);
    expect(text).not.toContain('The Brood of');
    expect(text).not.toContain('Hidden Keep');
    expect(text).not.toContain('Ziggurat');
  });

  it('lists how factions regard the party, with the reason', async () => {
    const id = worldCampaign();
    const faction = listFactions(db, id).find((entry) => entry.secrecy !== 'secret')!;
    addAttitude(
      db,
      id,
      { kind: 'faction', id: faction.id },
      { value: 3, reason: 'Saved their caravan', day: currentGameDay(db, id) },
    );

    const res = await getWorld(id);
    const { world } = (await res.json()) as {
      world: {
        regard: Array<{
          id: number;
          faction: string;
          value: number;
          reasons: Array<{ reason: string; value: number }>;
        }>;
      };
    };
    // The regard shape gained the faction's id, so this assertion pins the new shape.
    expect(world.regard).toContainEqual({
      id: faction.id,
      faction: faction.name,
      value: 3,
      reasons: [{ reason: 'Saved their caravan', value: 3 }],
      emblem: null,
    });
  });

  it('returns a linked faction emblem in regard and in its known clock', async () => {
    const id = worldCampaign();
    const agenda = listAgendas(db, id)[1]!;
    const faction = listFactions(db, id).find((entry) => entry.id === agenda.faction_id)!;
    const entity = upsertEntity(db, { campaign_id: id, kind: 'faction', name: 'House Emblem' }).entity;
    db.prepare('UPDATE entity SET portrait_path = ? WHERE id = ?').run(
      '/portraits/1/house-ab12cd34.png',
      entity.id,
    );
    updateFaction(db, id, faction.id, { entity_id: entity.id });
    updateAgenda(db, id, agenda.id, { known_to_party: true });
    addAttitude(
      db,
      id,
      { kind: 'faction', id: faction.id },
      { value: 2, reason: 'Wear their colours', day: currentGameDay(db, id) },
    );

    const res = await getWorld(id);
    const { world } = (await res.json()) as {
      world: {
        clocks: Array<{ id: number; emblem: string | null }>;
        regard: Array<{ id: number; emblem: string | null }>;
      };
    };
    expect(world.clocks.find((clock) => clock.id === agenda.id)?.emblem).toBe('/portraits/1/house-ab12cd34.png');
    expect(world.regard.find((entry) => entry.id === faction.id)?.emblem).toBe('/portraits/1/house-ab12cd34.png');
  });

  it('returns a null emblem for an unlinked faction and for a linked entity without a portrait', async () => {
    const id = worldCampaign();
    const agendas = listAgendas(db, id);
    const unlinked = listFactions(db, id).find((entry) => entry.id === agendas[0]!.faction_id)!;
    const linked = listFactions(db, id).find((entry) => entry.id === agendas[1]!.faction_id)!;
    const bare = upsertEntity(db, { campaign_id: id, kind: 'faction', name: 'Bare Banner' }).entity;
    updateFaction(db, id, linked.id, { entity_id: bare.id });
    updateAgenda(db, id, agendas[0]!.id, { known_to_party: true });
    updateAgenda(db, id, agendas[1]!.id, { known_to_party: true });
    addAttitude(
      db,
      id,
      { kind: 'faction', id: unlinked.id },
      { value: 1, reason: 'Sent a polite letter', day: currentGameDay(db, id) },
    );
    addAttitude(
      db,
      id,
      { kind: 'faction', id: linked.id },
      { value: 1, reason: 'Sent a polite letter', day: currentGameDay(db, id) },
    );

    const res = await getWorld(id);
    const { world } = (await res.json()) as {
      world: {
        clocks: Array<{ id: number; emblem: string | null }>;
        regard: Array<{ id: number; emblem: string | null }>;
      };
    };
    expect(world.regard.find((entry) => entry.id === unlinked.id)?.emblem).toBeNull();
    expect(world.regard.find((entry) => entry.id === linked.id)?.emblem).toBeNull();
    expect(world.clocks.find((clock) => clock.id === agendas[0]!.id)?.emblem).toBeNull();
    expect(world.clocks.find((clock) => clock.id === agendas[1]!.id)?.emblem).toBeNull();
  });

  it('keeps a secret faction out of the regard list', async () => {
    const id = worldCampaign();
    const secret = insertFaction(db, id, {
      name: 'The Unseen Hand',
      type: 'gang',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'secret',
      resources: 1,
      capacities: {},
      created_day: currentGameDay(db, id),
    });
    addAttitude(
      db,
      id,
      { kind: 'faction', id: secret.id },
      { value: 4, reason: 'Owe them a debt', day: currentGameDay(db, id) },
    );

    const res = await getWorld(id);
    const { world } = (await res.json()) as { world: { regard: Array<{ faction: string }> } };
    expect(world.regard.some((entry) => entry.faction === 'The Unseen Hand')).toBe(false);
  });

  it('names each brood after the nearest settlement and keeps DM reasons out of regard', async () => {
    const id = worldCampaign(dangerous);
    const monsters = listFactions(db, id).filter((faction) => faction.type === 'monsters');
    expect(monsters).toHaveLength(2);
    for (const monster of monsters) {
      addAttitude(
        db,
        id,
        { kind: 'faction', id: monster.id },
        { value: 2, reason: 'Drove off their hunters', day: currentGameDay(db, id) },
      );
    }

    const res = await getWorld(id);
    const text = await res.text();
    const { world } = JSON.parse(text) as {
      world: { regard: Array<{ id: number; faction: string; value: number; reasons: unknown[] }> };
    };
    const broods = world.regard.filter((entry) => monsters.some((monster) => monster.id === entry.id));
    expect(broods).toHaveLength(2);
    expect(new Set(broods.map((brood) => brood.id)).size).toBe(2);
    expect(new Set(broods.map((brood) => brood.faction)).size).toBe(2);
    for (const brood of broods) {
      expect(brood.faction).toMatch(/^The brood near .+$/);
      expect(brood.reasons).toEqual([]);
    }
    expect(text).not.toContain('Drove off their hunters');
  });

  it("keeps a secret faction's clock off the board", async () => {
    const id = worldCampaign();
    const secret = insertFaction(db, id, {
      name: 'The Unseen Hand',
      type: 'gang',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'secret',
      resources: 1,
      capacities: {},
      created_day: currentGameDay(db, id),
    });
    const target = findPlace(db, id, 'Redham')!;
    const agenda = insertAgenda(db, id, {
      faction_id: secret.id,
      template: 'raid',
      target_kind: 'settlement',
      target_id: target.id,
      target_name: target.name,
      clock_size: 4,
      clock_filled: 1,
      portents: [{ text: 'Smoke on the road.', fired_day: currentGameDay(db, id), heard: true }],
      status: 'active',
      known_to_party: true,
      started_day: currentGameDay(db, id),
    });

    const res = await getWorld(id);
    const text = await res.text();
    const { world } = JSON.parse(text) as { world: { clocks: Array<{ id: number }> } };
    expect(world.clocks.some((clock) => clock.id === agenda.id)).toBe(false);
    expect(text).not.toContain('The Unseen Hand');
  });

  it('hides a secret rival behind "a hidden rival" in a known feud', async () => {
    const id = worldCampaign();
    const owner = listFactions(db, id).find((faction) => faction.type === 'house')!;
    const secret = insertFaction(db, id, {
      name: 'The Unseen Hand',
      type: 'gang',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'secret',
      resources: 1,
      capacities: {},
      created_day: currentGameDay(db, id),
    });
    insertAgenda(db, id, {
      faction_id: owner.id,
      template: 'feud',
      target_kind: 'rival_faction',
      target_id: secret.id,
      target_name: secret.name,
      clock_size: 6,
      clock_filled: 2,
      portents: [{ text: 'A duel ends in blood.', fired_day: currentGameDay(db, id), heard: true }],
      status: 'active',
      known_to_party: true,
      started_day: currentGameDay(db, id),
    });

    const res = await getWorld(id);
    const text = await res.text();
    const { world } = JSON.parse(text) as { world: { clocks: Array<{ goal: string }> } };
    const feud = world.clocks.find((clock) => clock.goal.startsWith('Open feud'));
    expect(feud?.goal).toBe('Open feud: a hidden rival');
    expect(text).not.toContain('The Unseen Hand');
  });

  it('reads without writing anything', async () => {
    const id = worldCampaign();
    const agenda = listAgendas(db, id)[0]!;
    updateAgenda(db, id, agenda.id, { known_to_party: true });
    const faction = listFactions(db, id)[0]!;
    addAttitude(
      db,
      id,
      { kind: 'faction', id: faction.id },
      { value: -2, reason: 'Ran them out of town', day: currentGameDay(db, id) },
    );
    heardWorldRumour(id, 'A bridge is out.');

    const before = counts();
    await getWorld(id);
    expect(counts()).toEqual(before);
  });
});
