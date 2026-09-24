// Pure derivation of a realm's government, titles and law from the region map's traits. No state,
// no dice, no I/O; the caller hands in the region name, tags, capital and county count.

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

interface CapitalFlags {
  temple: boolean;
  citadel: boolean;
  walls: boolean;
}

/** Reads the generator link's flags; an unparsable link carries none. */
function capitalFlags(link: string): CapitalFlags {
  if (!URL.canParse(link)) return { temple: false, citadel: false, walls: false };
  const params = new URL(link).searchParams;
  return {
    temple: params.get('temple') === '1',
    citadel: params.get('citadel') === '1' || params.get('urban_castle') === '1',
    walls: params.get('walls') === '1',
  };
}

interface ProfileShape {
  realm_title: string;
  ruler_title: string;
  holder_title: string;
  law: LawFamily;
  succession: GovernmentProfile['succession'];
  naming: 'capital' | 'region_prefix' | 'region_suffix';
}

const PROFILES: Record<Government, ProfileShape> = {
  kingdom: {
    realm_title: 'Kingdom',
    ruler_title: 'Monarch',
    holder_title: 'Count',
    law: 'royal',
    succession: 'hereditary',
    naming: 'capital',
  },
  empire: {
    realm_title: 'Empire',
    ruler_title: 'Emperor',
    holder_title: 'Count',
    law: 'royal',
    succession: 'hereditary',
    naming: 'capital',
  },
  theocracy: {
    realm_title: 'Theocracy',
    ruler_title: 'Pontiff',
    holder_title: 'Bishop',
    law: 'sacred',
    succession: 'appointed',
    naming: 'capital',
  },
  merchant_republic: {
    realm_title: 'Republic',
    ruler_title: 'Doge',
    holder_title: 'Magistrate',
    law: 'commercial',
    succession: 'elected',
    naming: 'capital',
  },
  free_city: {
    realm_title: 'Free City',
    ruler_title: 'Lord Mayor',
    holder_title: 'Alderman',
    law: 'commercial',
    succession: 'elected',
    naming: 'capital',
  },
  tribal_confederation: {
    realm_title: 'Confederation',
    ruler_title: 'High Chief',
    holder_title: 'Chieftain',
    law: 'weregild',
    succession: 'elected',
    naming: 'region_suffix',
  },
  league: {
    realm_title: 'League',
    ruler_title: 'Speaker',
    holder_title: 'Elder',
    law: 'custom',
    succession: 'elected',
    naming: 'region_prefix',
  },
};

export interface GovernmentTitles {
  ruler: string;
  duke: string;
  count: string;
  margrave: string;
  lord: string;
}

const TITLES: Record<Government, GovernmentTitles> = {
  kingdom: { ruler: 'King', duke: 'Duke', count: 'Count', margrave: 'Margrave', lord: 'Lord' },
  empire: { ruler: 'Emperor', duke: 'Duke', count: 'Count', margrave: 'Margrave', lord: 'Lord' },
  league: { ruler: 'Speaker', duke: 'Duke', count: 'Count', margrave: 'Margrave', lord: 'Lord' },
  theocracy: { ruler: 'Pontiff', duke: 'Bishop', count: 'Prior', margrave: 'Warden-Prior', lord: 'Abbot' },
  merchant_republic: {
    ruler: 'Doge',
    duke: 'Governor',
    count: 'Podestà',
    margrave: 'Captain',
    lord: 'Syndic',
  },
  free_city: { ruler: 'Burgomaster', duke: '—', count: 'Alderman', margrave: 'Captain', lord: 'Alderman' },
  tribal_confederation: {
    ruler: 'High Chief',
    duke: 'Chief',
    count: 'Headman',
    margrave: 'War-Chief',
    lord: 'Elder',
  },
};

/** The noble titles a realm of a government uses, from its ruler down to a lord. */
export function titlesFor(government: Government): GovernmentTitles {
  return TITLES[government];
}

/** First matching rule wins, so a temple keeps a city sacred and a citadel keeps it royal. */
function chooseGovernment(input: GovernmentInput, wild: boolean, chaotic: boolean): Government {
  const capital = input.capital;
  if (capital === null) return wild || chaotic ? 'tribal_confederation' : 'league';
  const flags = capitalFlags(capital.link);
  if (flags.temple && !chaotic) return 'theocracy';
  if (capital.coast && !flags.citadel && !wild) {
    return input.county_count <= 1 ? 'free_city' : 'merchant_republic';
  }
  if (wild && chaotic) return 'tribal_confederation';
  if (input.county_count >= 4) return 'empire';
  return 'kingdom';
}

/** Realm names follow the capital's name, falling back to the region when there is no capital. */
function realmName(shape: ProfileShape, capitalName: string | null, regionName: string): string {
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
  const shape = PROFILES[government];
  return {
    government,
    realm_name: realmName(shape, input.capital?.name ?? null, input.region_name),
    realm_title: shape.realm_title,
    ruler_title: shape.ruler_title,
    holder_title: shape.holder_title,
    law: shape.law,
    succession: shape.succession,
  };
}

/** A government token in words a player reads, e.g. merchant_republic → merchant republic. */
export const governmentLabel = (government: string): string => government.replaceAll('_', ' ');
