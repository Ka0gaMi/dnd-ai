import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Glossary from '../src/components/Glossary.svelte';
import type { GlossaryEntry } from '../src/lib/types';

/** The endpoint merges SRD and campaign rows, so the same term can arrive twice with two sources. */
const entries: GlossaryEntry[] = [
  { term: 'Cover', definition: 'The SRD rule.', source: 'srd' },
  { term: 'Grapple', definition: 'The other SRD rule.', source: 'srd' },
  { term: 'Cover', definition: 'What cover means in this story.', source: 'campaign' },
];

describe('Glossary', () => {
  it('shows the campaign term first, the shadowed SRD one behind the Rules tab', () => {
    const { body } = render(Glossary, { props: { entries } });
    expect(body).toContain('What cover means in this story.');
    expect(body).not.toContain('The SRD rule.');
  });

  it('counts the terms on both tabs', () => {
    const { body } = render(Glossary, { props: { entries } });
    expect(body).toContain('Campaign');
    expect(body).toContain('1 term');
    expect(body).toContain('Rules');
    expect(body).toContain('2 terms');
  });

  it('lists every rule term, not just the first two hundred', () => {
    const many: GlossaryEntry[] = Array.from({ length: 250 }, (_, i) => ({
      term: `Rule ${String(i).padStart(3, '0')}`,
      definition: 'Some rule text.',
      source: 'srd' as const,
    }));
    const { body } = render(Glossary, { props: { entries: many } });
    expect(body).toContain('250 terms');
    expect(body).toContain('Rule 249');
  });
});
