import { describe, expect, it } from 'vitest';
import {
  courtTitle,
  successionLawFor,
  successionLawText,
  type CourtRole,
  type SuccessionLaw,
} from '../src/core/court-titles.js';

const ROLES: CourtRole[] = [
  'ruler',
  'consort',
  'heir',
  'relative',
  'regent',
  'dowager',
  'elder',
  'first_citizen',
  'rival',
];

const SEXES = ['male', 'female'] as const;

const LAWS: SuccessionLaw[] = [
  'primogeniture_male',
  'primogeniture_equal',
  'elective',
  'conclave',
  'republic',
  'tanistry',
  'council',
];

/** One representative of every realm family courtTitle can resolve to. */
const SCENARIOS: Array<{
  label: string;
  government: string;
  kind: string;
  principality?: boolean;
  council?: boolean;
}> = [
  { label: 'kingdom', government: 'kingdom', kind: 'kingdom' },
  { label: 'lordship', government: 'kingdom', kind: 'lordship' },
  { label: 'principality', government: 'kingdom', kind: 'lordship', principality: true },
  { label: 'empire', government: 'empire', kind: 'kingdom' },
  { label: 'theocracy', government: 'theocracy', kind: 'kingdom' },
  { label: 'merchant_republic', government: 'merchant_republic', kind: 'kingdom' },
  { label: 'free_city', government: 'free_city', kind: 'free_city' },
  { label: 'tribe', government: 'tribal_confederation', kind: 'tribe' },
  { label: 'tribe (council)', government: 'tribal_confederation', kind: 'tribe', council: true },
  { label: 'league', government: 'league', kind: 'kingdom' },
  { label: 'unknown government', government: 'unknown', kind: 'kingdom' },
];

describe('courtTitle coverage', () => {
  it('returns a non-empty string for every role, realm, sex and heir kind', () => {
    for (const scenario of SCENARIOS) {
      for (const role of ROLES) {
        for (const sex of SEXES) {
          for (const heirIsChild of [true, false]) {
            const title = courtTitle({
              role,
              government: scenario.government,
              kind: scenario.kind,
              principality: scenario.principality,
              sex,
              heirIsChild,
              council: scenario.council,
            });
            expect(typeof title, `${scenario.label} ${role} ${sex}`).toBe('string');
            expect(title.length, `${scenario.label} ${role} ${sex}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

describe('courtTitle examples', () => {
  it('titles a kingdom court', () => {
    expect(courtTitle({ role: 'ruler', government: 'kingdom', kind: 'kingdom', sex: 'male' })).toBe(
      'King',
    );
    expect(courtTitle({ role: 'ruler', government: 'kingdom', kind: 'kingdom', sex: 'female' })).toBe(
      'Queen',
    );
    expect(
      courtTitle({ role: 'consort', government: 'kingdom', kind: 'kingdom', sex: 'female' }),
    ).toBe('Queen consort');
    expect(courtTitle({ role: 'consort', government: 'kingdom', kind: 'kingdom', sex: 'male' })).toBe(
      'Prince consort',
    );
    expect(courtTitle({ role: 'heir', government: 'kingdom', kind: 'kingdom', sex: 'male' })).toBe(
      'Crown Prince',
    );
    expect(courtTitle({ role: 'heir', government: 'kingdom', kind: 'kingdom', sex: 'female' })).toBe(
      'Crown Princess',
    );
    expect(
      courtTitle({
        role: 'heir',
        government: 'kingdom',
        kind: 'kingdom',
        sex: 'male',
        heirIsChild: false,
      }),
    ).toBe('Heir Presumptive');
    expect(
      courtTitle({ role: 'relative', government: 'kingdom', kind: 'kingdom', sex: 'female' }),
    ).toBe('Princess');
    expect(
      courtTitle({ role: 'dowager', government: 'kingdom', kind: 'kingdom', sex: 'female' }),
    ).toBe('Queen Dowager');
    expect(courtTitle({ role: 'dowager', government: 'kingdom', kind: 'kingdom', sex: 'male' })).toBe(
      'Father of the King',
    );
    expect(courtTitle({ role: 'regent', government: 'kingdom', kind: 'kingdom', sex: 'male' })).toBe(
      'Regent',
    );
  });

  it('titles an empire court and its elected heir', () => {
    expect(courtTitle({ role: 'ruler', government: 'empire', kind: 'kingdom', sex: 'male' })).toBe(
      'Emperor',
    );
    expect(courtTitle({ role: 'ruler', government: 'empire', kind: 'kingdom', sex: 'female' })).toBe(
      'Empress',
    );
    expect(courtTitle({ role: 'heir', government: 'empire', kind: 'kingdom', sex: 'male' })).toBe(
      'Imperial Prince',
    );
    expect(courtTitle({ role: 'heir', government: 'empire', kind: 'kingdom', sex: 'female' })).toBe(
      'Imperial Princess',
    );
    expect(
      courtTitle({
        role: 'heir',
        government: 'empire',
        kind: 'kingdom',
        sex: 'male',
        heirIsChild: false,
      }),
    ).toBe('Emperor-elect');
    expect(
      courtTitle({ role: 'relative', government: 'empire', kind: 'kingdom', sex: 'female' }),
    ).toBe('Imperial Princess');
  });

  it('titles a principality distinctly from a plain lordship', () => {
    expect(
      courtTitle({
        role: 'ruler',
        government: 'kingdom',
        kind: 'lordship',
        principality: true,
        sex: 'female',
      }),
    ).toBe('Princess');
    expect(
      courtTitle({
        role: 'heir',
        government: 'kingdom',
        kind: 'lordship',
        principality: true,
        sex: 'male',
      }),
    ).toBe('Hereditary Prince');
    expect(
      courtTitle({
        role: 'relative',
        government: 'kingdom',
        kind: 'lordship',
        principality: true,
        sex: 'female',
      }),
    ).toBe('Lady');
    expect(courtTitle({ role: 'ruler', government: 'kingdom', kind: 'lordship', sex: 'male' })).toBe(
      'Lord',
    );
    expect(courtTitle({ role: 'heir', government: 'kingdom', kind: 'lordship', sex: 'male' })).toBe(
      'Heir',
    );
    expect(
      courtTitle({ role: 'consort', government: 'kingdom', kind: 'lordship', sex: 'male' }),
    ).toBe('Lord consort');
  });

  it('titles a theocracy with church roles and no consort', () => {
    expect(courtTitle({ role: 'ruler', government: 'theocracy', kind: 'kingdom', sex: 'male' })).toBe(
      'Pontiff',
    );
    expect(
      courtTitle({ role: 'ruler', government: 'theocracy', kind: 'kingdom', sex: 'female' }),
    ).toBe('Pontiff');
    expect(
      courtTitle({ role: 'consort', government: 'theocracy', kind: 'kingdom', sex: 'female' }),
    ).toBe('Companion');
    expect(courtTitle({ role: 'heir', government: 'theocracy', kind: 'kingdom', sex: 'male' })).toBe(
      'Cardinal-Designate',
    );
    expect(
      courtTitle({ role: 'relative', government: 'theocracy', kind: 'kingdom', sex: 'female' }),
    ).toBe('Kin of the Pontiff');
  });

  it('titles a merchant republic', () => {
    expect(
      courtTitle({ role: 'ruler', government: 'merchant_republic', kind: 'kingdom', sex: 'male' }),
    ).toBe('Doge');
    expect(
      courtTitle({ role: 'ruler', government: 'merchant_republic', kind: 'kingdom', sex: 'female' }),
    ).toBe('Dogaressa');
    expect(
      courtTitle({ role: 'consort', government: 'merchant_republic', kind: 'kingdom', sex: 'female' }),
    ).toBe('Dogaressa');
    expect(
      courtTitle({ role: 'consort', government: 'merchant_republic', kind: 'kingdom', sex: 'male' }),
    ).toBe('Consort');
    expect(
      courtTitle({
        role: 'first_citizen',
        government: 'merchant_republic',
        kind: 'kingdom',
        sex: 'male',
      }),
    ).toBe('First Citizen');
    expect(
      courtTitle({ role: 'rival', government: 'merchant_republic', kind: 'kingdom', sex: 'male' }),
    ).toBe('Rival of the Doge');
    expect(
      courtTitle({ role: 'heir', government: 'merchant_republic', kind: 'kingdom', sex: 'male' }),
    ).toBe('Doge-in-waiting');
  });

  it('titles a free city', () => {
    expect(courtTitle({ role: 'ruler', government: 'free_city', kind: 'free_city', sex: 'male' })).toBe(
      'Burgomaster',
    );
    expect(
      courtTitle({ role: 'ruler', government: 'free_city', kind: 'free_city', sex: 'female' }),
    ).toBe('Burgomaster');
    expect(
      courtTitle({ role: 'first_citizen', government: 'free_city', kind: 'free_city', sex: 'male' }),
    ).toBe('First Citizen');
    expect(courtTitle({ role: 'rival', government: 'free_city', kind: 'free_city', sex: 'male' })).toBe(
      'Rival of the Burgomaster',
    );
  });

  it('titles a tribe, with a high elder when it keeps a council', () => {
    expect(
      courtTitle({ role: 'ruler', government: 'tribal_confederation', kind: 'tribe', sex: 'male' }),
    ).toBe('Chieftain');
    expect(
      courtTitle({ role: 'ruler', government: 'tribal_confederation', kind: 'tribe', sex: 'female' }),
    ).toBe('Chieftess');
    expect(
      courtTitle({
        role: 'ruler',
        government: 'tribal_confederation',
        kind: 'tribe',
        sex: 'male',
        council: true,
      }),
    ).toBe('High Elder');
    expect(
      courtTitle({ role: 'heir', government: 'tribal_confederation', kind: 'tribe', sex: 'male' }),
    ).toBe('Tánaiste');
    expect(
      courtTitle({ role: 'elder', government: 'tribal_confederation', kind: 'tribe', sex: 'female' }),
    ).toBe('Elder');
    expect(
      courtTitle({ role: 'consort', government: 'tribal_confederation', kind: 'tribe', sex: 'female' }),
    ).toBe("Chief's Consort");
    expect(
      courtTitle({ role: 'relative', government: 'tribal_confederation', kind: 'tribe', sex: 'male' }),
    ).toBe('Kin of the Chief');
  });
});

describe('successionLawFor', () => {
  const never = (): number => {
    throw new Error('rng must not be called');
  };

  it('gives kingdoms and lordships male or equal primogeniture from rng', () => {
    expect(successionLawFor('kingdom', 'kingdom', false, () => 0)).toBe('primogeniture_male');
    expect(successionLawFor('kingdom', 'kingdom', false, () => 0.69)).toBe('primogeniture_male');
    expect(successionLawFor('kingdom', 'kingdom', false, () => 0.7)).toBe('primogeniture_equal');
    expect(successionLawFor('kingdom', 'kingdom', false, () => 0.99)).toBe('primogeniture_equal');
    expect(successionLawFor('kingdom', 'lordship', false, () => 0.2)).toBe('primogeniture_male');
  });

  it('is deterministic for a given rng', () => {
    const first = successionLawFor('kingdom', 'kingdom', false, () => 0.5);
    const second = successionLawFor('kingdom', 'kingdom', false, () => 0.5);
    expect(first).toBe(second);
    expect(first).toBe('primogeniture_male');
  });

  it('maps the fixed governments without touching rng', () => {
    expect(successionLawFor('empire', 'kingdom', false, never)).toBe('elective');
    expect(successionLawFor('league', 'kingdom', false, never)).toBe('elective');
    expect(successionLawFor('theocracy', 'kingdom', false, never)).toBe('conclave');
    expect(successionLawFor('merchant_republic', 'kingdom', false, never)).toBe('republic');
    expect(successionLawFor('free_city', 'free_city', false, never)).toBe('republic');
  });

  it('chooses council or tanistry for tribes', () => {
    expect(successionLawFor('tribal_confederation', 'tribe', false, never)).toBe('tanistry');
    expect(successionLawFor('tribal_confederation', 'tribe', true, never)).toBe('council');
    expect(successionLawFor('kingdom', 'tribe', true, never)).toBe('council');
    expect(successionLawFor('kingdom', 'tribe', false, never)).toBe('tanistry');
  });
});

describe('successionLawText', () => {
  it('describes every law in one non-empty sentence', () => {
    for (const law of LAWS) {
      const text = successionLawText(law);
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    }
    expect(successionLawText('primogeniture_male')).toBe('The crown passes to the eldest son');
    expect(successionLawText('primogeniture_equal')).toBe('The crown passes to the eldest child');
    expect(successionLawText('elective')).toBe('The great lords elect the next ruler');
    expect(successionLawText('conclave')).toBe('A conclave elects the next head of the faith');
    expect(successionLawText('republic')).toBe('The council elects a doge for life');
    expect(successionLawText('tanistry')).toBe('The chief names a tanist from the ruling kin');
    expect(successionLawText('council')).toBe('The elders choose the chief from among themselves');
  });
});
