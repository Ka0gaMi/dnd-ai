// The world and region replies carry, in their text alone, the ids and facts the DM needs for a follow-up
// call; each id read from a reply is fed back into the call that needs it.
import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { upsertEntity } from '../src/core/codex.js';
import { placeControl, placePolitics } from '../src/core/politics-service.js';
import { getPolitics } from '../src/core/politics-store.js';
import { findPlace, getRegion, importRegion, type WorldPlace } from '../src/core/region.js';
import { estimateTokens, WORLD_GET } from '../src/core/token-budget.js';
import { listFaiths } from '../src/core/world-faith-store.js';
import { ensureWorld } from '../src/core/world-seed.js';
import {
  currentGameDay,
  insertAgenda,
  insertFaction,
  listEvents,
  type Portent,
  type WorldAgenda,
  type WorldFaction,
} from '../src/core/world-store.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { replyText } from './helpers/reply.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown;

let db: Db;
let client: Client;

beforeEach(async () => {
  db = openDb(':memory:');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'world-render-gaps', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
});

/** Calls a tool and returns its reply text, failing on an error reply. */
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, replyText(result)).toBeFalsy();
  return replyText(result);
}

/** Imports a fixture map; with seed, the living world is created up front so the tools add no factions later. */
function campaignWith(map: string, seed = false): number {
  const id = createCampaign(db, { name: `Render ${map}`, story_shape: 'sandbox' }).campaign_id;
  importRegion(db, id, fixture(map), { source: 'generated' });
  if (seed) ensureWorld(db, id);
  return id;
}

const places = (campaignId: number, kind: WorldPlace['kind']): WorldPlace[] =>
  getRegion(db, campaignId)!.places.filter((place) => place.kind === kind);

let seq = 0;

function faction(campaignId: number, extra: Partial<Omit<WorldFaction, 'id'>> = {}): WorldFaction {
  seq += 1;
  return insertFaction(db, campaignId, {
    name: `Gap Faction ${seq}`,
    type: 'house',
    realm_id: null,
    county_id: null,
    place_id: null,
    secrecy: 'open',
    resources: 3,
    capacities: {},
    created_day: currentGameDay(db, campaignId),
    ...extra,
  });
}

function agenda(campaignId: number, owner: WorldFaction, extra: Partial<Omit<WorldAgenda, 'id'>> = {}): WorldAgenda {
  return insertAgenda(db, campaignId, {
    faction_id: owner.id,
    template: 'raid',
    target_kind: 'settlement',
    target_id: owner.place_id,
    target_name: 'the target',
    clock_size: 6,
    clock_filled: 3,
    portents: [{ text: 'Smoke rises on the hills.', fired_day: null, heard: false }],
    status: 'active',
    started_day: currentGameDay(db, campaignId),
    ...extra,
  });
}

/** The single line of a text starting with prefix. */
function lineOf(text: string, prefix: string): string {
  const lines = text.split('\n').filter((line) => line.startsWith(prefix));
  expect(lines, `one "${prefix}" line in:\n${text}`).toHaveLength(1);
  return lines[0]!;
}

/** The item lines under a section title, up to the first line that is not an item. */
function section(text: string, title: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf(title);
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && !line.startsWith('- '));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

describe('world replies', () => {
  it('get lists each faith with its aspect and id, within WORLD_GET', async () => {
    const id = campaignWith('realm-large', true);
    const text = await call('world', { campaign_id: id, op: 'get' });
    expect(estimateTokens(text)).toBeLessThanOrEqual(WORLD_GET);

    const shown = section(text, 'Faiths:').map((line) => {
      const match = /^- (.+) \(fervor \d+, head .+?, aspect (\w+), #(\d+)\): /.exec(line);
      expect(match, line).not.toBeNull();
      return { name: match![1], aspect: match![2], id: Number(match![3]) };
    });
    expect(shown.length).toBeGreaterThan(0);
    const stored = listFaiths(db, id).map((faith) => ({ name: faith.name, aspect: faith.aspect, id: faith.id }));
    for (const faith of shown) expect(stored).toContainEqual(faith);
  });

  it('deed names each subject by kind and id with the place and realm, and the ids resolve in later calls', async () => {
    const id = campaignWith('realm-dangerous', true);
    const town = places(id, 'settlement')[0]!;
    const patron = faction(id, { place_id: town.id });
    const rival = faction(id, { place_id: town.id });
    agenda(id, patron, { template: 'trade_monopoly', target_kind: 'rival_faction', target_id: rival.id, target_name: rival.name });

    const text = await call('world', {
      campaign_id: id,
      op: 'deed',
      target: patron.name,
      value: 3,
      reason: 'saved their caravan',
      place: town.name,
    });
    const realm = placePolitics(db, id, town).realm!;
    expect(lineOf(text, 'Ids: ')).toBe(
      `Ids: faction #${patron.id} ${patron.name}, faction #${rival.id} ${rival.name}; place #${town.id}; realm #${realm.id}.`,
    );

    // The rival's id from the text opens it, showing the half-strength grudge.
    const rivalId = Number(new RegExp(`faction #(\\d+) ${rival.name}`).exec(text)![1]);
    const rivalView = await call('world', { campaign_id: id, op: 'get', faction: rivalId });
    expect(rivalView.split('\n')[1]).toMatch(new RegExp(`^#${rival.id} ${rival.name} \\(`));
    expect(rivalView).toContain('Regards the party: neutral (-1)');
    const placeId = Number(/; place #(\d+);/.exec(text)![1]);
    expect((await call('region', { campaign_id: id, op: 'get', place: placeId })).startsWith(`${town.name} (`)).toBe(true);

    upsertEntity(db, { campaign_id: id, kind: 'item', name: 'The Silver Locket' });
    const entityText = await call('world', {
      campaign_id: id,
      op: 'deed',
      target: 'The Silver Locket',
      value: 2,
      reason: 'returned it',
    });
    const entityId = Number(/^Ids: entity #(\d+) The Silver Locket\.$/m.exec(entityText)![1]);
    expect(await call('entity', { campaign_id: id, op: 'get', id: entityId })).toContain('The Silver Locket');
  });

  it('reveal lists the fired portents with their day and whether they were heard', async () => {
    const id = campaignWith('realm-dangerous', true);
    const today = currentGameDay(db, id);
    const owner = faction(id, { place_id: places(id, 'settlement')[0]!.id });
    const portents: Portent[] = [
      { text: 'Ledgers vanish from the guildhall.', fired_day: today - 3, heard: true },
      { text: 'A clerk is found in the harbour.', fired_day: today, heard: false },
      { text: 'The warehouses burn.', fired_day: null, heard: false },
    ];
    const plot = agenda(id, owner, { portents });

    const text = await call('world', { campaign_id: id, op: 'reveal', agenda: plot.id });
    expect(text.split('\n').slice(0, 4)).toEqual([
      `${owner.name}'s raid against the target is now known to the party (clock 3/6).`,
      'Fired portents:',
      `- day ${today - 3} (heard): Ledgers vanish from the guildhall.`,
      `- day ${today} (unheard): A clerk is found in the harbour.`,
    ]);
    expect(text).not.toContain('The warehouses burn.');

    const quiet = agenda(id, owner);
    expect(await call('world', { campaign_id: id, op: 'reveal', agenda: quiet.id })).toContain('\nNo portent has fired yet.');
  });

  it('setback and thwart give the world event, and thwart the resources left under an id world get resolves', async () => {
    const id = campaignWith('realm-dangerous', true);
    const today = currentGameDay(db, id);
    const owner = faction(id, { place_id: places(id, 'settlement')[0]!.id, resources: 3 });
    const plot = agenda(id, owner);
    const eventText = (kind: string): string =>
      listEvents(db, id, { fromDay: today }).find((event) => event.agenda_id === plot.id && event.kind === kind)!.text;

    const setback = await call('world', { campaign_id: id, op: 'setback', agenda: plot.id, amount: 1, reason: 'burned the engines' });
    expect(lineOf(setback, 'World event ')).toBe(`World event (day ${today}): ${eventText('agenda_setback')}`);
    expect(eventText('agenda_setback')).toContain('setback');

    const thwart = await call('world', { campaign_id: id, op: 'thwart', agenda: plot.id, reason: 'exposed the plot' });
    expect(lineOf(thwart, 'World event ')).toBe(`World event (day ${today}): ${eventText('agenda_lost')}`);
    const [, factionId, left] = new RegExp(`^${owner.name} \\(#(\\d+)\\) has (\\d+) resources left\\.$`, 'm').exec(thwart)!;
    expect(Number(left)).toBe(2);
    const view = await call('world', { campaign_id: id, op: 'get', faction: Number(factionId) });
    expect(view.split('\n')[1]).toContain(`#${owner.id} ${owner.name} (house, open, resources 2)`);
  });

  it('destroy names the abandoned agendas and the event, and a cleared lair each brood it ended', async () => {
    const id = campaignWith('realm-dangerous', true);
    const today = currentGameDay(db, id);
    const house = faction(id, { place_id: places(id, 'settlement')[0]!.id });
    const plots = [agenda(id, house), agenda(id, house)];

    const destroyed = await call('world', { campaign_id: id, op: 'destroy', target: house.name, reason: 'toppled its lord' });
    expect(destroyed.split('\n')[0]).toBe(
      `${house.name} is destroyed; 2 agenda(s) abandoned (${plots.map((plot) => `#${plot.id}`).join(', ')}).`,
    );
    const event = listEvents(db, id, { fromDay: today }).find((entry) => entry.kind === 'faction_destroyed' && entry.faction_id === house.id)!;
    expect(lineOf(destroyed, 'World event ')).toBe(`World event (day ${today}): ${event.text}`);
    // An abandoned id from the text is the one a setback now refuses as no longer in play.
    const abandonedId = Number(/abandoned \(#(\d+),/.exec(destroyed)![1]);
    const refused = await client.callTool({
      name: 'world',
      arguments: { campaign_id: id, op: 'setback', agenda: abandonedId, amount: 1, reason: 'too late' },
    });
    expect(refused.isError).toBe(true);
    expect(replyText(refused)).toContain(`Agenda ${plots[0]!.id} is already abandoned`);

    const lair = places(id, 'danger')[0]!;
    const broods = [
      faction(id, { name: 'Gap Brood Alpha', type: 'monsters', place_id: lair.id }),
      faction(id, { name: 'Gap Brood Beta', type: 'monsters', place_id: lair.id }),
    ];
    const cleared = await call('world', { campaign_id: id, op: 'destroy', target: lair.name });
    expect(cleared.split('\n')[0]).toBe(
      `${lair.name} is cleared; 2 brood(s) ended: #${broods[0]!.id} Gap Brood Alpha, #${broods[1]!.id} Gap Brood Beta.`,
    );
    const broodId = Number(/ended: #(\d+) Gap Brood Alpha/.exec(cleared)![1]);
    const brood = await call('world', { campaign_id: id, op: 'get', faction: broodId });
    expect(brood.split('\n')[1]).toMatch(new RegExp(`^#${broods[0]!.id} Gap Brood Alpha \\(.*\\[ended day ${today}\\]$`));
  });
});

describe('region replies', () => {
  it('get on the whole map gives place ids, county seats with their kind, and realm and duchy ids', async () => {
    const id = campaignWith('realm-large');
    const text = await call('region', { campaign_id: id, op: 'get' });
    const politics = getPolitics(db, id)!;
    expect(politics.duchies.length).toBeGreaterThan(0);

    for (const [title, kind] of [['Settlements:', 'settlement'], ['Areas:', 'area'], ['Dangers:', 'danger']] as const) {
      const lines = section(text, title);
      for (const place of places(id, kind)) {
        expect(lines.filter((line) => line.startsWith(`- #${place.id} ${place.name} (`)), place.name).toHaveLength(1);
      }
    }
    const nameOf = (placeId: number): string | undefined => findPlace(db, id, placeId)?.name;
    const seats = lineOf(text, 'County seats: ');
    for (const county of politics.counties) {
      expect(seats).toContain(`#${county.id} ${county.name} at ${nameOf(county.seat_place_id)} (${county.seat_kind})`);
    }
    const realms = lineOf(text, 'Realm ids: ');
    for (const realm of politics.realms) expect(realms).toContain(`#${realm.id} ${realm.name}`);
    const duchies = lineOf(text, 'Duchy ids: ');
    for (const duchy of politics.duchies) expect(duchies).toContain(`#${duchy.id} ${duchy.name}`);

    // A danger's id read off the map opens that danger.
    const [, dangerId, dangerName] = /^- #(\d+) (.+?) \(nearest /.exec(section(text, 'Dangers:')[0]!)!;
    expect((await call('region', { campaign_id: id, op: 'get', place: Number(dangerId) })).startsWith(`${dangerName} (danger #${dangerId})`)).toBe(true);
  });

  it('get on a place gives its id, politics ids, numeric control, the link beside the info and nearby ids', async () => {
    const id = campaignWith('realm-safe');
    const redham = findPlace(db, id, 'Redham')!;
    expect(redham.info).not.toBe('');
    expect(redham.link).not.toBeNull();
    const text = await call('region', { campaign_id: id, op: 'get', place: 'Redham' });
    const lines = text.split('\n');

    expect(lines[0]!.startsWith(`Redham (settlement #${redham.id}) - ${redham.info}`)).toBe(true);
    const held = placePolitics(db, id, redham);
    const control = placeControl(db, id, redham)!;
    expect(lineOf(text, 'Politics: ')).toBe(
      `Politics: county #${held.county!.id}, realm #${held.realm!.id} (capital ${held.realm!.capital}); control ${control.control}.`,
    );
    expect(lineOf(text, 'Link: ')).toBe(`Link: ${redham.link}`);

    // A neighbour's id read off the place opens that neighbour.
    const [, nearId, nearName] = /^Within 3 hexes: #(\d+) (.+?) \(/.exec(lineOf(text, 'Within 3 hexes: '))!;
    expect((await call('region', { campaign_id: id, op: 'get', place: Number(nearId) })).startsWith(`${nearName} (`)).toBe(true);
  });

  it('get on a place names its duchy and march by id', async () => {
    const id = campaignWith('realm-large');
    const marcher = places(id, 'settlement').find((place) => {
      const held = placePolitics(db, id, place);
      return held.duchy !== null && held.march;
    })!;
    expect(marcher).toBeDefined();
    const held = placePolitics(db, id, marcher);

    const text = await call('region', { campaign_id: id, op: 'get', place: marcher.id });
    const line = lineOf(text, 'Politics: ');
    expect(line).toContain(`county #${held.county!.id} (march), duchy #${held.duchy!.id} ${held.duchy!.name}, realm #${held.realm!.id} (`);
    expect(line).toMatch(new RegExp(`; control ${placeControl(db, id, marcher)!.control}\\.$`));
  });

  it('reveal gives the codex entity id and whether the entry is new, and the ids open the entries', async () => {
    const id = campaignWith('realm-safe');
    const first = await call('region', { campaign_id: id, op: 'reveal', place: 'Redham' });
    const entityId = Number(/Its codex entry is entity #(\d+) \(new\)\./.exec(first)![1]);
    const [, realmName, realmId] = /It belongs to (.+?) \(entity #(\d+)\)/.exec(first)!;

    const place = JSON.parse(await call('entity', { campaign_id: id, op: 'get', id: entityId })) as { name: string; kind: string };
    expect(place).toMatchObject({ name: 'Redham', kind: 'place' });
    const realm = JSON.parse(await call('entity', { campaign_id: id, op: 'get', id: Number(realmId) })) as { name: string; kind: string };
    expect(realm).toMatchObject({ name: realmName, kind: 'faction' });

    const again = await call('region', { campaign_id: id, op: 'reveal', place: 'Redham' });
    expect(again).toContain(`Its codex entry is entity #${entityId} (existing).`);
  });
});
