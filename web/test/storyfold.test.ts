import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { createRawSnippet } from 'svelte';
import Fold, { foldDefaults, foldKey, hasNewItems, readFold, writeFold } from '../src/components/Fold.svelte';
import Story, { EVENTS_PAGE, earlierEventsLabel, eventSlice } from '../src/components/Story.svelte';
import type { Snapshot } from '../src/lib/types';

/** A storage double: the same shape the fold state reads and writes. */
function fakeStore(): Pick<Storage, 'getItem' | 'setItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

const content = createRawSnippet(() => ({ render: () => 'FOLD CONTENT' }));

const snapshot = (): Snapshot => ({
  campaign: { id: 1, name: 'Testing folds', story_shape: 'heroic', premise: null },
  session: { id: 1, number: 1, started_at: '2026-09-11T10:00:00.000Z' },
  last_recap: null,
  current_scene: null,
  previous_scene: null,
  pc: null,
  open_quests: [],
  canon_facts: [],
  recent_events: [],
  glossary_terms: [],
  events_since_checkpoint: 0,
});

describe('fold state', () => {
  it('keys the state per campaign and block', () => {
    expect(foldKey(3, 'canon')).toBe('story-fold:3:canon');
  });

  it('starts canon facts and recent events closed and the journal open only when written in', () => {
    expect(foldDefaults('canon', 5)).toEqual({ open: false, seen: 5 });
    expect(foldDefaults('events', 25)).toEqual({ open: false, seen: 25 });
    expect(foldDefaults('journal', 0)).toEqual({ open: false, seen: 0 });
    expect(foldDefaults('journal', 1)).toEqual({ open: true, seen: 1 });
  });

  it('round-trips through a storage and forgets what it cannot parse', () => {
    const store = fakeStore();
    writeFold(store, foldKey(1, 'canon'), { open: true, seen: 9 });
    expect(readFold(store, foldKey(1, 'canon'))).toEqual({ open: true, seen: 9 });
    store.map.set(foldKey(1, 'canon'), 'not json');
    expect(readFold(store, foldKey(1, 'canon'))).toBeNull();
    expect(readFold(null, foldKey(1, 'canon'))).toBeNull();
  });

  it('shows the dot only on a closed fold that grew since the window last looked', () => {
    expect(hasNewItems({ open: false, seen: 3 }, 5)).toBe(true);
    expect(hasNewItems({ open: true, seen: 3 }, 5)).toBe(false);
    expect(hasNewItems({ open: false, seen: 5 }, 5)).toBe(false);
  });
});

describe('the Fold component', () => {
  it('shows its label and count, closed by default with the content hidden', () => {
    const { body } = render(Fold, {
      props: { label: 'Canon facts', count: 4, campaignId: 1, block: 'canon', children: content },
    });
    expect(body).toContain('Canon facts');
    expect(body).toContain('(4)');
    expect(body).toContain('aria-expanded="false"');
    expect(body).not.toContain('FOLD CONTENT');
  });  it('renders the content when the stored state says open', () => {
    const store = fakeStore();
    writeFold(store, foldKey(1, 'journal'), { open: true, seen: 2 });
    const { body } = render(Fold, {
      props: { label: 'Journal', count: 2, campaignId: 1, block: 'journal', store, children: content },
    });
    expect(body).toContain('aria-expanded="true"');
    expect(body).toContain('FOLD CONTENT');
  });

  it('shows the new-item dot when the stored last-seen count is behind, and not once opened', () => {
    const store = fakeStore();
    writeFold(store, foldKey(1, 'events'), { open: false, seen: 3 });
    const behind = render(Fold, {
      props: { label: 'Recent events', count: 5, campaignId: 1, block: 'events', store, children: content },
    });
    expect(behind.body).toContain('fold-dot');

    writeFold(store, foldKey(1, 'events'), { open: true, seen: 3 });
    const opened = render(Fold, {
      props: { label: 'Recent events', count: 5, campaignId: 1, block: 'events', store, children: content },
    });
    expect(opened.body).not.toContain('fold-dot');
    expect(opened.body).toContain('FOLD CONTENT');
  });
});

describe('recent events paging', () => {
  const events = Array.from({ length: 25 }, (_, index) => ({
    id: index + 1,
    ts: `2026-09-11T10:${String(index).padStart(2, '0')}:00.000Z`,
    kind: 'note',
    text: `Event ${index + 1}.`,
  }));

  it('opens on ten and reveals one more page at a time', () => {
    expect(EVENTS_PAGE).toBe(10);
    expect(eventSlice(events, 10)).toHaveLength(10);
    expect(eventSlice(events, 20)).toHaveLength(20);
    expect(eventSlice(events, 30)).toHaveLength(25);
  });

  it('offers the control while anything is held back, then drops it', () => {
    expect(earlierEventsLabel(25, 10)).toBe('Show 10 earlier events');
    expect(earlierEventsLabel(25, 20)).toBe('Show 5 earlier events');
    expect(earlierEventsLabel(25, 25)).toBeNull();
    expect(earlierEventsLabel(3, 10)).toBeNull();
  });

  it('renders the newest ten in the panel once the fold is open, with the control', () => {
    const store = fakeStore();
    writeFold(store, foldKey(1, 'events'), { open: true, seen: 25 });
    const previous = globalThis.localStorage;
    globalThis.localStorage = store as unknown as Storage;
    try {
      const full = snapshot();
      // The snapshot sends events oldest first; the panel reverses them.
      full.recent_events = events;
      const { body } = render(Story, { props: { snapshot: full } });
      expect(body).toContain('Recent events');
      expect(body).toContain('(25)');
      expect(body).toContain('Event 25.');
      expect(body).toContain('Event 16.');
      expect(body).not.toContain('Event 15.');
      expect(body).toContain('Show 10 earlier events');
    } finally {
      globalThis.localStorage = previous;
    }
  });
});
