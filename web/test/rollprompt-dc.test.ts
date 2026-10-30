import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import RollPrompt from '../src/components/RollPrompt.svelte';
import { RollPromptStore } from '../src/lib/rollprompt.svelte';
import type { DcDisclosure } from '../src/lib/settings';

const show = (dc: number | null, dcDisclosure?: DcDisclosure): string => {
  const prompt = new RollPromptStore();
  prompt.add({
    id: 1,
    campaign_id: 1,
    expr: '1d20+5',
    purpose: 'Stealth check',
    dc,
    roll_type: 'check',
    advantage: 'none',
    created_at: '2026-09-11T10:00:00.000Z',
    resolved_at: null,
  });
  return render(RollPrompt, {
    props: { prompt, cheat: false, timeoutS: 60, onresolved: () => undefined, dcDisclosure },
  }).body;
};

describe('roll card DC chip', () => {
  it('stays off when the DC is hidden, even if the roll carries one', () => {
    expect(show(12, 'hidden')).not.toContain('DC 12');
    expect(show(12)).not.toContain('DC 12');
  });

  it('shows the DC when disclosed and present', () => {
    expect(show(12, 'shown')).toContain('DC 12');
  });

  it('shows nothing when disclosed but there is no DC', () => {
    expect(show(null, 'shown')).not.toContain('DC ');
  });
});
