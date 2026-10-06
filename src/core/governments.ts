// Pure derivation of a realm's government, titles and law from the region map's traits. No state,
// no dice, no I/O; the caller hands in the region name, tags, capital, county count and its own draws.

export type Government =
  | 'kingdom'
  | 'empire'
  | 'theocracy'
  | 'merchant_republic'
  | 'free_city'
  | 'tribal_confederation'
  | 'league';

export type LawFamily = 'royal' | 'sacred' | 'commercial' | 'weregild' | 'custom';

export interface GovernmentInput {
  region_name: string;
  region_tags: string[];
  capital: {
    name: string;
    size: 'village' | 'town' | 'city';
    walled: boolean;
    coast: boolean;
    link: string;
  } | null;
  county_count: number;
  /** True for the one realm whose capital the region drew as its holy city. */
  holy_city: boolean;
  /** True on an XL map (4800 wide or more), where a large realm may be an empire. */
  xl: boolean;
  /** True for a realm seated beyond the map, which may be an empire on any map. */
  off_map: boolean;
}

export interface GovernmentProfile {
  government: Government;
  realm_name: string;
  realm_title: string;
  ruler_title: string;
  holder_title: string;
  law: LawFamily;
  succession: 'hereditary' | 'elected' | 'appointed';
}

/** Reads the generator link's citadel flag; an unparsable link carries none. */
function hasCitadel(link: string): boolean {
  if (!URL.canParse(link)) return false;
  const params = new URL(link).searchParams;
  return params.get('citadel') === '1' || params.get('urban_castle') === '1';
}

export interface GovernmentTitles {
  ruler: string;
  duke: string;
  count: string;
  margrave: string;
  lord: string;
}

/** The rank a noble house holds, which picks the style its name takes. */
export type HouseRank = 'duke' | 'count' | 'margrave';

interface GovernmentShape extends GovernmentTitles {
  realm_title: string;
  houses: Record<HouseRank, string>;
  law: LawFamily;
  succession: GovernmentProfile['succession'];
  naming: 'capital' | 'region_prefix' | 'region_suffix';
}

const FEUDAL_HOUSES: Record<HouseRank, string> = {
  duke: 'Ducal House of',
  count: 'House of',
  margrave: 'Margraves of',
};

/** The one title table; ruler wording follows the court titles, and a theocracy's sees are never ducal or marcher. */
const GOVERNMENTS: Record<Government, GovernmentShape> = {
  kingdom: {
    realm_title: 'Kingdom',
    ruler: 'King',
    duke: 'Duke',
    count: 'Count',
    margrave: 'Margrave',
    lord: 'Lord',
    houses: FEUDAL_HOUSES,
    law: 'royal',
    succession: 'hereditary',
    naming: 'capital',
  },
  empire: {
    realm_title: 'Empire',
    ruler: 'Emperor',
    duke: 'Duke',
    count: 'Count',
    margrave: 'Margrave',
    lord: 'Lord',
    houses: FEUDAL_HOUSES,
    law: 'royal',
    succession: 'hereditary',
    naming: 'capital',
  },
  theocracy: {
    realm_title: 'Theocracy',
    ruler: 'Pontiff',
    duke: 'Archbishop',
    count: 'Bishop',
    margrave: 'Bishop',
    lord: 'Abbot',
    houses: { duke: 'Archbishopric of', count: 'Bishopric of', margrave: 'Bishopric of' },
    law: 'sacred',
    succession: 'appointed',
    naming: 'capital',
  },
  merchant_republic: {
    realm_title: 'Republic',
    ruler: 'Doge',
    duke: 'Governor',
    count: 'Magistrate',
    margrave: 'Captain',
    lord: 'Syndic',
    houses: { duke: 'Magistracy of', count: 'Magistracy of', margrave: 'Magistracy of' },
    law: 'commercial',
    succession: 'elected',
    naming: 'capital',
  },
  free_city: {
    realm_title: 'Free City',
    ruler: 'Burgomaster',
    duke: '—',
    count: 'Alderman',
    margrave: 'Captain',
    lord: 'Alderman',
    houses: { duke: 'Magistracy of', count: 'Magistracy of', margrave: 'Magistracy of' },
    law: 'commercial',
    succession: 'elected',
    naming: 'capital',
  },
  tribal_confederation: {
    realm_title: 'Confederation',
    ruler: 'Chieftain',
    duke: 'Chief',
    count: 'Headman',
    margrave: 'War-Chief',
    lord: 'Elder',
    houses: { duke: 'Clan of', count: 'Clan of', margrave: 'Clan of' },
    law: 'weregild',
    succession: 'elected',
    naming: 'region_suffix',
  },
  league: {
    realm_title: 'League',
    ruler: 'Speaker',
    duke: 'Elder',
    count: 'Elder',
    margrave: 'Elder',
    lord: 'Elder',
    houses: { duke: 'Elders of', count: 'Elders of', margrave: 'Elders of' },
    law: 'custom',
    succession: 'elected',
    naming: 'region_prefix',
  },
};

/** The noble titles a realm of a government uses, from its ruler down to a lord. */
export function titlesFor(government: Government): GovernmentTitles {
  const { ruler, duke, count, margrave, lord } = GOVERNMENTS[government];
  return { ruler, duke, count, margrave, lord };
}

/** A noble house's name under a government, e.g. a kingdom's march gives "Margraves of Redfield". */
export function houseName(government: Government, rank: HouseRank, seat: string): string {
  return `${GOVERNMENTS[government].houses[rank]} ${seat}`;
}

/** First matching rule wins, so a holy city stays sacred and a citadel keeps a coastal capital royal. */
function chooseGovernment(input: GovernmentInput, wild: boolean, chaotic: boolean): Government {
  const capital = input.capital;
  if (capital === null) return wild || chaotic ? 'tribal_confederation' : 'league';
  if (input.holy_city && !chaotic) return 'theocracy';
  if (capital.coast && !hasCitadel(capital.link) && !wild) {
    return input.county_count <= 1 ? 'free_city' : 'merchant_republic';
  }
  if (wild && chaotic) return 'tribal_confederation';
  if ((input.xl || input.off_map) && input.county_count >= 4) return 'empire';
  return 'kingdom';
}

/** Realm names follow the capital's name, falling back to the region when there is no capital. */
function realmName(shape: GovernmentShape, capitalName: string | null, regionName: string): string {
  switch (shape.naming) {
    case 'region_prefix':
      return `${shape.realm_title} of ${regionName}`;
    case 'region_suffix':
      return `${regionName} ${shape.realm_title}`;
    default:
      return `${shape.realm_title} of ${capitalName ?? regionName}`;
  }
}

export function deriveGovernment(input: GovernmentInput): GovernmentProfile {
  const tags = new Set(input.region_tags);
  const government = chooseGovernment(input, tags.has('wild'), tags.has('chaotic'));
  const shape = GOVERNMENTS[government];
  return {
    government,
    realm_name: realmName(shape, input.capital?.name ?? null, input.region_name),
    realm_title: shape.realm_title,
    ruler_title: shape.ruler,
    holder_title: shape.count,
    law: shape.law,
    succession: shape.succession,
  };
}

/** A government token in words a player reads, e.g. merchant_republic → merchant republic. */
export const governmentLabel = (government: string): string => government.replaceAll('_', ' ');
