import type { CanonFact, Clue, PlotThread } from './types';

export interface FactGroup {
  subject: string;
  latest: CanonFact;
  /** Oldest first, in the order they are shown when the group is expanded. */
  earlier: CanonFact[];
}

/** The DM writes many facts per subject: one group per subject, newest group and newest fact first. */
export function groupFacts(facts: CanonFact[]): FactGroup[] {
  const bySubject = new Map<string, CanonFact[]>();
  for (const fact of [...facts].sort((a, b) => b.id - a.id)) {
    const key = fact.subject.trim().toLowerCase();
    const group = bySubject.get(key);
    if (group) group.push(fact);
    else bySubject.set(key, [fact]);
  }
  return [...bySubject.values()].map((group) => ({
    subject: group[0].subject,
    latest: group[0],
    earlier: group.slice(1).reverse(),
  }));
}

/** Rows the story package tags with the chapter they belong to. */
export interface ChapterTagged {
  chapter_id?: number | null;
}

/** With the filter on, only what was written in the open chapter; off, everything. */
export function inChapter<T extends ChapterTagged>(rows: T[], chapterId: number | null, only: boolean): T[] {
  if (!only || chapterId === null) return rows;
  return rows.filter((row) => row.chapter_id === chapterId);
}

/** The filter toggle only appears once the server tags these rows: an older one sends none. */
export function hasChapterTags(rows: ChapterTagged[]): boolean {
  return rows.some((row) => typeof row.chapter_id === 'number');
}

/** The toggle is worth showing once there is an open chapter to filter by, even before anything
 *  written this chapter is tagged with it - or, failing that, once older rows already carry a tag. */
export function canFilterByChapter(rows: ChapterTagged[], chapterId: number | null): boolean {
  return chapterId !== null || hasChapterTags(rows);
}

/** Hidden rows are the DM's. The server strips them already; this keeps them off screen either way. */
export function unhidden<T extends { hidden?: boolean }>(rows: T[], showSecrets: boolean): T[] {
  return showSecrets ? rows : rows.filter((row) => row.hidden !== true);
}

export interface ThreadClues {
  thread: PlotThread;
  clues: Clue[];
}

/** Each open thread with its clues, plus the clues hanging off no thread at all. */
export function cluesByThread(
  threads: PlotThread[],
  clues: Clue[],
  showSecrets: boolean,
): { threads: ThreadClues[]; loose: Clue[] } {
  const visible = unhidden(clues, showSecrets);
  return {
    threads: unhidden(threads, showSecrets).map((thread) => ({
      thread,
      clues: visible.filter((clue) => clue.thread_id === thread.id),
    })),
    loose: visible.filter((clue) => clue.thread_id === null),
  };
}
