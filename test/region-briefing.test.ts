import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, campaignSnapshot, loadCampaign } from '../src/core/campaign.js';
import { findPlace, importRegion } from '../src/core/region.js';
import { saveHierarchy, savePolitics } from '../src/core/politics-store.js';
import type { ComputedCounties, ComputedHierarchy, ComputedRealms } from '../src/core/politics-types.js';
import { regionBriefing } from '../src/core/region-briefing.js';
import { ensureWorld } from '../src/core/world-seed.js';
import { renderBriefing } from '../src/mcp/tools/campaign.js';
import { openDb, type Db } from '../src/db/connection.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(name = 'The Ashfall Road'): number {
  return createCampaign(db, { name, story_shape: 'structured' }).campaign_id;
}

function safeCampaign(): number {
  const campaignId = newCampaign();
  importRegion(db, campaignId, safe, { source: 'generated' });
  return campaignId;
}

/** A handcrafted hierarchy saved directly, so the briefing does not depend on the pipeline wiring. */
function hierarchyCampaign(): number {
  const campaignId = safeCampaign();
  const redham = findPlace(db, campaignId, 'Redham')!.id;
  const ficengwind = findPlace(db, campaignId, 'Ficengwind')!.id;
  const southernLanding = findPlace(db, campaignId, 'Southern Landing')!.id;

  const counties: ComputedCounties = {
    counties: [
      { name: 'County of Redham', seat_place_id: redham, seat_kind: 'town', hexes: ['q6_r8'], village_place_ids: [], component: 0 },
      { name: 'County of Ficengwind', seat_place_id: ficengwind, seat_kind: 'city', hexes: ['q4_r11'], village_place_ids: [], component: 0 },
      { name: 'March of the Fens', seat_place_id: southernLanding, seat_kind: 'castle', hexes: ['q11_r14'], village_place_ids: [], component: 0 },
    ],
    edges: [],
  };
  const realms: ComputedRealms = {
    realms: [
      { name: 'Kingdom of Ficengwind', kind: 'kingdom', capital_place_id: ficengwind, off_map: false, liege: null },
      { name: 'Lordship of Redham', kind: 'lordship', capital_place_id: redham, off_map: false, liege: 0 },
      { name: 'Free City of the Reach', kind: 'free_city', capital_place_id: null, off_map: true, liege: null },
    ],
    county_realm: [1, 0, 1],
  };
  const hierarchy: ComputedHierarchy = {
    duchies: [
      { name: 'Duchy of Redham', realm: 1, seat_place_id: redham, county_indexes: [0], demesne: true, joined_how: 'core' },
      { name: 'Duchy of the Fens', realm: 1, seat_place_id: southernLanding, county_indexes: [2], demesne: false, joined_how: 'conquest' },
    ],
    county_duchy: [0, null, 1],
    march_counties: [2],
    claims: [
      { county: 2, claimant_realm: 0, strength: 'strong', reason: 'ancient kingdom' },
      { county: 1, claimant_realm: 2, strength: 'weak', reason: 'dowry' },
    ],
  };
  saveHierarchy(db, campaignId, { counties, realms, hierarchy });
  return campaignId;
}

describe('regionBriefing without a region', () => {
  it('is empty, and the snapshot carries nothing for the player or the DM', () => {
    const campaignId = newCampaign();

    expect(regionBriefing(db, campaignId, null)).toBe('');
    expect(campaignSnapshot(db, campaignId).region_briefing).toBe('');
  });
});

describe('regionBriefing on the safe realm', () => {
  it('opens with the region line and lists the settlements, areas and routes', () => {
    const campaignId = safeCampaign();
    const text = regionBriefing(db, campaignId, null);

    expect(text.startsWith('## Region: Realm Of Poss (fjord, civilized, lawful, safe; 1 hex = 6 miles)')).toBe(true);
    expect(text).toContain('- Redham (town, walled, coast; plains; County of Redham) - A walled port town of abundant privacy.');
    expect(text).toContain('Areas: Coldwood (forest-dark), Raven Marshes (swamp), Ironfall Fens (swamp)');

    const routesLine = text.split('\n').find((line) => line.startsWith('Routes: '))!;
    expect(routesLine.startsWith('Routes: Stormcourtby-Redham 4 hexes')).toBe(true);
    expect(routesLine).toContain('; sea: Southern Landing-Redham 16 hexes');

    expect(text).not.toContain('Dangers');
    expect(text).not.toContain('Party is at');
  });

  it('places the party inside a known settlement and lists what is nearby', () => {
    const campaignId = safeCampaign();
    const text = regionBriefing(db, campaignId, 'The Gilded Goose in Redham');

    expect(text).toContain(
      'Party is around: Redham (settlement), from the scene location "The Gilded Goose in Redham"',
    );
    expect(text).toContain('Near the party:');
    expect(text).toContain('Ironfall Fens (area, 1 hexes)');
  });

  it('says the party is at the place on an exact name match', () => {
    const campaignId = safeCampaign();
    const text = regionBriefing(db, campaignId, 'redham');

    expect(text).toContain('Party is at: Redham (settlement)');
  });

  it('caps roads and sea routes independently', () => {
    const campaignId = safeCampaign();
    db.prepare('DELETE FROM world_route WHERE campaign_id = ?').run(campaignId);
    const insert = db.prepare(
      'INSERT INTO world_route (campaign_id, kind, from_hex, to_hex, hexes_json) VALUES (?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < 12; i += 1) {
      insert.run(campaignId, 'road', 'q9_r5', `q${i}_r0`, JSON.stringify(['q9_r5', `q${i}_r0`]));
    }
    for (let i = 0; i < 7; i += 1) {
      insert.run(campaignId, 'searoute', 'q11_r14', `q${i}_r0`, JSON.stringify(['q11_r14', `q${i}_r0`]));
    }

    const text = regionBriefing(db, campaignId, null);
    const routesLine = text.split('\n').find((line) => line.startsWith('Routes: '))!;
    const [roadsPart, seasPart] = routesLine.split('; sea: ');

    expect(roadsPart.match(/Stormcourtby-the map edge 1 hexes/g)).toHaveLength(10);
    expect(roadsPart.endsWith(', … and 2 more')).toBe(true);
    expect(seasPart.match(/Southern Landing-the map edge 1 hexes/g)).toHaveLength(5);
    expect(seasPart.endsWith(', … and 2 more')).toBe(true);
  });

  it('shows the realm, its capital and counties, and the county of each settlement', () => {
    const campaignId = safeCampaign();
    const text = regionBriefing(db, campaignId, null);

    // The hierarchy lists the realm on its own line with its counties beneath it.
    expect(text).toContain('Kingdom of Ficengwind (kingdom, capital Ficengwind)');
    expect(text).toContain('  Outside duchies: County of Redham, County of Ficengwind, Lordship of Southern Landing');

    const stormcourtby = text.split('\n').find((line) => line.startsWith('- Stormcourtby '))!;
    expect(stormcourtby).toContain('; County of Redham)');

    const hotfield = text.split('\n').find((line) => line.startsWith('- Hotfield '))!;
    expect(hotfield).toContain('Lordship of Southern Landing');
  });

  it('renders the handcrafted hierarchy with duchies, crownlands, a march, a claim, an off-map capital and a vassal', () => {
    const campaignId = hierarchyCampaign();
    const text = regionBriefing(db, campaignId, null);

    expect(text).toContain('Kingdom of Ficengwind (kingdom, capital Ficengwind)');
    expect(text).toContain('  Outside duchies: County of Ficengwind');
    expect(text).toContain(
      'Lordship of Redham (lordship, capital Redham, vassal of Kingdom of Ficengwind)',
    );
    expect(text).toContain('  Duchy of Redham (seat Redham, crownlands): County of Redham');
    expect(text).toContain('  Duchy of the Fens (seat Southern Landing, joined by conquest): March of the Fens');
    expect(text).toContain('Free City of the Reach (free_city, capital off the map)');
    expect(text).toContain('Marches: March of the Fens');
    expect(text).toContain('Contested: March of the Fens — claimed by Kingdom of Ficengwind (ancient kingdom, strong)');
    expect(text).toContain('Contested: County of Ficengwind — claimed by Free City of the Reach (dowry, weak)');
  });

  it('marks a coastal town as a port and puts its county and duchy on the line', () => {
    const campaignId = hierarchyCampaign();
    const redham = regionBriefing(db, campaignId, null)
      .split('\n')
      .find((line) => line.startsWith('- Redham '))!;

    expect(redham).toContain('; County of Redham, Duchy of Redham)');
    expect(redham.endsWith('[port]')).toBe(true);
  });

  it('says so when the location is not on the map', () => {
    const campaignId = safeCampaign();
    const text = regionBriefing(db, campaignId, 'A cave nobody mapped');

    expect(text).toContain('Party is at "A cave nobody mapped", which is not on the region map.');
    expect(text).not.toContain('Near the party:');
  });

  it('marks a place the party knows', () => {
    const campaignId = safeCampaign();
    db.prepare("UPDATE world_place SET known_to_party = 1 WHERE campaign_id = ? AND name = 'Redham'").run(
      campaignId,
    );

    // Updated for the port marker: a coastal place is tagged before the known marker.
    expect(regionBriefing(db, campaignId, null)).toContain(
      'A walled port town of abundant privacy. [port] [known]',
    );
  });

  it('shows the living world government once the world has seeded it', () => {
    const campaignId = safeCampaign();
    ensureWorld(db, campaignId);

    expect(regionBriefing(db, campaignId, null)).toContain(
      'Theocracy of Ficengwind (theocracy, capital Ficengwind)',
    );
  });
});

describe('regionBriefing on the dangerous realm', () => {
  it('names the crowned realm and puts each danger in its county', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, dangerous, { source: 'uploaded' });
    const text = regionBriefing(db, campaignId, null);

    expect(text).toContain('Lordship of Crimson Wharf (lordship, capital Crimson Wharf)');
    expect(text).toMatch(/\(dungeon, \d+ hexes from [^)]+, in (?:County|Lordship) of [^)]+\)/);
  });

  it('names the dangers with their nearest settlement, and never leaks them to the player', () => {
    const campaignId = newCampaign();
    importRegion(db, campaignId, dangerous, { source: 'uploaded' });
    const text = regionBriefing(db, campaignId, null);

    expect(text).toContain('Dangers (DM only):');
    expect(text).toContain('- Hidden Keep (dungeon, ');
    expect(text).toContain('- Ziggurat Of The Vampire Queen (dungeon, ');
    expect(text).toMatch(
      /- Hidden Keep \(dungeon, \d+ hexes from (Frostcot|Crimson Wharf), in (?:County|Lordship) of [^)]+\)/,
    );
    expect(text).toMatch(
      /- Ziggurat Of The Vampire Queen \(dungeon, \d+ hexes from (Frostcot|Crimson Wharf), in (?:County|Lordship) of [^)]+\)/,
    );

    const dm = campaignSnapshot(db, campaignId).region_briefing;
    const player = campaignSnapshot(db, campaignId, { forPlayer: true }).region_briefing;
    expect(dm).not.toBe('');
    expect(dm).toContain('Hidden Keep');
    expect(player).toBe('');
  });
});

describe('renderBriefing', () => {
  it('puts the region block above the recap', () => {
    const campaignId = safeCampaign();
    const rendered = renderBriefing(loadCampaign(db, campaignId));

    const regionAt = rendered.indexOf('## Region:');
    const recapAt = rendered.indexOf('## Recap');
    expect(regionAt).toBeGreaterThan(-1);
    expect(recapAt).toBeGreaterThan(-1);
    expect(regionAt).toBeLessThan(recapAt);
  });
});

describe('the realm hierarchy', () => {
  const placeId = (campaignId: number, name: string): number =>
    (db
      .prepare('SELECT id FROM world_place WHERE campaign_id = ? AND name = ?')
      .get(campaignId, name) as { id: number }).id;

  const hierarchy = (campaignId: number): string => {
    const lines = regionBriefing(db, campaignId, null).split('\n');
    const start = lines.indexOf('Realms:');
    const end = lines.indexOf('Settlements:');
    return lines.slice(start, end === -1 ? undefined : end).join('\n');
  };

  it('renders a realm with no counties without an empty county list', () => {
    const campaignId = safeCampaign();

    savePolitics(db, campaignId, {
      realms: [{ name: 'Empty Crown', capital_place_id: null }],
      counties: [],
    });
    expect(regionBriefing(db, campaignId, null)).toContain('Empty Crown (kingdom, no crown)');

    savePolitics(db, campaignId, {
      realms: [{ name: 'Empty Crown', capital_place_id: placeId(campaignId, 'Redham') }],
      counties: [],
    });
    expect(regionBriefing(db, campaignId, null)).toContain('Empty Crown (kingdom, capital Redham)');
  });

  it('skips counties with no hexes', () => {
    const campaignId = safeCampaign();
    savePolitics(db, campaignId, {
      realms: [{ name: 'Hollow Realm', capital_place_id: placeId(campaignId, 'Redham') }],
      counties: [{ name: 'Empty County', seat_place_id: placeId(campaignId, 'Redham'), realm: 0, hexes: [] }],
    });

    const text = regionBriefing(db, campaignId, null);
    expect(text).toContain('Hollow Realm (kingdom, capital Redham)');
    // The county still names the settlement seated there, but it is skipped from the hierarchy itself.
    expect(hierarchy(campaignId)).not.toContain('Empty County');
  });

  it('names the units in the overflow tail', () => {
    const campaignId = safeCampaign();
    const seat = placeId(campaignId, 'Redham');
    const counties = Array.from({ length: 14 }, (_, index) => ({
      name: `County ${index}`,
      seat_place_id: seat,
      realm: 0,
      hexes: [`q${index}_r${index}`],
    }));
    savePolitics(db, campaignId, { realms: [{ name: 'Many Counties', capital_place_id: seat }], counties });
    expect(regionBriefing(db, campaignId, null)).toContain('… and 2 more counties');

    savePolitics(db, campaignId, {
      realms: Array.from({ length: 8 }, (_, index) => ({ name: `Realm ${index}`, capital_place_id: null })),
      counties: [],
    });
    expect(regionBriefing(db, campaignId, null)).toContain('… and 2 more realms');
  });
});
