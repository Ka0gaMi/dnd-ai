// The roll card names the number an attack is made against as an AC, and every other roll's as a DC.
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import RollPrompt from '../src/components/RollPrompt.svelte';
import { RollPromptStore } from '../src/lib/rollprompt.svelte';

const card = (rollType: string, purpose: string): string => {
  const prompt = new RollPromptStore();
  prompt.add({
    id: 1,
    campaign_id: 1,
    expr: '1d20+5',
    purpose,
    dc: 13,
    roll_type: rollType,
    advantage: 'none',
    created_at: '2026-10-30T10:00:00.000Z',
    resolved_at: null,
  });
  return render(RollPrompt, {
    props: { prompt, cheat: false, timeoutS: 60, onresolved: () => undefined, dcDisclosure: 'shown' },
  }).body;
};

describe('the roll card target chip', () => {
  it('says AC on an attack roll', () => {
    const body = card('attack', 'Attack: Greatsword');
    expect(body).toContain('AC 13');
    expect(body).not.toContain('DC 13');
  });

  it('says DC on a check, a save and a free-standing roll', () => {
    for (const [rollType, purpose] of [
      ['check', 'Stealth check'],
      ['save', 'Saving throw: DEX'],
      ['other', 'Bell toll'],
    ]) {
      const body = card(rollType!, purpose!);
      expect(body, rollType).toContain('DC 13');
      expect(body, rollType).not.toContain('AC 13');
    }
  });
});
