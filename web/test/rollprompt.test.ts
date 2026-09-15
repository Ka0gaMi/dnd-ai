import { describe, expect, it } from 'vitest';
import {
  RollPromptStore,
  editedTotal,
  expressionDice,
  keptDice,
  modifierText,
  rollContext,
  rollLabel,
  secondsLeft,
  stepLabel,
} from '../src/lib/rollprompt.svelte';
import type { PendingRoll, RollResult } from '../src/lib/types';

const pending = (id = 1): PendingRoll => ({
  id,
  campaign_id: 1,
  expr: '1d20+5',
  purpose: 'Stealth check',
  dc: 12,
  roll_type: 'check',
  advantage: 'none',
  created_at: '2026-09-11T10:00:00.000Z',
  resolved_at: null,
});

const rolled = (total: number, natural: number | null = null): RollResult => ({
  id: 7,
  purpose: 'Stealth check',
  expr: '1d20+5',
  total,
  output: `1d20+5: [${total - 5}]+5 = ${total}`,
  groups: [{ value: total - 5, dice: [{ value: total - 5, modifiers: [] }] }],
  natural_d20: natural,
  natural,
  dc: 12,
  outcome: total >= 12 ? 'success' : 'failure',
});

describe('roll prompt', () => {
  it('queues what the DM is waiting on, newest last, without duplicates', () => {
    const prompt = new RollPromptStore();
    prompt.add(pending(1));
    prompt.add(pending(1));
    prompt.add(pending(2));
    prompt.setOpen([pending(2), pending(3), { ...pending(4), resolved_at: '2026-09-11T10:01:00.000Z' }]);
    expect(prompt.queue.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(prompt.current?.id).toBe(1);
  });

  it('shows the cards in the order they were asked for, one at a time', () => {
    const prompt = new RollPromptStore();
    prompt.add(pending(7));
    prompt.setOpen([pending(5), pending(6)]);
    prompt.add(pending(2));
    expect(prompt.queue.map((row) => row.id)).toEqual([2, 5, 6, 7]);
    expect(prompt.current?.id).toBe(2);

    prompt.showResult(rolled(11));
    prompt.dismiss();
    expect(prompt.current?.id).toBe(5);
    expect(prompt.phase).toBe('waiting');
  });

  it("replaces the waiting card with the server's boosted roll", () => {
    const prompt = new RollPromptStore();
    prompt.add(pending());
    prompt.updateCurrent({
      ...pending(),
      expr: '1d20+7',
      advantage: 'advantage',
      boosts_available: [],
      boosts_chosen: ['homebrew:focus'],
    });
    expect(prompt.current).toMatchObject({
      expr: '1d20+7',
      advantage: 'advantage',
      boosts_chosen: ['homebrew:focus'],
    });

    prompt.updateCurrent({ ...pending(2), expr: '1d20+9' });
    expect(prompt.current?.expr).toBe('1d20+7');
  });

  it('clears the busy flag once a chosen boost has landed on the card', () => {
    const prompt = new RollPromptStore();
    prompt.add(pending());
    prompt.start();
    expect(prompt.busy).toBe(true);
    prompt.boosted({
      ...pending(),
      expr: '1d20+5',
      boosts_available: [],
      boosts_chosen: ['homebrew:focus'],
    });
    expect(prompt.busy).toBe(false);
    expect(prompt.current?.boosts_chosen).toEqual(['homebrew:focus']);
  });

  it('goes from the ask to the result and collapses into the ledger', () => {
    const prompt = new RollPromptStore();
    prompt.add(pending());
    expect(prompt.phase).toBe('waiting');
    prompt.start();
    expect(prompt.busy).toBe(true);
    prompt.showResult(rolled(17));
    expect(prompt.phase).toBe('resolved');
    expect(prompt.result?.total).toBe(17);
    expect(prompt.busy).toBe(false);

    prompt.dismiss();
    expect(prompt.current).toBeNull();
    expect(prompt.phase).toBe('waiting');
    expect(prompt.result).toBeNull();
  });

  it('shows the previewed dice in cheat mode and keeps them ready to edit', () => {
    const prompt = new RollPromptStore();
    prompt.add(pending());
    prompt.start();
    prompt.showPreview(rolled(25, 20));
    expect(prompt.phase).toBe('preview');
    expect(prompt.edit).toEqual(['20']);

    prompt.editResult();
    expect(prompt.phase).toBe('editing');
    prompt.showResult(rolled(30, 20));
    expect(prompt.phase).toBe('resolved');
    expect(prompt.result?.total).toBe(30);
  });

  it('takes a result set without rolling at all, one box per die', () => {
    const prompt = new RollPromptStore();
    prompt.add(pending());
    prompt.editResult();
    expect(prompt.phase).toBe('editing');
    expect(prompt.edit).toEqual(['']);
    expect(prompt.editableDice).toEqual([20]);
  });

  it('names the fight step the server tagged the card with', () => {
    const prompt = new RollPromptStore();
    prompt.add({
      ...pending(),
      purpose: 'Attack: Longsword vs AC 15',
      context_json: JSON.stringify({ encounter_id: 3, tool: 'attack', step: 'attack', actor_id: 9, target_id: 11 }),
    });
    expect(prompt.context).toEqual({
      encounter_id: 3,
      tool: 'attack',
      step: 'attack',
      actor_id: 9,
      target_id: 11,
    });
    expect(stepLabel(prompt.context!.step)).toBe('Attack');
    expect(stepLabel('death_save')).toBe('Death save');
    expect(stepLabel('check')).toBe('Ability check');

    expect(rollContext(pending())).toBeNull();
    expect(rollContext({ ...pending(), context_json: 'not json' })).toBeNull();
    expect(rollContext({ ...pending(), context_json: '{"step":"nonsense"}' })).toBeNull();
  });

  it('calls a contest the engine rolls an ability check, never a save', () => {
    const contest = { encounter_id: 3, tool: 'grapple', step: 'check' as const, actor_id: 9, target_id: 11 };
    expect(rollLabel({ ...pending(), roll_type: 'save', purpose: 'Grapple contest' }, contest)).toBe(
      'Ability check',
    );
    expect(rollLabel(pending(), contest)).toBe('Stealth check');
    expect(rollLabel({ ...pending(), roll_type: 'save', purpose: 'DEX save' }, null)).toBe('save');
  });

  it('asks for every die of a damage roll and works its total out live', () => {
    const prompt = new RollPromptStore();
    prompt.add({ ...pending(), expr: '2d6+3', purpose: 'Damage: 2d6+3 (slashing)', dc: null, roll_type: 'damage' });
    prompt.editResult();
    expect(prompt.editableDice).toEqual([6, 6]);
    expect(prompt.edit).toEqual(['', '']);

    expect(editedTotal('2d6+3', ['6', '6'])).toBe(15);
    expect(editedTotal('2d6+3', ['6', ''])).toBeNull();
    expect(editedTotal('2d6+3', ['7', '6'])).toBeNull();
    expect(modifierText('2d6+3')).toBe('+3');
    expect(modifierText('2d6')).toBe('');
    expect(expressionDice('1d20+5')).toEqual([20]);
    expect(expressionDice('4d6kh3')).toBeNull();
  });

  it('starts the boxes from the dice the preview kept, not the pool it rolled', () => {
    const pool = {
      ...rolled(17),
      expr: '3d20kh1+5',
      groups: [
        {
          value: 12,
          dice: [
            { value: 12, modifiers: [] },
            { value: 4, modifiers: ['drop'] },
            { value: 2, modifiers: ['drop'] },
          ],
        },
        '+',
        5,
      ],
    } as RollResult;
    expect(keptDice(pool.groups)).toEqual(['12']);
  });

  it('treats a 409 as rolled without the player', () => {
    const prompt = new RollPromptStore();
    prompt.add(pending());
    prompt.start();
    prompt.resolvedElsewhere();
    expect(prompt.phase).toBe('resolved');
    expect(prompt.result).toBeNull();
    expect(prompt.note).toBe('Rolled without you.');
    prompt.dismiss();
    expect(prompt.note).toBeNull();
  });

  it('keeps the card up when the call fails', () => {
    const prompt = new RollPromptStore();
    prompt.add(pending());
    prompt.start();
    prompt.fail('offline');
    expect(prompt.phase).toBe('waiting');
    expect(prompt.error).toBe('offline');
    expect(prompt.busy).toBe(false);
  });

  it('counts down to the moment the server rolls it anyway', () => {
    const roll = pending();
    const start = Date.parse(roll.created_at);
    expect(secondsLeft(roll, 45, start)).toBe(45);
    expect(secondsLeft(roll, 45, start + 30_000)).toBe(15);
    expect(secondsLeft(roll, 45, start + 60_000)).toBe(0);
    expect(secondsLeft({ ...roll, created_at: 'never' }, 45, start)).toBe(45);
  });
});
