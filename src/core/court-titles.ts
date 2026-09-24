// Pure table for rulers' family titles and the succession law each kind of realm uses. No state,
// no dice, no I/O; any randomness the caller wants arrives through the passed rng.

export type SuccessionLaw =
  | 'primogeniture_male'
  | 'primogeniture_equal'
  | 'elective'
  | 'conclave'
  | 'republic'
  | 'tanistry'
  | 'council';

export type CourtRole =
  | 'ruler'
  | 'consort'
  | 'heir'
  | 'relative'
  | 'regent'
  | 'dowager'
  | 'elder'
  | 'first_citizen'
  | 'rival';

type Sex = 'male' | 'female';

/** The realm family a court title belongs to, resolved from government and realm kind. */
type CourtRealm =
  | 'kingdom'
  | 'empire'
  | 'principality'
  | 'lordship'
  | 'theocracy'
  | 'merchant_republic'
  | 'free_city'
  | 'tribe'
  | 'league';

const PRIMOGENITURE_MALE_CHANCE = 0.7;

/**
 * The law that decides a realm's next ruler. Only the hereditary branch draws from rng; the
 * elective, conclave, republic and tribal branches are fixed.
 */
export function successionLawFor(
  government: string,
  kind: string,
  council: boolean,
  rng: () => number,
): SuccessionLaw {
  if (kind === 'tribe' || government === 'tribal_confederation') {
    return council ? 'council' : 'tanistry';
  }
  if (government === 'theocracy') return 'conclave';
  if (government === 'merchant_republic' || government === 'free_city' || kind === 'free_city') {
    return 'republic';
  }
  if (government === 'empire' || government === 'league') return 'elective';
  return rng() < PRIMOGENITURE_MALE_CHANCE ? 'primogeniture_male' : 'primogeniture_equal';
}

const SUCCESSION_TEXT: Record<SuccessionLaw, string> = {
  primogeniture_male: 'The crown passes to the eldest son',
  primogeniture_equal: 'The crown passes to the eldest child',
  elective: 'The great lords elect the next ruler',
  conclave: 'A conclave elects the next head of the faith',
  republic: 'The council elects a doge for life',
  tanistry: 'The chief names a tanist from the ruling kin',
  council: 'The elders choose the chief from among themselves',
};

/** One sentence a player reads describing how the realm picks its next ruler. */
export function successionLawText(law: SuccessionLaw): string {
  return SUCCESSION_TEXT[law];
}

function courtRealm(government: string, kind: string, principality: boolean): CourtRealm {
  if (kind === 'tribe' || government === 'tribal_confederation') return 'tribe';
  if (government === 'theocracy') return 'theocracy';
  if (government === 'merchant_republic') return 'merchant_republic';
  if (government === 'free_city' || kind === 'free_city') return 'free_city';
  if (kind === 'lordship') return principality ? 'principality' : 'lordship';
  if (government === 'empire') return 'empire';
  if (government === 'league') return 'league';
  return 'kingdom';
}

const GENERIC: Partial<Record<CourtRole, string>> = {
  regent: 'Regent',
  elder: 'Elder',
  first_citizen: 'First Citizen',
  rival: 'Rival',
};

const genericTitle = (role: CourtRole): string => GENERIC[role] ?? 'Courtier';

function kingdomCourt(role: CourtRole, m: boolean, child: boolean): string {
  switch (role) {
    case 'ruler':
      return m ? 'King' : 'Queen';
    case 'consort':
      return m ? 'Prince consort' : 'Queen consort';
    case 'heir':
      return child ? (m ? 'Crown Prince' : 'Crown Princess') : 'Heir Presumptive';
    case 'relative':
      return m ? 'Prince' : 'Princess';
    case 'dowager':
      return m ? 'Father of the King' : 'Queen Dowager';
    case 'rival':
      return 'Pretender';
    default:
      return genericTitle(role);
  }
}

function empireCourt(role: CourtRole, m: boolean, child: boolean): string {
  switch (role) {
    case 'ruler':
      return m ? 'Emperor' : 'Empress';
    case 'consort':
      return m ? 'Prince consort' : 'Empress consort';
    case 'heir':
      if (!child) return m ? 'Emperor-elect' : 'Empress-elect';
      return m ? 'Imperial Prince' : 'Imperial Princess';
    case 'relative':
      return m ? 'Imperial Prince' : 'Imperial Princess';
    case 'dowager':
      return m ? 'Father of the Emperor' : 'Empress Dowager';
    case 'rival':
      return 'Pretender';
    default:
      return genericTitle(role);
  }
}

function principalityCourt(role: CourtRole, m: boolean): string {
  switch (role) {
    case 'ruler':
      return m ? 'Prince' : 'Princess';
    case 'consort':
      return m ? 'Prince consort' : 'Princess consort';
    case 'heir':
      return m ? 'Hereditary Prince' : 'Hereditary Princess';
    case 'relative':
      return m ? 'Lord' : 'Lady';
    case 'dowager':
      return m ? 'Father of the Prince' : 'Dowager Princess';
    case 'rival':
      return 'Pretender';
    default:
      return genericTitle(role);
  }
}

function lordshipCourt(role: CourtRole, m: boolean): string {
  switch (role) {
    case 'ruler':
      return m ? 'Lord' : 'Lady';
    case 'consort':
      return m ? 'Lord consort' : 'Lady consort';
    case 'heir':
      return 'Heir';
    case 'relative':
      return m ? 'Lord' : 'Lady';
    case 'dowager':
      return m ? 'Father of the Lord' : 'Dowager Lady';
    case 'rival':
      return 'Pretender';
    default:
      return genericTitle(role);
  }
}

function theocracyCourt(role: CourtRole): string {
  switch (role) {
    case 'ruler':
      return 'Pontiff';
    case 'consort':
      return 'Companion';
    case 'heir':
      return 'Cardinal-Designate';
    case 'relative':
      return 'Kin of the Pontiff';
    case 'dowager':
      return 'Dowager Pontiff';
    case 'rival':
      return 'Rival of the Pontiff';
    default:
      return genericTitle(role);
  }
}

function merchantRepublicCourt(role: CourtRole, m: boolean): string {
  switch (role) {
    case 'ruler':
      return m ? 'Doge' : 'Dogaressa';
    case 'consort':
      return m ? 'Consort' : 'Dogaressa';
    case 'heir':
      return 'Doge-in-waiting';
    case 'relative':
      return 'Kin of the Doge';
    case 'dowager':
      return 'Dowager Doge';
    case 'first_citizen':
      return 'First Citizen';
    case 'rival':
      return 'Rival of the Doge';
    default:
      return genericTitle(role);
  }
}

function freeCityCourt(role: CourtRole): string {
  switch (role) {
    case 'ruler':
      return 'Burgomaster';
    case 'consort':
      return 'Consort';
    case 'heir':
      return 'Burgomaster-in-waiting';
    case 'relative':
      return 'Kin of the Burgomaster';
    case 'dowager':
      return 'Dowager Burgomaster';
    case 'first_citizen':
      return 'First Citizen';
    case 'rival':
      return 'Rival of the Burgomaster';
    default:
      return genericTitle(role);
  }
}

function tribeCourt(role: CourtRole, m: boolean, council: boolean): string {
  switch (role) {
    case 'ruler':
      return council ? 'High Elder' : m ? 'Chieftain' : 'Chieftess';
    case 'consort':
      return "Chief's Consort";
    case 'heir':
      return 'Tánaiste';
    case 'relative':
      return 'Kin of the Chief';
    case 'elder':
      return 'Elder';
    case 'dowager':
      return 'Dowager Chief';
    case 'rival':
      return 'Rival of the Chief';
    default:
      return genericTitle(role);
  }
}

function leagueCourt(role: CourtRole): string {
  switch (role) {
    case 'ruler':
      return 'Speaker';
    case 'consort':
      return 'Consort';
    case 'heir':
      return 'Speaker-in-waiting';
    case 'relative':
      return 'Kin of the Speaker';
    case 'dowager':
      return 'Dowager Speaker';
    case 'rival':
      return 'Rival of the Speaker';
    default:
      return genericTitle(role);
  }
}

/**
 * The title a member of a ruler's court or family carries, gendered where the realm distinguishes
 * sexes. `heirIsChild` false means an elected or otherwise non-hereditary heir.
 */
export function courtTitle(input: {
  role: CourtRole;
  government: string;
  kind: string;
  principality?: boolean;
  sex: Sex;
  heirIsChild?: boolean;
  council?: boolean;
}): string {
  const m = input.sex === 'male';
  const child = input.heirIsChild ?? true;
  const council = input.council ?? false;
  switch (courtRealm(input.government, input.kind, input.principality ?? false)) {
    case 'kingdom':
      return kingdomCourt(input.role, m, child);
    case 'empire':
      return empireCourt(input.role, m, child);
    case 'principality':
      return principalityCourt(input.role, m);
    case 'lordship':
      return lordshipCourt(input.role, m);
    case 'theocracy':
      return theocracyCourt(input.role);
    case 'merchant_republic':
      return merchantRepublicCourt(input.role, m);
    case 'free_city':
      return freeCityCourt(input.role);
    case 'tribe':
      return tribeCourt(input.role, m, council);
    case 'league':
      return leagueCourt(input.role);
  }
}
