import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { digestPlaceMap, renderPlaceMapDigest } from '../src/core/place-map-digest.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown;
}

const city = fixture('map-city-redham');
const village = fixture('map-village-hotfield');
const hiddenKeep = fixture('map-dungeon-hidden-keep');
const library = fixture('map-dungeon-library');

const CITY_LINK =
  'https://watabou.github.io/city-generator/?size=16&seed=1081863920&name=Redham&citadel=0&urban_castle=0&walls=1&shantytown=1&gates=1&plaza=0&temple=1&river=0&coast=1&sea=-0.6025368523640575&from=perilous';
const VILLAGE_LINK =
  'https://watabou.github.io/village-generator/?seed=78732595&name=Hotfield&tags=coast&from=perilous';
const DUNGEON_LINK = 'https://watabou.github.io/dungeon-generator/?seed=1';

const FLAVOUR_LINE =
  "Flavour only: the generator's items and effects are prompts, not rules. Run anything mechanical as SRD content or a homebrew clause.";

describe('digestPlaceMap on a city', () => {
  const digest = digestPlaceMap('city', city, CITY_LINK);

  it('reads the counts and shape flags', () => {
    expect(digest).toEqual({
      kind: 'city',
      name: 'Redham',
      buildings: 343,
      districts: [
        'Merchants District',
        'Docks Ward',
        'South Redham',
        'Downfall Gate',
        'Bone Orchard',
        'Daggerchurch Square',
      ],
      walled: true,
      wall_towers: 19,
      bridges: 4,
      squares: 0,
      fields: 4,
      water: true,
      river: false,
      link_flags: ['temple', 'walls', 'shanty town', 'coast'],
    });
  });

  it('renders one line', () => {
    expect(renderPlaceMapDigest(digest)).toBe(
      'Redham (city map): 343 buildings; districts: Merchants District, Docks Ward, South Redham, ' +
        'Downfall Gate, Bone Orchard, Daggerchurch Square; walled, 19 towers; 4 bridges; by water; ' +
        'temple, walls, shanty town, coast',
    );
  });
});

describe('digestPlaceMap on a village', () => {
  const digest = digestPlaceMap('village', village, VILLAGE_LINK);

  it('reads the counts, tags and no districts', () => {
    expect(digest).toEqual({
      kind: 'village',
      name: 'Hotfield',
      buildings: 20,
      districts: [],
      walled: false,
      wall_towers: 0,
      bridges: 2,
      squares: 1,
      fields: 7,
      water: true,
      river: false,
      link_flags: ['coast'],
    });
    expect(renderPlaceMapDigest(digest)).toBe(
      'Hotfield (village map): 20 buildings; 2 bridges; by water; coast',
    );
    expect(renderPlaceMapDigest(digest).startsWith('Hotfield (village map): 20 buildings')).toBe(true);
  });
});

describe('digestPlaceMap on a dungeon', () => {
  it('reads Hidden Keep', () => {
    const digest = digestPlaceMap('dungeon', hiddenKeep, DUNGEON_LINK);
    expect(digest.kind).toBe('dungeon');
    if (digest.kind !== 'dungeon') return;
    expect(digest.title).toBe('Hidden Keep');
    expect(digest.rooms).toBe(74);
    expect(digest.doors).toEqual({
      empty: 19,
      door: 10,
      opening: 5,
      'stairs down': 1,
      'double door': 1,
      'flush door': 2,
      'type 9': 3,
    });
    expect(digest.notes.map((note) => note.ref)).toEqual(['1', '2', '3', '4', '5']);
    expect(digest.columns).toBe(62);
    expect(digest.water).toBe(0);
  });

  it('reads Library Of Darkness', () => {
    const digest = digestPlaceMap('dungeon', library, DUNGEON_LINK);
    expect(digest.kind).toBe('dungeon');
    if (digest.kind !== 'dungeon') return;
    expect(digest.rooms).toBe(21);
    expect(digest.doors).toEqual({
      empty: 2,
      door: 3,
      opening: 2,
      'stairs down': 1,
      bars: 1,
      'double door': 1,
      'stairs up': 1,
      'type 9': 1,
    });
  });

  it('renders doors in order, then story, notes and the flavour line', () => {
    const digest = digestPlaceMap('dungeon', hiddenKeep, DUNGEON_LINK);
    const lines = renderPlaceMapDigest(digest).split('\n');
    expect(lines[0]).toBe(
      'Hidden Keep (dungeon map): 74 rooms and corridors; doors: empty 19, door 10, opening 5, ' +
        'stairs down 1, double door 1, flush door 2, type 9 3',
    );
    expect(lines[0].startsWith('Hidden Keep (dungeon map): 74 rooms and corridors; doors: empty 19, door 10, opening 5')).toBe(
      true,
    );
    expect(lines[1]).toBe(
      'Story: For a millenium the manor of Peronax remained sealed. Lately a gang of pirates ' +
        'rediscovered it, making it their headquarters.',
    );
    expect(lines[2]).toBe('Notes:');
    expect(lines.slice(3, 8)).toEqual([
      '1. A large door on the eastern wall.',
      '2. A magic rod locked in a  safe.',
      '3. A broken chest holds gems.',
      '4. A fresco on the wall depicting the landscape around the manor as it looked in the distant past.',
      '5. A hammer tucked under some debris.',
    ]);
    expect(lines.at(-1)).toBe(FLAVOUR_LINE);
  });
});

describe('digestPlaceMap refusals', () => {
  it('refuses a shape that is not a town', () => {
    expect(() => digestPlaceMap('city', {}, CITY_LINK)).toThrow('Not a city map');
  });

  it('refuses a shape that is not a dungeon', () => {
    expect(() => digestPlaceMap('dungeon', { title: 1 }, DUNGEON_LINK)).toThrow('Not a dungeon map');
  });
});
