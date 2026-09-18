import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Heard from '../src/components/Heard.svelte';
import type { Rumour } from '../src/lib/types';

/** A heard rumour with the story defaults; each case overrides what it is about. */
const rumour = (over: Partial<Rumour>): Rumour => ({
  id: 1,
  scope: 'location',
  text: 'The mill is haunted.',
  truth: 'true',
  source_kind: null,
  thread_id: null,
  heard_at: '2026-09-18T10:00:00.000Z',
  resolved: false,
  chapter_id: 1,
  followed: false,
  ...over,
});

describe('Heard', () => {
  it('hides a followed unresolved rumour and keeps one that is not followed', () => {
    const { body } = render(Heard, {
      props: {
        campaignId: 1,
        rumours: [
          rumour({ id: 1, text: 'Followed and still open.', followed: true, thread_id: 3 }),
          rumour({ id: 2, text: 'Still just talk.' }),
        ],
      },
    });
    expect(body).not.toContain('Followed and still open.');
    expect(body).toContain('Still just talk.');
  });

  it('keeps a followed rumour that has been resolved, muted', () => {
    const { body } = render(Heard, {
      props: {
        campaignId: 1,
        rumours: [rumour({ id: 1, text: 'Followed and resolved.', followed: true, resolved: true, thread_id: 3 })],
      },
    });
    expect(body).toContain('Followed and resolved.');
    expect(body).toContain('resolved');
  });

  it('renders nothing at all when every rumour has been followed', () => {
    const { body } = render(Heard, {
      props: {
        campaignId: 1,
        rumours: [rumour({ id: 1, text: 'Gone under its thread.', followed: true, thread_id: 3 })],
      },
    });
    expect(body).not.toContain('Heard');
    expect(body).not.toContain('No talk worth repeating.');
    expect(body).not.toContain('Gone under its thread.');
  });
});
