import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveGovernment, titlesFor, type GovernmentInput } from '../src/core/governments.js';

interface RawTown {
  name: string;
  type: 'village' | 'town' | 'city';
  walled: boolean;
  link: string;
}

interface RawRealm {
  name: string;
  bp: { tags: string[] };
  hexes: Record<string, { town?: RawTown }>;
}

const safe = JSON.parse(
  readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8'),
) as RawRealm;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as RawRealm;

function town(raw: RawRealm, name: string): RawTown {
  for (const cell of Object.values(raw.hexes)) {
    if (cell.town?.name === name) return cell.town;
  }
  throw new Error(`fixture has no town named ${name}`);
}

/** Mirrors parseRealm's coastal test: a coast flag or a coast tag on the generator link. */
function coastFromLink(link: string): boolean {
  if (!URL.canParse(link)) return false;
  const params = new URL(link).searchParams;
  if (params.get('coast') === '1') return true;
  return (params.get('tags') ?? '').split(',').includes('coast');
}

function capitalFrom(raw: RawRealm, name: string): NonNullable<GovernmentInput['capital']> {
  const found = town(raw, name);
  return {
    name: found.name,
    size: found.type,
    walled: found.walled,
    coast: coastFromLink(found.link),
    link: found.link,
  };
}

describe('titlesFor', () => {
  it('gives monarchy-like governments king, duke, count, margrave and lord', () => {
    expect(titlesFor('kingdom')).toEqual({
      ruler: 'King',
      duke: 'Duke',
      count: 'Count',
      margrave: 'Margrave',
      lord: 'Lord',
    });
    expect(titlesFor('empire').ruler).toBe('Emperor');
    expect(titlesFor('league')).toEqual({
      ruler: 'Speaker',
      duke: 'Duke',
      count: 'Count',
      margrave: 'Margrave',
      lord: 'Lord',
    });
  });

  it('gives a theocracy its own church titles', () => {
    expect(titlesFor('theocracy')).toEqual({
      ruler: 'Pontiff',
      duke: 'Bishop',
      count: 'Prior',
      margrave: 'Warden-Prior',
      lord: 'Abbot',
    });
  });

  it('gives a merchant republic its commercial titles', () => {
    expect(titlesFor('merchant_republic')).toEqual({
      ruler: 'Doge',
      duke: 'Governor',
      count: 'Podestà',
      margrave: 'Captain',
      lord: 'Syndic',
    });
  });

  it('gives a free city a burgomaster with no duke title', () => {
    expect(titlesFor('free_city')).toEqual({
      ruler: 'Burgomaster',
      duke: '—',
      count: 'Alderman',
      margrave: 'Captain',
      lord: 'Alderman',
    });
  });

  it('gives a tribal confederation its clan titles', () => {
    expect(titlesFor('tribal_confederation')).toEqual({
      ruler: 'High Chief',
      duke: 'Chief',
      count: 'Headman',
      margrave: 'War-Chief',
      lord: 'Elder',
    });
  });
});

describe('deriveGovernment from the fixtures', () => {
  it('makes the temple city Ficengwind a theocracy', () => {
    expect(town(safe, 'Ficengwind').link).toContain('temple=1');
    const profile = deriveGovernment({
      region_name: safe.name,
      region_tags: safe.bp.tags,
      capital: capitalFrom(safe, 'Ficengwind'),
      county_count: 2,
    });
    expect(profile.government).toBe('theocracy');
    expect(profile.realm_name).toBe('Theocracy of Ficengwind');
    expect(profile.ruler_title).toBe('Pontiff');
    expect(profile.law).toBe('sacred');
  });

  it('makes Ta Isle, which has no city, a tribal confederation', () => {
    expect(Object.values(dangerous.hexes).some((cell) => cell.town?.type === 'city')).toBe(false);
    const profile = deriveGovernment({
      region_name: dangerous.name,
      region_tags: dangerous.bp.tags,
      capital: null,
      county_count: 0,
    });
    expect(profile.government).toBe('tribal_confederation');
    expect(profile.realm_name).toBe('Ta Isle Confederation');
    expect(profile.ruler_title).toBe('High Chief');
    expect(profile.law).toBe('weregild');
  });
});

const COASTAL_TOWN: NonNullable<GovernmentInput['capital']> = {
  name: 'Seahaven',
  size: 'town',
  walled: true,
  coast: true,
  link: 'https://watabou.github.io/city-generator/?size=16&seed=1&name=Seahaven&citadel=0&urban_castle=0&walls=1&temple=0&coast=1&from=perilous',
};

const CITADEL_CITY: NonNullable<GovernmentInput['capital']> = {
  name: 'Highspire',
  size: 'city',
  walled: true,
  coast: false,
  link: 'https://watabou.github.io/city-generator/?size=32&seed=2&name=Highspire&citadel=1&urban_castle=1&walls=1&temple=0&coast=0&from=perilous',
};

describe('deriveGovernment on synthetic traits', () => {
  it('makes a lone coastal town a free city', () => {
    const profile = deriveGovernment({
      region_name: 'The Reach',
      region_tags: ['civilized'],
      capital: COASTAL_TOWN,
      county_count: 1,
    });
    expect(profile).toMatchObject({
      government: 'free_city',
      realm_name: 'Free City of Seahaven',
      ruler_title: 'Lord Mayor',
      law: 'commercial',
      succession: 'elected',
    });
  });

  it('makes a coastal town of three counties a merchant republic', () => {
    const profile = deriveGovernment({
      region_name: 'The Reach',
      region_tags: ['civilized'],
      capital: COASTAL_TOWN,
      county_count: 3,
    });
    expect(profile).toMatchObject({
      government: 'merchant_republic',
      realm_name: 'Republic of Seahaven',
      ruler_title: 'Doge',
      law: 'commercial',
    });
  });

  it('makes a citadel city of five counties an empire', () => {
    const profile = deriveGovernment({
      region_name: 'The Marches',
      region_tags: ['lawful'],
      capital: CITADEL_CITY,
      county_count: 5,
    });
    expect(profile).toMatchObject({
      government: 'empire',
      realm_name: 'Empire of Highspire',
      ruler_title: 'Emperor',
      law: 'royal',
      succession: 'hereditary',
    });
  });

  it('makes the same citadel city of two counties a kingdom', () => {
    const profile = deriveGovernment({
      region_name: 'The Marches',
      region_tags: ['lawful'],
      capital: CITADEL_CITY,
      county_count: 2,
    });
    expect(profile).toMatchObject({
      government: 'kingdom',
      realm_name: 'Kingdom of Highspire',
      ruler_title: 'Monarch',
    });
  });

  it('does not make a temple in a chaotic region a theocracy', () => {
    const capital: NonNullable<GovernmentInput['capital']> = {
      name: 'Grimhold',
      size: 'town',
      walled: true,
      coast: false,
      link: 'https://watabou.github.io/city-generator/?size=16&seed=3&name=Grimhold&citadel=0&urban_castle=0&walls=1&temple=1&coast=0&from=perilous',
    };
    const profile = deriveGovernment({
      region_name: 'The Wastes',
      region_tags: ['chaotic'],
      capital,
      county_count: 2,
    });
    expect(profile.government).toBe('kingdom');
  });

  it('keeps a coastal citadel town out of the commercial profiles', () => {
    const capital: NonNullable<GovernmentInput['capital']> = {
      ...COASTAL_TOWN,
      link: 'https://watabou.github.io/city-generator/?size=16&seed=4&name=Seahaven&citadel=1&urban_castle=0&walls=1&temple=0&coast=1&from=perilous',
    };
    const profile = deriveGovernment({
      region_name: 'The Reach',
      region_tags: ['lawful'],
      capital,
      county_count: 1,
    });
    expect(profile.government).toBe('kingdom');
  });

  it('prefers a tribal confederation over an empire in a wild chaotic region', () => {
    const profile = deriveGovernment({
      region_name: 'The Wilds',
      region_tags: ['wild', 'chaotic'],
      capital: CITADEL_CITY,
      county_count: 6,
    });
    expect(profile.government).toBe('tribal_confederation');
    expect(profile.realm_name).toBe('The Wilds Confederation');
  });

  it('makes a capital-less lawful region a league', () => {
    const profile = deriveGovernment({
      region_name: 'The Concord',
      region_tags: ['lawful', 'civilized'],
      capital: null,
      county_count: 3,
    });
    expect(profile).toMatchObject({
      government: 'league',
      realm_name: 'League of The Concord',
      ruler_title: 'Speaker',
      law: 'custom',
      succession: 'elected',
    });
  });

  it('treats a malformed capital link as having no flags', () => {
    const input: GovernmentInput = {
      region_name: 'The Backwoods',
      region_tags: ['civilized', 'lawful'],
      capital: { name: 'Nowhere', size: 'village', walled: false, coast: false, link: 'not a url at all' },
      county_count: 1,
    };
    expect(() => deriveGovernment(input)).not.toThrow();
    expect(deriveGovernment(input).government).toBe('kingdom');
  });
});
