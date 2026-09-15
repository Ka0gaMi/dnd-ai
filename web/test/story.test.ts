import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Story, { RECENT_CHAPTERS, earlierChapterLabel, recentChapterSlice } from '../src/components/Story.svelte';
import { canFilterByChapter, cluesByThread, groupFacts, hasChapterTags, inChapter, unhidden } from '../src/lib/story';
import type { CanonFact, Clue, PlotThread, Snapshot, StoryArc } from '../src/lib/types';

/** The snapshot sends facts newest first; ids rise with time. */
const facts: CanonFact[] = [
  { id: 5, subject: 'Rowan', fact: 'Rowan carries her mother’s ring.' },
  { id: 4, subject: 'The Ashen Gate', fact: 'The gate answers to old blood.' },
  { id: 3, subject: 'rowan', fact: 'Rowan is a hedge witch.' },
  { id: 2, subject: 'Rowan', fact: 'Rowan grew up in Fen End.' },
];

describe('groupFacts', () => {
  it('groups by subject case-insensitively, newest group first', () => {
    expect(groupFacts(facts).map((group) => group.subject)).toEqual(['Rowan', 'The Ashen Gate']);
  });

  it('shows the latest fact per subject and counts the earlier ones', () => {
    const [rowan] = groupFacts(facts);
    expect(rowan.latest.id).toBe(5);
    expect(rowan.earlier).toHaveLength(2);
  });

  it('lists the earlier facts oldest first', () => {
    expect(groupFacts(facts)[0].earlier.map((fact) => fact.id)).toEqual([2, 3]);
  });

  it('leaves a single-fact subject with nothing to expand', () => {
    const [, gate] = groupFacts(facts);
    expect(gate.latest.id).toBe(4);
    expect(gate.earlier).toEqual([]);
  });

  it('orders by id whatever order the rows arrive in', () => {
    expect(groupFacts([...facts].reverse())[0].latest.id).toBe(5);
  });
});

describe('chapter filter', () => {
  const rows: CanonFact[] = [
    { id: 3, subject: 'Rowan', fact: 'Rowan keeps the ring.', chapter_id: 2 },
    { id: 2, subject: 'Fen End', fact: 'The village drowned.', chapter_id: 1 },
    { id: 1, subject: 'The Gate', fact: 'The gate is old.', chapter_id: null },
  ];

  it('keeps only the open chapter rows when the filter is on', () => {
    expect(inChapter(rows, 2, true).map((row) => row.id)).toEqual([3]);
  });

  it('keeps everything when the filter is off', () => {
    expect(inChapter(rows, 2, false)).toHaveLength(3);
  });

  it('keeps everything when no chapter is open, filter or not', () => {
    expect(inChapter(rows, null, true)).toHaveLength(3);
  });

  it('drops rows tagged with another chapter and rows tagged with none', () => {
    expect(inChapter(rows, 1, true).map((row) => row.id)).toEqual([2]);
  });

  it('offers the toggle only once the server tags rows with a chapter', () => {
    const older: CanonFact = { id: 1, subject: 'a', fact: 'b' };
    expect(hasChapterTags(rows)).toBe(true);
    expect(hasChapterTags([older])).toBe(false);
    expect(hasChapterTags([{ ...older, chapter_id: null }])).toBe(false);
    expect(hasChapterTags([])).toBe(false);
  });

  it('offers the toggle once a chapter is open, even before anything this chapter is tagged', () => {
    const untagged: CanonFact = { id: 1, subject: 'a', fact: 'b', chapter_id: null };
    expect(canFilterByChapter([], 2)).toBe(true);
    expect(canFilterByChapter([untagged], 2)).toBe(true);
  });

  it('falls back to the rows when no chapter is open', () => {
    const untagged: CanonFact = { id: 1, subject: 'a', fact: 'b' };
    expect(canFilterByChapter(rows, null)).toBe(true);
    expect(canFilterByChapter([untagged], null)).toBe(false);
  });
});

describe('hidden rows', () => {
  const threads: PlotThread[] = [
    { id: 1, title: 'Who burned the mill', status: 'open', hidden: false, summary: null, chapter_id: 1 },
    { id: 2, title: 'The reeve is the arsonist', status: 'open', hidden: true, summary: null, chapter_id: 1 },
  ];
  const clues: Clue[] = [
    { id: 1, thread_id: 1, text: 'Lamp oil by the door.', hidden: false, status: 'found', found_at_scene_id: 4, planted_at: 't' },
    { id: 2, thread_id: 2, text: 'The reeve bought oil.', hidden: true, status: 'planted', found_at_scene_id: null, planted_at: 't' },
    { id: 3, thread_id: null, text: 'A torn glove.', hidden: false, status: 'planted', found_at_scene_id: null, planted_at: 't' },
  ];

  it('keeps the DM own rows off screen with the spoiler setting off', () => {
    expect(unhidden(threads, false).map((thread) => thread.id)).toEqual([1]);
    expect(unhidden(clues, false).map((clue) => clue.id)).toEqual([1, 3]);
  });

  it('shows them with the setting on', () => {
    expect(unhidden(threads, true)).toHaveLength(2);
    expect(unhidden(clues, true)).toHaveLength(3);
  });

  it('hangs each clue under its thread and keeps the loose ones apart', () => {
    const grouped = cluesByThread(threads, clues, false);
    expect(grouped.threads).toHaveLength(1);
    expect(grouped.threads[0].clues.map((clue) => clue.id)).toEqual([1]);
    expect(grouped.loose.map((clue) => clue.id)).toEqual([3]);
  });

  it('gives a hidden thread its hidden clues once secrets are on', () => {
    const grouped = cluesByThread(threads, clues, true);
    expect(grouped.threads[1].thread.id).toBe(2);
    expect(grouped.threads[1].clues.map((clue) => clue.id)).toEqual([2]);
  });
});

describe('the chapter timeline', () => {
  /** Seven closed chapters, reversed the way the panel reads them: newest first. */
  const newestFirst: StoryArc['recaps'] = Array.from({ length: 7 }, (_, index) => {
    const number = 7 - index;
    return { id: number, chapter_id: number, number, title: `Chapter ${number}`, summary: `What happened in ${number}.` };
  });

  const snapshot = (recaps: StoryArc['recaps']): Snapshot => ({
    campaign: { id: 1, name: 'Testing story', story_shape: 'heroic', premise: null },
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
    story: {
      outline: { premise: null, ending: null, secret_notes: null },
      act: null,
      chapter: {
        id: 8,
        act_id: null,
        number: 8,
        title: 'Chapter 8',
        goal: null,
        summary: null,
        status: 'open',
        started_at: '2026-09-11T10:00:00.000Z',
        closed_at: null,
      },
      recaps,
      threads: [],
      clues: [],
    },
  });

  it('opens on the three newest chapters and keeps the rest', () => {
    expect(RECENT_CHAPTERS).toBe(3);
    expect(recentChapterSlice(newestFirst, false).map((recap) => recap.number)).toEqual([7, 6, 5]);
  });

  it('shows every chapter once the player asks for them', () => {
    expect(recentChapterSlice(newestFirst, true).map((recap) => recap.number)).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  it('leaves a timeline shorter than the cap whole', () => {
    expect(recentChapterSlice(newestFirst.slice(0, 2), false)).toHaveLength(2);
  });

  it('offers the earlier chapters and counts what the cap holds back', () => {
    expect(earlierChapterLabel(7, false)).toBe('Show 4 earlier chapters');
    expect(earlierChapterLabel(7, true)).toBe('Show fewer chapters');
  });

  it('offers no control when there is nothing behind the cap', () => {
    expect(earlierChapterLabel(RECENT_CHAPTERS, false)).toBeNull();
    expect(earlierChapterLabel(2, true)).toBeNull();
    expect(earlierChapterLabel(0, false)).toBeNull();
  });

  it('keeps the way back once every chapter is showing', () => {
    const expanded = recentChapterSlice(newestFirst, true);
    expect(expanded.map((recap) => recap.number)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    // The old count came from the slice, so it read 0 here and hid the collapse control.
    expect(earlierChapterLabel(expanded.length, true)).toBe('Show fewer chapters');
    expect(recentChapterSlice(expanded, false).map((recap) => recap.number)).toEqual([7, 6, 5]);
  });

  it('still counts every closed chapter in the panel, capped or not', () => {
    const { body } = render(Story, { props: { snapshot: snapshot([...newestFirst].reverse()) } });
    expect(body).toContain('Chapters so far (7)');
    expect(body.match(/pip closed/g)).toHaveLength(7);
  });
});
