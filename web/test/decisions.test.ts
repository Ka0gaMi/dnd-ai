import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import DecisionDialog from '../src/components/DecisionDialog.svelte';
import {
  DecisionStore,
  buildDecisionEdit,
  decisionNumericFields,
  decisionTitle,
  type DecisionResult,
  type HomebrewSpellPayload,
  type HomebrewSubclassPayload,
  type PendingDecision,
} from '../src/lib/decisions.svelte';
import type { PowerReport } from '../src/lib/progression';

const report = (verdict: PowerReport['verdict'] = 'within'): PowerReport => ({
  budget_used: verdict === 'within' ? 0.5 : 2,
  budget_allowed: 1,
  items: [{ part: '+1 to hit', cost: 0.5, rule: 'Every +1 to hit costs 0.5.' }],
  verdict,
  text: 'Power budget: 0.5 of 1 (within budget).',
});

const asked = (id = 1, extra: Partial<PendingDecision> = {}): PendingDecision => ({
  id,
  campaign_id: 1,
  kind: 'homebrew_feature',
  payload: {
    name: 'Trapwright',
    text: 'You rig a trap in a minute flat.',
    mechanics: { to_hit: 1, ac: 1 },
    justification: 'They have rigged something in every room so far.',
    report: report(),
    character_id: 4,
  },
  created_at: '2026-09-11T10:00:00.000Z',
  resolved_at: null,
  ...extra,
});

const answered = (decision: DecisionResult['decision']): DecisionResult => ({
  decision,
  summary: `Player ${decision === 'reject' ? 'rejected' : 'accepted'} "Trapwright".`,
  applied: decision !== 'reject',
  name: 'Trapwright',
  power_label: 'within',
  ...(decision === 'reject' ? {} : { homebrew_id: 9 }),
});

describe('the decision dialog', () => {
  it('names the card after the kind and what is on offer', () => {
    expect(decisionTitle(asked())).toBe('The DM proposes: Trapwright');
    expect(decisionTitle(asked(2, { kind: 'something_new' }))).toBe('The DM asks about: Trapwright');
  });

  it('queues the open questions oldest first, without duplicates or answered ones', () => {
    const decisions = new DecisionStore();
    decisions.add(asked(3));
    decisions.add(asked(3));
    decisions.setOpen([asked(1), asked(3), asked(4, { resolved_at: '2026-09-11T10:01:00.000Z' })]);
    expect(decisions.queue.map((row) => row.id)).toEqual([1, 3]);
    expect(decisions.current?.id).toBe(1);
  });

  it('accepts one and moves on to the next', () => {
    const decisions = new DecisionStore();
    decisions.setOpen([asked(1), asked(2)]);
    decisions.start();
    expect(decisions.busy).toBe(true);
    decisions.showResult(answered('accept'));
    expect(decisions.phase).toBe('answered');
    expect(decisions.busy).toBe(false);
    expect(decisions.note).toBe('Player accepted "Trapwright".');
    decisions.dismiss();
    expect(decisions.current?.id).toBe(2);
    expect(decisions.phase).toBe('asking');
    expect(decisions.note).toBeNull();
  });

  it('records a rejection the same way and leaves nothing behind', () => {
    const decisions = new DecisionStore();
    decisions.add(asked(1));
    decisions.showResult(answered('reject'));
    expect(decisions.result?.applied).toBe(false);
    decisions.dismiss();
    expect(decisions.current).toBeNull();
    expect(decisions.result).toBeNull();
  });

  it('opens the numbers for editing at what the DM proposed, and closes them again', () => {
    const decisions = new DecisionStore();
    decisions.add(asked(1));
    decisions.startEdit();
    expect(decisions.phase).toBe('editing');
    expect(decisions.edit).toEqual({ to_hit: '1', ac: '1' });
    decisions.edit.to_hit = '2';
    decisions.cancelEdit();
    expect(decisions.phase).toBe('asking');
    expect(decisions.edit).toEqual({});
  });

  it('says so when a 409 means it was answered elsewhere', () => {
    const decisions = new DecisionStore();
    decisions.add(asked(1));
    decisions.start();
    decisions.alreadyAnswered();
    expect(decisions.phase).toBe('answered');
    expect(decisions.result).toBeNull();
    expect(decisions.note).toBe('Already answered.');
  });

  it('keeps the card after the DM stops waiting, so a late answer still counts', () => {
    const decisions = new DecisionStore();
    decisions.add(asked(1));
    decisions.markTimedOut();
    expect(decisions.timedOut).toBe(true);
    expect(decisions.current?.id).toBe(1);
    expect(decisions.phase).toBe('asking');
    decisions.showResult(answered('edit'));
    expect(decisions.result?.decision).toBe('edit');
    decisions.dismiss();
    expect(decisions.timedOut).toBe(false);
  });

  it('shows a failure without losing the question', () => {
    const decisions = new DecisionStore();
    decisions.add(asked(1));
    decisions.start();
    decisions.fail('decisions -> 500');
    expect(decisions.error).toBe('decisions -> 500');
    expect(decisions.busy).toBe(false);
    expect(decisions.current?.id).toBe(1);
  });

  it('drops every open question when the player switches story', () => {
    const decisions = new DecisionStore();
    decisions.setOpen([asked(1), asked(2)]);
    decisions.clear();
    expect(decisions.queue).toEqual([]);
    expect(decisions.current).toBeNull();
  });
});

const subclassPayload = (): HomebrewSubclassPayload => ({
  schema: {
    class: 'Fighter',
    name: 'Trapsmith',
    flavour_text: 'A fighter who trusts steel and springs over spells.',
    features: {
      '3': [{ name: 'Rigged Reflexes', text: 'You act first.', mechanics: { to_hit: 1 } }],
      '6': [],
      '10': [],
      '14': [],
    },
  },
  justification: 'They love a good trap.',
  report: { bundles: [{ level: 3, budget_used: 0.5, budget_allowed: 1, items: [], verdict: 'within' }] },
  character_id: 4,
});

const spellPayload = (): HomebrewSpellPayload => ({
  schema: {
    name: 'Starfall Bolt',
    level: 2,
    school: 'Evocation',
    casting_time: '1 action',
    range: '60 ft',
    components: 'V, S',
    duration: 'Instantaneous',
    concentration: false,
    ritual: false,
    effect: { kind: 'damage', damage: '3d6 radiant', targets: 1 },
    text: 'A mote of starlight streaks toward its target.',
  },
  justification: 'The story called for something celestial.',
  report: report(),
  character_id: 4,
});

describe('a homebrew subclass decision', () => {
  it('names itself after the kind and the schema', () => {
    const decision = asked(1, { kind: 'homebrew_subclass', payload: subclassPayload() });
    expect(decisionTitle(decision)).toBe('The DM proposes a subclass: Trapsmith');
  });

  it('flattens the mechanics of every feature across every bundle for the Edit form', () => {
    const decision = asked(1, { kind: 'homebrew_subclass', payload: subclassPayload() });
    expect(decisionNumericFields(decision)).toEqual([
      { key: '3.0.to_hit', label: 'Rigged Reflexes — To hit', value: 1, min: 0, max: 5 },
    ]);
  });

  it('splits the typed edit back out to the feature it came from', () => {
    const decision = asked(1, { kind: 'homebrew_subclass', payload: subclassPayload() });
    const built = buildDecisionEdit(decision, { '3.0.to_hit': '2' });
    expect(built).toEqual({
      edits: {
        schema: {
          ...subclassPayload().schema,
          features: {
            ...subclassPayload().schema.features,
            '3': [{ name: 'Rigged Reflexes', text: 'You act first.', mechanics: { to_hit: 2 } }],
          },
        },
      },
    });
  });
});

describe('a homebrew spell decision', () => {
  it('names itself after the kind and the schema', () => {
    const decision = asked(1, { kind: 'homebrew_spell', payload: spellPayload() });
    expect(decisionTitle(decision)).toBe('The DM proposes a spell: Starfall Bolt');
  });

  it('offers only the numeric fields in the spell\'s effect', () => {
    const decision = asked(1, { kind: 'homebrew_spell', payload: spellPayload() });
    expect(decisionNumericFields(decision)).toEqual([
      { key: 'effect.targets', label: 'Targets', value: 1, min: 1, max: 20 },
    ]);
  });

  it('edits the effect back in and refuses a number outside its bounds', () => {
    const decision = asked(1, { kind: 'homebrew_spell', payload: spellPayload() });
    const built = buildDecisionEdit(decision, { 'effect.targets': '3' });
    expect(built).toEqual({
      edits: { schema: { ...spellPayload().schema, effect: { ...spellPayload().schema.effect, targets: 3 } } },
    });
    expect(buildDecisionEdit(decision, { 'effect.targets': '0' })).toEqual({
      error: 'Targets: a whole number from 1 to 20.',
    });
  });
});

describe('the dialog says what the engine will do with each clause', () => {
  /** What a newer server sends beside the payload: the same words the Library shows. */
  const clauseStatus = [
    { describe: 'when you hit: +1 damage', status: 'runs', reasons: [] },
    {
      describe: 'when you take damage: a ward absorbs it',
      status: 'reminds',
      reasons: ['a ward is not modelled: the engine has no seam for temporary hit points there'],
    },
  ];

  const withClauses = (sent: unknown, kind = 'homebrew_feature'): PendingDecision =>
    asked(1, {
      kind,
      payload: { ...(asked().payload as object), clause_status: sent } as unknown as PendingDecision['payload'],
    });

  const shown = (decision: PendingDecision): string => {
    const decisions = new DecisionStore();
    decisions.add(decision);
    return render(DecisionDialog, { props: { decisions, timeoutS: 60, onresolved: () => undefined } }).body;
  };

  it('shows each clause with its status and the server\'s reason', () => {
    const body = shown(withClauses(clauseStatus));
    expect(body).toContain('Runs');
    expect(body).toContain('Reminder');
    expect(body).toContain('when you take damage: a ward absorbs it');
    expect(body).toContain('a ward is not modelled: the engine has no seam for temporary hit points there');
  });

  it('claims nothing about a clause the server sent no status for', () => {
    const body = shown(asked());
    expect(body).not.toContain('Runs');
    expect(body).not.toContain('Reminder');
    expect(body).not.toContain('Clause status');
  });

  it('survives a server that sends the field in a shape it does not recognise', () => {
    const body = shown(withClauses('clauses run in the order they are written'));
    expect(body).not.toContain('Clause status');
  });
});
