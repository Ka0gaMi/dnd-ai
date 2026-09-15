import { describe, expect, it } from 'vitest';
import { PRESET_DIAL_IDS, defaultDials, dialWords, findPreset, type ToneDial } from '../src/lib/presets';

/** The six dials GET /api/presets sends, shortened to what these tests need. */
const DIALS: ToneDial[] = [
  { id: 'lethality', name: 'Lethality', levels: ['Heroic', 'Fair', 'Brutal'] },
  { id: 'grimness', name: 'Grimness', levels: ['Bright and hopeful', 'Mixed', 'Bleak'] },
  { id: 'humour', name: 'Humour', levels: ['None', 'Light', 'Frequent'] },
  { id: 'horror', name: 'Horror', levels: ['None', 'Tense', 'Explicit'] },
  { id: 'romance', name: 'Romance', levels: ['None', 'Implied', 'On-screen'] },
  { id: 'moral_greyness', name: 'Moral greyness', levels: ['Clear', 'Some', 'None clean'] },
];

/** The preset ids the server ships; the dial map has to answer for each of them. */
const PRESET_IDS = [
  'classic-high-fantasy',
  'grimdark',
  'gothic-horror',
  'political-intrigue',
  'swashbuckling-pirates',
  'wilderness-frontier',
  'urban-mystery-heist',
  'megadungeon',
  'war-military',
  'planar-weird',
  'fairy-tale',
  'post-apocalyptic',
  'sword-and-sorcery',
  'mythic-epic',
];

describe('preset tone defaults', () => {
  it('has a reading of all six dials for each of the fourteen presets', () => {
    expect([...PRESET_DIAL_IDS].sort()).toEqual([...PRESET_IDS].sort());
    for (const id of PRESET_IDS) {
      const dials = defaultDials(id, DIALS);
      expect(Object.keys(dials).sort()).toEqual(DIALS.map((dial) => dial.id).sort());
      for (const value of Object.values(dials)) expect([1, 2, 3]).toContain(value);
    }
  });

  it('reads the setting: grimdark is bleak but not a meat grinder', () => {
    expect(defaultDials('grimdark', DIALS)).toMatchObject({ grimness: 3, lethality: 2, humour: 1 });
    expect(defaultDials('fairy-tale', DIALS)).toMatchObject({ humour: 3, horror: 1, lethality: 1 });
  });

  it('sits every dial in the middle with no setting', () => {
    expect(defaultDials(null, DIALS)).toEqual({
      lethality: 2,
      grimness: 2,
      humour: 2,
      horror: 2,
      romance: 2,
      moral_greyness: 2,
    });
  });
});

describe('tone words', () => {
  it('names only the dials the story set', () => {
    expect(dialWords(DIALS, { grimness: 3, humour: 1 })).toEqual([
      { id: 'grimness', name: 'Grimness', word: 'Bleak' },
      { id: 'humour', name: 'Humour', word: 'None' },
    ]);
    expect(dialWords(DIALS, undefined)).toEqual([]);
  });
});

describe('finding a preset', () => {
  it('is null for nothing chosen and for an id the server no longer knows', () => {
    const file = { presets: [], tone_dials: DIALS, session_zero_fields: [] };
    expect(findPreset(file, null)).toBeNull();
    expect(findPreset(file, 'grimdark')).toBeNull();
  });
});
