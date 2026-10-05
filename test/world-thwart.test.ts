// The party's hand in the living world: setbacks, thwarted agendas, destroyed factions and cleared lairs,
// with refusals that write nothing and news that never names a danger site or a secret faction.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';
import type { WorldPlace } from '../src/core/region.js';
import type { WorldAgenda, WorldFaction } from '../src/core/world-store.js';

const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

const DAY = 400;

let db: Db;
let base: string;
let stop: () => Promise<void>;
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let upsertEntity: (typeof import('../src/core/codex.js'))['upsertEntity'];
let ensureFactionEntity: (typeof import('../src/core/world-codex.js'))['ensureFactionEntity'];
let deliverNews: (typeof import('../src/core/world-news.js'))['deliverNews'];
let store: typeof import('../src/core/world-store.js');
let thwart: typeof import('../src/core/world-thwart.js');

beforeAll(async () => {
  // With isolate: false an earlier file may have cached these modules, so import them fresh here.
  vi.resetModules();
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ importRegion } = await import('../src/core/region.js'));
  ({ upsertEntity } = await import('../src/core/codex.js'));
  ({ ensureFactionEntity } = await import('../src/core/world-codex.js'));
  ({ deliverNews } = await import('../src/core/world-news.js'));
  store = await import('../src/core/world-store.js');
  thwart = await import('../src/core/world-thwart.js');
  const { openDb } = await import('../src/db/connection.js');
  const { HOST, startHttpServer } = await import('../src/transport/http.js');
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'worldthwart0123456789abcdef0123' });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

interface Region {
  id: number;
  settlements: WorldPlace[];
  dangers: WorldPlace[];
}

function withRegion(): Region {
  const id = createCampaign(db, { name: 'Thwart Campaign', story_shape: 'structured' }).campaign_id;
  const view = importRegion(db, id, dangerous, { source: 'generated' });
  return {
    id,
    settlements: view.places.filter((place) => place.kind === 'settlement'),
    dangers: view.places.filter((place) => place.kind === 'danger'),
  };
}

let factionCount = 0;

function faction(campaignId: number, extra: Partial<Omit<WorldFaction, 'id'>> = {}): WorldFaction {
  factionCount += 1;
  return store.insertFaction(db, campaignId, {
    name: `Test Faction ${factionCount}`,
    type: 'house',
    realm_id: null,
    county_id: null,
    place_id: null,
    secrecy: 'open',
    resources: 3,
    capacities: {},
    created_day: DAY - 100,
    ...extra,
  });
}

function agenda(campaignId: number, f: WorldFaction, extra: Partial<Omit<WorldAgenda, 'id'>> = {}): WorldAgenda {
  return store.insertAgenda(db, campaignId, {
    faction_id: f.id,
    template: 'raid',
    target_kind: 'settlement',
    target_id: f.place_id,
    target_name: 'the target',
    clock_size: 6,
    clock_filled: 3,
    portents: [{ text: 'Smoke rises on the hills.', fired_day: null, heard: false }],
    status: 'active',
    started_day: DAY - 50,
    ...extra,
  });
}

function storedAgenda(campaignId: number, id: number): WorldAgenda {
  return store.listAgendas(db, campaignId).find((entry) => entry.id === id)!;
}

function storedFaction(campaignId: number, id: number): WorldFaction {
  return store.listFactions(db, campaignId, { includeEnded: true }).find((entry) => entry.id === id)!;
}

function packetCount(eventId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM world_packet WHERE event_id = ?').get(eventId) as { n: number }).n;
}

describe('setbackAgenda', () => {
  it('lowers the clock, puts a held agenda back in play and records the news', () => {
    const { id, settlements } = withRegion();
    const house = faction(id, { place_id: settlements[0]!.id });
    const held = agenda(id, house, { clock_filled: 6, status: 'held' });

    const reason = 'The party burned the siege engines';
    const { agenda: updated, event } = thwart.setbackAgenda(db, id, held.id, 2, reason, DAY);

    expect(updated.clock_filled).toBe(4);
    expect(updated.status).toBe('active');
    expect(storedAgenda(id, held.id)).toMatchObject({ clock_filled: 4, status: 'active', resolved_day: null });
    expect(event).toMatchObject({
      day: DAY,
      kind: 'agenda_setback',
      severity: 2,
      faction_id: house.id,
      agenda_id: held.id,
      visibility: 'public',
      effects: { reason: 'The party burned the siege engines', clock_from: 6, clock_to: 4 },
    });
    expect(packetCount(event.id)).toBe(1);
  });

  it('never lowers a clock below zero', () => {
    const { id, settlements } = withRegion();
    const house = faction(id, { place_id: settlements[0]!.id });
    const early = agenda(id, house, { clock_filled: 1 });

    expect(thwart.setbackAgenda(db, id, early.id, 3, 'Scouts were caught', DAY).agenda.clock_filled).toBe(0);
  });
});

describe('thwartAgenda', () => {
  it('ends the agenda as lost, costs the faction a resource and records the news', () => {
    const { id, settlements } = withRegion();
    const house = faction(id, { place_id: settlements[0]!.id, resources: 3 });
    const plot = agenda(id, house);

    const result = thwart.thwartAgenda(db, id, plot.id, 'The party exposed the plot', DAY);

    expect(result.agenda).toMatchObject({ status: 'lost', resolved_day: DAY });
    expect(storedAgenda(id, plot.id)).toMatchObject({ status: 'lost', resolved_day: DAY });
    expect(result.faction.resources).toBe(2);
    expect(storedFaction(id, house.id).resources).toBe(2);
    expect(result.event).toMatchObject({
      day: DAY,
      kind: 'agenda_lost',
      severity: 3,
      faction_id: house.id,
      agenda_id: plot.id,
      effects: { reason: 'The party exposed the plot', resources: -1 },
    });
    expect(packetCount(result.event.id)).toBe(1);
    expect(store.listAgendas(db, id, { factionId: house.id, status: 'active' })).toEqual([]);
  });

  it('keeps a spent faction at zero resources', () => {
    const { id, settlements } = withRegion();
    const house = faction(id, { place_id: settlements[0]!.id, resources: 0 });

    const result = thwart.thwartAgenda(db, id, agenda(id, house).id, 'Its last coin was seized', DAY);

    expect(result.faction.resources).toBe(0);
    expect(result.event.effects).toMatchObject({ resources: 0 });
  });

  it('holds back a new agenda for 30 days after the latest thwart', () => {
    const { id, settlements } = withRegion();
    const house = faction(id, { place_id: settlements[0]!.id });
    expect(thwart.agendaCooldownUntil(db, id, house.id)).toBeNull();

    const first = thwart.thwartAgenda(db, id, agenda(id, house).id, 'Foiled once', DAY);
    const until = thwart.agendaCooldownUntil(db, id, house.id)!;

    expect(thwart.THWART_COOLDOWN_DAYS).toBe(30);
    expect(first.cooldown_until).toBe(DAY + 30);
    expect(until).toBe(DAY + 30);
    expect(until > DAY + 29).toBe(true);
    expect(until > DAY + 30).toBe(false);

    const later = agenda(id, house, { started_day: DAY + 40 });
    thwart.thwartAgenda(db, id, later.id, 'Foiled again', DAY + 45);
    expect(thwart.agendaCooldownUntil(db, id, house.id)).toBe(DAY + 75);
  });
});

describe('destroyFaction', () => {
  it('ends the faction, abandons the agendas it had in play and hides it from listFactions', () => {
    const { id, settlements } = withRegion();
    const house = faction(id, { place_id: settlements[0]!.id });
    const active = agenda(id, house);
    const held = agenda(id, house, { clock_filled: 6, status: 'held' });
    const won = agenda(id, house, { status: 'won' });

    const result = thwart.destroyFaction(db, id, house.id, 'The party toppled its lord', DAY);

    expect(result.faction.ended_day).toBe(DAY);
    expect(result.abandoned.map((entry) => entry.id)).toEqual([active.id, held.id]);
    expect(storedAgenda(id, active.id)).toMatchObject({ status: 'abandoned', resolved_day: DAY });
    expect(storedAgenda(id, held.id)).toMatchObject({ status: 'abandoned', resolved_day: DAY });
    expect(storedAgenda(id, won.id)).toMatchObject({ status: 'won', resolved_day: null });
    expect(store.listFactions(db, id).map((entry) => entry.id)).not.toContain(house.id);
    expect(store.listFactions(db, id, { includeEnded: true }).map((entry) => entry.id)).toContain(house.id);
    expect(result.event).toMatchObject({
      day: DAY,
      kind: 'faction_destroyed',
      severity: 4,
      faction_id: house.id,
      agenda_id: null,
      effects: { reason: 'The party toppled its lord', abandoned: [active.id, held.id] },
    });
    expect(packetCount(result.event.id)).toBe(1);
  });
});

describe('clearDanger', () => {
  it('destroys every brood lairing at the cleared danger and none elsewhere', () => {
    const { id, dangers } = withRegion();
    const [lair, other] = dangers;
    const first = faction(id, { type: 'monsters', place_id: lair!.id });
    const second = faction(id, { type: 'monsters', place_id: lair!.id });
    const elsewhere = faction(id, { type: 'monsters', place_id: other!.id });
    const raid = agenda(id, first);

    const results = thwart.clearDanger(db, id, lair!.id, DAY);

    expect(results.map((entry) => entry.faction.id)).toEqual([first.id, second.id]);
    expect(storedFaction(id, first.id).ended_day).toBe(DAY);
    expect(storedFaction(id, second.id).ended_day).toBe(DAY);
    expect(storedFaction(id, elsewhere.id).ended_day).toBeNull();
    expect(storedAgenda(id, raid.id).status).toBe('abandoned');
    expect(results.every((entry) => entry.event.severity === 3)).toBe(true);
    expect(results[0]!.event.effects).toMatchObject({ reason: 'its lair was cleared' });
  });

  it('answers an empty list for a danger with no brood left', () => {
    const { id, dangers } = withRegion();
    expect(thwart.clearDanger(db, id, dangers[0]!.id, DAY)).toEqual([]);
  });
});

describe('refusals', () => {
  const TABLES = ['world_faction', 'world_agenda', 'world_event', 'world_packet', 'world_packet_arrival'];
  const snapshot = (): string =>
    JSON.stringify(TABLES.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));

  it('refuse bad ids, amounts, reasons and finished agendas without writing anything', () => {
    const { id, settlements, dangers } = withRegion();
    const other = withRegion();
    const house = faction(id, { place_id: settlements[0]!.id });
    const plot = agenda(id, house);
    const won = agenda(id, house, { status: 'won' });
    const ended = faction(id, { ended_day: DAY - 10 });
    const foreign = faction(other.id, { place_id: other.settlements[0]!.id });
    const foreignPlot = agenda(other.id, foreign);

    const before = snapshot();
    const refusals: Array<[() => unknown, RegExp]> = [
      [() => thwart.setbackAgenda(db, id, 999999, 1, 'why', DAY), /No agenda 999999/],
      [() => thwart.setbackAgenda(db, id, foreignPlot.id, 1, 'why', DAY), /No agenda/],
      [() => thwart.setbackAgenda(db, id, plot.id, 0, 'why', DAY), /1, 2 or 3/],
      [() => thwart.setbackAgenda(db, id, plot.id, 4, 'why', DAY), /1, 2 or 3/],
      [() => thwart.setbackAgenda(db, id, plot.id, 1.5, 'why', DAY), /1, 2 or 3/],
      [() => thwart.setbackAgenda(db, id, plot.id, 1, '   ', DAY), /reason/],
      [() => thwart.setbackAgenda(db, id, won.id, 1, 'why', DAY), /already won/],
      [() => thwart.thwartAgenda(db, id, 999999, 'why', DAY), /No agenda 999999/],
      [() => thwart.thwartAgenda(db, id, foreignPlot.id, 'why', DAY), /No agenda/],
      [() => thwart.thwartAgenda(db, id, won.id, 'why', DAY), /already won/],
      [() => thwart.thwartAgenda(db, id, plot.id, '', DAY), /reason/],
      [() => thwart.destroyFaction(db, id, 999999, 'why', DAY), /No faction 999999/],
      [() => thwart.destroyFaction(db, id, foreign.id, 'why', DAY), /No faction/],
      [() => thwart.destroyFaction(db, id, ended.id, 'why', DAY), /already ended/],
      [() => thwart.destroyFaction(db, id, house.id, ' ', DAY), /reason/],
      [() => thwart.clearDanger(db, id, settlements[0]!.id, DAY), /No danger site/],
      [() => thwart.clearDanger(db, id, other.dangers[0]!.id, DAY), /No danger site/],
      [() => thwart.clearDanger(db, id, 999999, DAY), /No danger site/],
    ];
    for (const [act, message] of refusals) expect(act).toThrow(message);

    expect(snapshot()).toBe(before);
    expect(dangers.length).toBeGreaterThan(0);
  });

  it('refuse a lost agenda, so a thwart cannot be repeated', () => {
    const { id, settlements } = withRegion();
    const house = faction(id, { place_id: settlements[0]!.id });
    const plot = agenda(id, house);
    thwart.thwartAgenda(db, id, plot.id, 'Foiled', DAY);

    const before = snapshot();
    expect(() => thwart.thwartAgenda(db, id, plot.id, 'Foiled twice', DAY)).toThrow(/already lost/);
    expect(() => thwart.setbackAgenda(db, id, plot.id, 1, 'Late', DAY)).toThrow(/already lost/);
    expect(snapshot()).toBe(before);
  });
});

describe('what the player hears', () => {
  async function timelineTexts(campaignId: number, entityId: number): Promise<string[]> {
    const res = await fetch(`${base}/api/campaigns/${campaignId}/entities/${entityId}/timeline`);
    expect(res.status).toBe(200);
    const { timeline } = (await res.json()) as { timeline: Array<{ text: string }> };
    return timeline.map((entry) => entry.text);
  }

  it('never names a danger site or a secret faction', async () => {
    const { id, settlements, dangers } = withRegion();
    const [lair, den] = dangers;
    const town = settlements[0]!;

    const brood = faction(id, { name: `The Brood of ${lair!.name}`, type: 'monsters', place_id: lair!.id });
    const broodRaid = agenda(id, brood, { target_id: town.id, target_name: town.name });
    const hidden = faction(id, { name: 'The Ashen Hand', type: 'gang', secrecy: 'secret', place_id: town.id });
    const hiddenPlot = agenda(id, hidden, { target_id: town.id, target_name: town.name });
    const hunters = faction(id, { name: 'House of the Hunt', place_id: town.id });
    const hunt = agenda(id, hunters, {
      template: 'hunt_monster',
      target_kind: 'danger',
      target_id: den!.id,
      target_name: den!.name,
    });
    const rivals = faction(id, { name: 'House of the Feud', place_id: town.id });
    const feud = agenda(id, rivals, {
      template: 'feud',
      target_kind: 'rival_faction',
      target_id: hidden.id,
      target_name: hidden.name,
    });

    thwart.setbackAgenda(db, id, hunt.id, 1, `Cleared the path to ${den!.name}`, DAY);
    thwart.thwartAgenda(db, id, hunt.id, `Warned the beast at ${den!.name}`, DAY);
    thwart.setbackAgenda(db, id, feud.id, 2, 'Brokered a truce', DAY);
    thwart.thwartAgenda(db, id, feud.id, 'Married the heirs', DAY);
    thwart.setbackAgenda(db, id, hiddenPlot.id, 1, 'Caught a courier', DAY);
    thwart.thwartAgenda(db, id, broodRaid.id, 'Held the walls', DAY);
    thwart.destroyFaction(db, id, hidden.id, 'Hanged its masters', DAY);
    thwart.clearDanger(db, id, lair!.id, DAY);

    // The DM's ledger keeps the real names; only what travels as news is checked below.
    const ledger = store.listEvents(db, id).map((event) => event.text);
    expect(ledger.some((text) => text.includes('The Ashen Hand'))).toBe(true);

    const rumours = settlements.flatMap((place) =>
      deliverNews(db, id, place.id, DAY + 60).map((entry) => entry.text),
    );

    const broodEntity = ensureFactionEntity(db, id, storedFaction(id, brood.id))!;
    const huntersEntity = ensureFactionEntity(db, id, storedFaction(id, hunters.id))!;
    const rivalsEntity = ensureFactionEntity(db, id, storedFaction(id, rivals.id))!;
    expect(ensureFactionEntity(db, id, storedFaction(id, hidden.id))).toBeNull();
    // Even a codex entry named after the secret faction must show none of its deeds.
    const hiddenEntity = upsertEntity(db, { campaign_id: id, kind: 'faction', name: hidden.name }).entity.id;
    const lairEntity = upsertEntity(db, { campaign_id: id, kind: 'place', name: 'A dark hollow' }).entity.id;
    db.prepare('UPDATE world_place SET entity_id = ? WHERE id = ?').run(lairEntity, lair!.id);
    const denEntity = upsertEntity(db, { campaign_id: id, kind: 'place', name: 'A cold cave' }).entity.id;
    db.prepare('UPDATE world_place SET entity_id = ? WHERE id = ?').run(denEntity, den!.id);

    const broodTimeline = await timelineTexts(id, broodEntity);
    const timelines = [
      ...broodTimeline,
      ...(await timelineTexts(id, huntersEntity)),
      ...(await timelineTexts(id, rivalsEntity)),
      ...(await timelineTexts(id, lairEntity)),
      ...(await timelineTexts(id, denEntity)),
    ];
    expect(await timelineTexts(id, hiddenEntity)).toEqual([]);

    const heard = [...rumours, ...timelines];
    expect(timelines.length).toBeGreaterThan(0);
    expect(broodTimeline).toContainEqual(expect.stringMatching(/^A monstrous brood near .+ is wiped out\.$/));
    expect(heard).toContainEqual(expect.stringContaining('a hidden rival'));
    for (const text of heard) {
      for (const danger of dangers) expect(text).not.toContain(danger.name);
      expect(text).not.toContain(hidden.name);
    }
  });
});
