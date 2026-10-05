// The DM's region block on a large map: within REGION_BRIEFING tokens, centred on the party (its realm first,
// every list nearest first), cut counties counted and dangers outside held land placed in the wilds.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot, createCampaign, saveCheckpoint } from '../src/core/campaign.js';
import { ensurePolitics } from '../src/core/politics-service.js';
import { savePolitics, type StoredCounty, type StoredPolitics } from '../src/core/politics-store.js';
import { findPlace, getRegion, importRegion, type WorldPlace } from '../src/core/region.js';
import { realmHierarchyLines, regionBriefing } from '../src/core/region-briefing.js';
import { hexDistance, parseHex, placeDistance } from '../src/core/region-graph.js';
import { estimateTokens, REGION_BRIEFING } from '../src/core/token-budget.js';
import { borderingCountyIds, ensureWorld } from '../src/core/world-seed.js';
import { openDb, type Db } from '../src/db/connection.js';

const fixture = (name: 'large' | 'dangerous'): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/realm-${name}.json`, import.meta.url), 'utf8')) as unknown;

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function campaignWith(name: 'large' | 'dangerous'): number {
  const campaignId = createCampaign(db, { name: `Budget ${name}`, story_shape: 'structured' }).campaign_id;
  importRegion(db, campaignId, fixture(name), { source: 'generated' });
  return campaignId;
}

/** The lines of one section: from its heading up to the next line that is not one of its bullets. */
function bullets(text: string, heading: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  if (start === -1) return [];
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('- ')) break;
    if (!line.startsWith('- … and')) section.push(line);
  }
  return section;
}

const nameOf = (line: string): string => line.slice(2, line.indexOf(' ('));

/** The realm header lines, top to bottom. */
function realmLines(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf('Realms:');
  const end = lines.findIndex((line, index) => index > start && /^(Marches|Contested|Party|Settlements)/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => !line.startsWith(' '));
}

const isSorted = (values: number[]): boolean => values.every((value, index) => index === 0 || values[index - 1] <= value);

describe('the region block on the large map', () => {
  it('stays within REGION_BRIEFING wherever the party stands, and with no party', () => {
    const campaignId = campaignWith('large');
    for (const location of [null, 'Dione', 'Thundercross', 'Suncore', 'Tower Of Pann', 'The Gilded Goose in Ecthel', 'A cave nobody mapped']) {
      expect(estimateTokens(regionBriefing(db, campaignId, location))).toBeLessThanOrEqual(REGION_BRIEFING);
    }

    ensureWorld(db, campaignId);
    expect(estimateTokens(regionBriefing(db, campaignId, 'Dione'))).toBeLessThanOrEqual(REGION_BRIEFING);
  });

  it("centres the snapshot's block on the latest scene location", () => {
    const campaignId = campaignWith('large');
    saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'They make camp.', scene_location: 'The Gilded Goose in Dione' });

    const text = campaignSnapshot(db, campaignId).region_briefing;
    expect(text).toContain('Party is around: Dione (settlement), from the scene location "The Gilded Goose in Dione"');
    expect(realmLines(text)[0]).toMatch(/^Kingdom of Dione \(/);
    expect(estimateTokens(text)).toBeLessThanOrEqual(REGION_BRIEFING);
  });

  it("puts the party's realm first, then its neighbours, then distant realms, each by distance and none cut", () => {
    const campaignId = campaignWith('large');
    const politics = ensurePolitics(db, campaignId)!;
    const dione = findPlace(db, campaignId, 'Dione')!;
    const from = parseHex(dione.hexes[0]);
    const territory = (realmId: number): StoredCounty[] => politics.counties.filter((county) => county.realm_id === realmId);
    const distance = (realmId: number): number =>
      Math.min(
        Infinity,
        ...territory(realmId).flatMap((county) => (county.claim_hexes ?? county.hexes).map((hex) => hexDistance(from, parseHex(hex)))),
      );

    const names = realmLines(regionBriefing(db, campaignId, 'Dione')).map((line) => line.slice(0, line.indexOf(' (')));
    const realms = names.map((name) => politics.realms.find((realm) => realm.name === name)!);
    expect(realms.map((realm) => realm.id).sort()).toEqual(politics.realms.map((realm) => realm.id).sort());
    expect(politics.realms.length).toBeGreaterThan(6);

    const [home, ...rest] = realms;
    expect(home.name).toBe('Kingdom of Dione');
    const bordering = new Set(
      [...borderingCountyIds(politics, territory(home.id))].map((id) => politics.counties.find((c) => c.id === id)!.realm_id),
    );
    const neighbours = rest.filter((realm) => bordering.has(realm.id));
    const distant = rest.filter((realm) => !bordering.has(realm.id));
    expect(neighbours.length).toBeGreaterThan(0);
    expect(rest).toEqual([...neighbours, ...distant]);
    expect(isSorted(neighbours.map((realm) => distance(realm.id)))).toBe(true);
    expect(isSorted(distant.map((realm) => distance(realm.id)))).toBe(true);

    expect(realmLines(regionBriefing(db, campaignId, 'Thundercross'))[0]).toMatch(/^Kingdom of Darkforge \(/);
  });

  it('lists settlements and dangers nearest the party first', () => {
    const campaignId = campaignWith('large');
    const dione = findPlace(db, campaignId, 'Dione')!;
    const text = regionBriefing(db, campaignId, 'Dione');
    const distances = (heading: string): number[] =>
      bullets(text, heading).map((line) => placeDistance(dione, findPlace(db, campaignId, nameOf(line))!));

    const settlements = distances('Settlements:');
    expect(settlements.length).toBeGreaterThan(5);
    expect(settlements[0]).toBe(0);
    expect(isSorted(settlements)).toBe(true);

    const dangers = distances('Dangers (DM only):');
    expect(dangers.length).toBeGreaterThan(1);
    expect(isSorted(dangers)).toBe(true);
  });

  it('reads a duchy the county budget emptied as "… N counties", never as having none', () => {
    const campaignId = campaignWith('large');
    const text = regionBriefing(db, campaignId, 'Thundercross');

    expect(text).toMatch(/^ {2}Duchy of .+\): … \d+ counties$/m);
    expect(text).not.toContain(': no counties');
    expect(text).not.toContain('more realms');
  });

  it('places dangers outside held counties in the wilds or the Marches of the claiming realm', () => {
    const campaignId = campaignWith('large');
    const text = regionBriefing(db, campaignId, 'Dione');

    expect(text).toMatch(/^- Tower Of Pann \(dungeon, \d+ hexes from [^,]+, in the Marches of Kingdom of Darkforge\)$/m);
    expect(text).toMatch(/^- Den Of Knowledge \(dungeon, \d+ hexes from [^,]+, in the wilds of Kingdom of Darkforge\)$/m);
    for (const line of bullets(text, 'Dangers (DM only):')) {
      expect(line).toMatch(/, in (County of |Lordship of |the wilds|the Marches of )/);
    }
  });

  it('trims distant detail first: neighbours collapse to one line, then lists lose their farthest entries', () => {
    const campaignId = campaignWith('large');
    db.prepare("UPDATE world_place SET info = ? WHERE campaign_id = ? AND kind = 'settlement'").run(
      'A long-winded description of the market, the walls, the temple and the gossip of the square. '.repeat(3),
      campaignId,
    );
    const dione = findPlace(db, campaignId, 'Dione')!;
    const text = regionBriefing(db, campaignId, 'Dione');

    expect(estimateTokens(text)).toBeLessThanOrEqual(REGION_BRIEFING);
    const [home, ...others] = realmLines(text);
    expect(home).toBe('Kingdom of Dione (kingdom, capital Dione)');
    expect(text).toMatch(/^ {2}Crownlands of Dione \(seat Dione, crownlands\): County of Dione/m);
    for (const line of others) expect(line).toMatch(/\): … \d+ count(y|ies)$/);

    const shown = bullets(text, 'Settlements:').map(nameOf);
    expect(shown[0]).toBe('Dione');
    expect(shown.length).toBeLessThan(15);
    const hidden = getRegion(db, campaignId)!.places.filter(
      (place: WorldPlace) => place.kind === 'settlement' && !shown.includes(place.name),
    );
    const farthestShown = Math.max(...shown.map((name) => placeDistance(dione, findPlace(db, campaignId, name)!)));
    const nearestHidden = Math.min(...hidden.map((place) => placeDistance(dione, place)));
    expect(farthestShown).toBeLessThanOrEqual(nearestHidden);
  });
});

describe('dangers on unclaimed land', () => {
  it('read "in the wilds" with no realm named', () => {
    const campaignId = campaignWith('dangerous');
    const wharf = findPlace(db, campaignId, 'Crimson Wharf')!;
    savePolitics(db, campaignId, {
      realms: [{ name: 'Lordship of Crimson Wharf', capital_place_id: wharf.id }],
      counties: [{ name: 'County of the Wharf', seat_place_id: wharf.id, realm: 0, hexes: [wharf.hexes[0]] }],
    });

    const text = regionBriefing(db, campaignId, null);
    expect(text).toMatch(/^- Hidden Keep \(dungeon, \d+ hexes from [^,]+, in the wilds\)$/m);
    expect(text).toMatch(/^- Ziggurat Of The Vampire Queen \(dungeon, \d+ hexes from [^,]+, in the wilds\)$/m);
  });
});

describe('realmHierarchyLines', () => {
  const county = (id: number, duchy: number | null, realm = 1): StoredCounty => ({
    id,
    realm_id: realm,
    name: `County ${id}`,
    seat_place_id: 0,
    hexes: [`q${id}_r0`],
    seat_kind: 'town',
    duchy_id: duchy,
    is_march: false,
    village_place_ids: [],
  });
  const crowded = (): StoredPolitics => {
    const counties = [
      ...Array.from({ length: 13 }, (_, index) => county(index, 10)),
      county(13, 11),
      county(14, 11),
      county(15, null, 2),
    ];
    const realm = (id: number, name: string) => ({
      id,
      name,
      capital_place_id: null,
      kind: 'kingdom' as const,
      off_map: false,
      liege_realm_id: null,
      government: null,
      ruler_title: null,
      county_ids: counties.filter((entry) => entry.realm_id === id).map((entry) => entry.id),
    });
    const duchy = (id: number, name: string) => ({
      id,
      realm_id: 1,
      name,
      seat_place_id: null,
      demesne: false,
      joined_how: 'core' as const,
      county_ids: counties.filter((entry) => entry.duchy_id === id).map((entry) => entry.id),
    });
    return {
      realms: [realm(1, 'Crowded Crown'), realm(2, 'Far Realm')],
      counties,
      duchies: [duchy(10, 'Duchy of Plenty'), duchy(11, 'Duchy of Want')],
      claims: [],
    };
  };

  it('with a focus, counts what the county budget cut and reads a distant realm as one line', () => {
    const lines = realmHierarchyLines(crowded(), [], { party: null, detailed: 1 });
    const named = Array.from({ length: 12 }, (_, index) => `County ${index}`).join(', ');

    expect(lines).toContain(`  Duchy of Plenty (seat unseated): ${named}, … and 1 more county`);
    expect(lines).toContain('  Duchy of Want (seat unseated): … 2 counties');
    expect(lines).toContain('Far Realm (kingdom, no crown): … 1 county');
    expect(lines.join('\n')).not.toContain('no counties');
  });

  it('keeps its default output for the region tool', () => {
    expect(realmHierarchyLines(crowded(), [])).toContain('  Duchy of Want (seat unseated): no counties');

    const campaignId = campaignWith('large');
    const lines = realmHierarchyLines(ensurePolitics(db, campaignId)!, getRegion(db, campaignId)!.places);
    expect(lines).toEqual([
      'Realms:',
      'Kingdom of Darkforge (kingdom, capital Darkforge)',
      '  Crownlands of Darkforge (seat Darkforge, crownlands): County of Delin, County of Az, County of Darkforge, County of Amberscale, County of Redfield',
      '  Duchy of Thundercross (seat Thundercross, joined by inheritance): County of Winterburg, County of Thundercross',
      '  Duchy of Underfield (seat Underfield, joined by inheritance): County of Underfield, County of Palewood',
      '  Duchy of Mirkshield (seat Mirkshield): County of Mirkshield, Lordship of Daggermoon',
      '  Duchy of Timberbreeze (seat Timberbreeze): County of Timberbreeze',
      'Principality of Ecthel (lordship, capital Ecthel, vassal of Kingdom of Darkforge)',
      'Free City of Suncore (free city, capital Suncore)',
      'Kingdom of Dione (kingdom, capital Dione)',
      '  Crownlands of Dione (seat Dione, crownlands): no counties',
      'Lordship of Azurefire (lordship, capital Azurefire, vassal of Kingdom of Darkforge)',
      'Lordship of Deepbridge (lordship, capital Deepbridge, vassal of Kingdom of Darkforge)',
      '… and 12 more counties and 1 more realms',
      'Marches: County of Winterburg, County of Thundercross, County of Northern Point, County of Az, County of Darkforge, County of Blackhall, County of Putecrest, County of Timberbreeze, Lordship of Dragon Farm, Lordship of Everhaven, Lordship of Southern Watch',
      'Contested: County of Northern Point — claimed by Kingdom of Darkforge (ancient kingdom, strong)',
      'Contested: County of Blackhall — claimed by Kingdom of Darkforge (ancient kingdom, strong)',
      'Contested: County of Putecrest — claimed by Kingdom of Darkforge (ancient kingdom, strong)',
    ]);
  });
});
