import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Threads from '../src/components/Threads.svelte';
import type { Clue, PlotThread, Rumour } from '../src/lib/types';

/** A storage double, the same shape Fold reads and writes; handed in so no test touches a global. */
function fakeStore(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

const thread = (over: Partial<PlotThread> & { id: number }): PlotThread => ({
  title: `Thread ${over.id}`,
  status: 'open',
  hidden: false,
  summary: null,
  chapter_id: 1,
  ...over,
});

const clue = (over: Partial<Clue> & { id: number; thread_id: number | null }): Clue => ({
  text: `Clue ${over.id}.`,
  hidden: false,
  status: 'planted',
  found_at_scene_id: null,
  planted_at: 't',
  ...over,
});

const rumour = (over: Partial<Rumour> & { id: number; thread_id: number | null }): Rumour => ({
  scope: 'region',
  text: `Rumour ${over.id}.`,
  truth: 'false',
  source_kind: null,
  heard_at: 't',
  resolved: false,
  followed: false,
  chapter_id: 1,
  ...over,
});

describe('the threads working list', () => {
  it('lists open threads before one Resolved fold holding the closed ones', () => {
    const { body } = render(Threads, {
      props: {
        threads: [
          thread({ id: 1, title: 'The mill' }),
          thread({ id: 2, title: 'The reeve', status: 'resolved' }),
          thread({ id: 3, title: 'The gate' }),
          thread({ id: 4, title: 'The ferryman', status: 'dropped' }),
        ],
        clues: [],
        rumours: [],
        campaignId: 7,
        showSecrets: false,
        store: fakeStore(),
      },
    });

    const mill = body.indexOf('The mill');
    const gate = body.indexOf('The gate');
    const resolved = body.indexOf('Resolved');
    expect(mill).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(mill);
    expect(resolved).toBeGreaterThan(gate);
    expect(body).toContain('(2)');
    // A closed thread sits inside the closed Resolved fold, not loose on the page.
    expect(body).not.toContain('The reeve');
    expect(body).not.toContain('The ferryman');
  });

  it('shows a tied rumour as a muted heard line and never its truth', () => {
    const { body } = render(Threads, {
      props: {
        threads: [thread({ id: 1, title: 'The mill' })],
        clues: [],
        rumours: [rumour({ id: 9, thread_id: 1, text: 'Smoke over the weir.', truth: 'twisted' })],
        campaignId: 7,
        showSecrets: false,
        store: fakeStore(),
      },
    });

    expect(body).toContain('heard: Smoke over the weir.');
    expect(body).not.toContain('twisted');
  });

  it('keeps the stored per-thread state, overriding the open-by-default fold', () => {
    const store = fakeStore();
    store.setItem('story-fold:7:thread:1', JSON.stringify({ open: false, seen: 1 }));
    const { body } = render(Threads, {
      props: {
        threads: [thread({ id: 1, title: 'The mill' })],
        clues: [clue({ id: 1, thread_id: 1 })],
        rumours: [],
        campaignId: 7,
        showSecrets: false,
        store,
      },
    });

    expect(body).toContain('aria-expanded="false"');
    expect(body).not.toContain('Clue 1.');
  });

  it('counts a thread fold by its clues and its tied rumours', () => {
    const { body } = render(Threads, {
      props: {
        threads: [thread({ id: 1, title: 'The mill' })],
        clues: [clue({ id: 1, thread_id: 1 }), clue({ id: 2, thread_id: 1 })],
        rumours: [rumour({ id: 9, thread_id: 1 })],
        campaignId: 7,
        showSecrets: false,
        store: fakeStore(),
      },
    });

    expect(body).toContain('The mill');
    expect(body).toContain('(3)');
  });

  it('keeps a hidden thread and its rumour off screen until the spoiler setting is on', () => {
    const threads = [thread({ id: 2, title: 'The reeve is the arsonist', hidden: true })];
    const rumours = [rumour({ id: 9, thread_id: 2, text: 'The reeve bought oil.' })];
    const base = { threads, clues: [], rumours, campaignId: 7, store: fakeStore() };

    const off = render(Threads, { props: { ...base, showSecrets: false } });
    expect(off.body).not.toContain('The reeve is the arsonist');
    expect(off.body).not.toContain('heard:');

    const on = render(Threads, { props: { ...base, showSecrets: true } });
    expect(on.body).toContain('The reeve is the arsonist');
    expect(on.body).toContain('[secret]');
  });

  it("gives a hidden open thread's fold the warning stripe", () => {
    const { body } = render(Threads, {
      props: {
        threads: [thread({ id: 2, title: 'The reeve is the arsonist', hidden: true })],
        clues: [],
        rumours: [],
        campaignId: 7,
        showSecrets: true,
        store: fakeStore(),
      },
    });

    expect(body).toContain('The reeve is the arsonist');
    // The fold's wrapper carries the muted stripe the old article used to show.
    expect(body).toMatch(/class="[^"]*\bsecret\b[^"]*"/);
  });
});
