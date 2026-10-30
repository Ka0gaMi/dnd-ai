// Seat modifiers: a seat raided or besieged today projects 20 less control until the state is lifted or
// lapses, and the cached control map is rederived only when a seat's raid or siege modifier changes.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { setCalendar } from '../src/core/calendar.js';
import { createCampaign } from '../src/core/campaign.js';
import { controlMap, ensurePolitics, type PlaceControl } from '../src/core/politics-service.js';
import { getRegion, importRegion, type WorldPlace } from '../src/core/region.js';
import { clearPlaceState, RAIDED_DAYS, setPlaceState } from '../src/core/world-place-state.js';
import { currentGameDay } from '../src/core/world-store.js';
import { openDb, type Db } from '../src/db/connection.js';

const LARGE = JSON.parse(readFileSync(new URL('./fixtures/realm-large.json', import.meta.url), 'utf8')) as unknown;

let db: Db;
let campaignId: number;
let today: number;

/** A large-realm campaign on a database of its own, so nothing is cached for it yet. */
function campaign(): { db: Db; campaignId: number } {
  const fresh = openDb(':memory:');
  const id = createCampaign(fresh, { name: 'Seat modifiers', story_shape: 'structured' }).campaign_id;
  importRegion(fresh, id, LARGE, { source: 'generated' });
  ensurePolitics(fresh, id);
  return { db: fresh, campaignId: id };
}

beforeEach(() => {
  ({ db, campaignId } = campaign());
  today = currentGameDay(db, campaignId);
});

const place = (name: string): WorldPlace => getRegion(db, campaignId)!.places.find((entry) => entry.name === name)!;
const hexOf = (name: string): string => place(name).hexes[0]!;
const realmId = (name: string): number => ensurePolitics(db, campaignId)!.realms.find((realm) => realm.name === name)!.id;
const mark = (name: string, state: 'raided' | 'besieged'): void => {
  setPlaceState(db, campaignId, place(name).id, today, { state });
};

/** True when every entry is the very object the earlier map held, as only a cache hit serves. */
const reused = (earlier: Map<string, PlaceControl>, later: Map<string, PlaceControl>): boolean =>
  [...later].every(([hex, entry]) => earlier.get(hex) === entry);
/** True when no entry is an object the earlier map held, as a fresh derivation gives. */
const rederived = (earlier: Map<string, PlaceControl>, later: Map<string, PlaceControl>): boolean =>
  [...later].every(([hex, entry]) => earlier.get(hex) !== entry);

describe('a raided or besieged seat', () => {
  it('loses exactly 20 when raided, and no hex loses more', () => {
    const before = controlMap(db, campaignId)!;
    expect(before.get(hexOf('Thundercross'))).toMatchObject({ control: 100, band: 'core' });

    mark('Thundercross', 'raided');
    const after = controlMap(db, campaignId)!;
    expect(after.get(hexOf('Thundercross'))).toMatchObject({
      control: 80,
      band: 'core',
      realm_id: realmId('Kingdom of Darkforge'),
    });
    for (const [hex, entry] of after) {
      const loss = before.get(hex)!.control - entry.control;
      expect(loss).toBeGreaterThanOrEqual(0);
      expect(loss).toBeLessThanOrEqual(20);
      expect(entry.realm_id).toBe(before.get(hex)!.realm_id);
    }
  });

  it('loses exactly 20 when besieged, dropping a core seat to held', () => {
    expect(controlMap(db, campaignId)!.get(hexOf('Palewood'))).toMatchObject({ control: 80, band: 'core' });
    mark('Palewood', 'besieged');
    expect(controlMap(db, campaignId)!.get(hexOf('Palewood'))).toMatchObject({ control: 60, band: 'held' });
  });

  it('lets a rival within the contest margin when the loss closes the gap', () => {
    const darkforge = realmId('Kingdom of Darkforge');
    expect(controlMap(db, campaignId)!.get(hexOf('Underfield'))).toMatchObject({
      control: 90,
      band: 'core',
      realm_id: darkforge,
      rival_realm_id: null,
    });

    mark('Underfield', 'raided');
    expect(controlMap(db, campaignId)!.get(hexOf('Underfield'))).toMatchObject({
      control: 70,
      band: 'contested',
      realm_id: darkforge,
      rival_realm_id: realmId('Principality of Ecthel'),
    });
  });

  it('gets its strength back when the raid and the siege are lifted', () => {
    const before = controlMap(db, campaignId)!;
    mark('Thundercross', 'raided');
    mark('Palewood', 'besieged');
    expect(controlMap(db, campaignId)!).not.toEqual(before);

    clearPlaceState(db, campaignId, place('Thundercross').id, today);
    clearPlaceState(db, campaignId, place('Palewood').id, today);
    expect(controlMap(db, campaignId)!).toEqual(before);
  });

  it('gets its strength back the day the raid lapses', () => {
    const before = controlMap(db, campaignId)!;
    mark('Thundercross', 'raided');

    // A new campaign opens on day 1 of month 1, so day 30 of month 3 is the raid's last day.
    setCalendar(db, campaignId, { month: 3, day: 30 });
    expect(currentGameDay(db, campaignId)).toBe(today + RAIDED_DAYS - 1);
    expect(controlMap(db, campaignId)!.get(hexOf('Thundercross'))!.control).toBe(80);

    setCalendar(db, campaignId, { month: 4, day: 1 });
    expect(controlMap(db, campaignId)!).toEqual(before);
  });
});

describe('the cached control map', () => {
  it('is rederived when a seat is raided and again when the raid is lifted', () => {
    const first = controlMap(db, campaignId)!;
    mark('Thundercross', 'raided');
    const raided = controlMap(db, campaignId)!;
    expect(rederived(first, raided)).toBe(true);

    const other = campaign();
    setPlaceState(other.db, other.campaignId, place('Thundercross').id, today, { state: 'raided' });
    expect(raided).toEqual(controlMap(other.db, other.campaignId)!);

    clearPlaceState(db, campaignId, place('Thundercross').id, today);
    const lifted = controlMap(db, campaignId)!;
    expect(rederived(raided, lifted)).toBe(true);
    expect(lifted).toEqual(first);
  });

  it('is reused while no seat gains or loses its raid or siege modifier', () => {
    const seats = new Set(ensurePolitics(db, campaignId)!.counties.map((county) => county.seat_place_id));
    expect(seats.has(place('Coldhill').id)).toBe(false);
    const first = controlMap(db, campaignId)!;
    mark('Coldhill', 'raided');
    const villageRaided = controlMap(db, campaignId)!;
    expect(reused(first, villageRaided)).toBe(true);

    setCalendar(db, campaignId, { day: 2 });
    const nextDay = controlMap(db, campaignId)!;
    expect(reused(first, nextDay)).toBe(true);

    mark('Thundercross', 'raided');
    const seatRaided = controlMap(db, campaignId)!;
    expect(rederived(first, seatRaided)).toBe(true);

    // Raided and besieged cost the same 20, so the map derived from it still holds.
    mark('Thundercross', 'besieged');
    expect(reused(seatRaided, controlMap(db, campaignId)!)).toBe(true);
  });
});
