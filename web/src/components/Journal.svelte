<script lang="ts">
  import Help from './Help.svelte';
  import { addJournalEntry, getJournal } from '../lib/api';
  import type { Chapter, JournalEntry, StoryArc } from '../lib/types';

  let {
    campaignId,
    entries,
    chapter,
    recaps = [],
  }: {
    campaignId: number;
    /** The last few the snapshot carries, oldest first; the endpoint has the rest. */
    entries: JournalEntry[];
    /** The open chapter, so an entry written now can be tagged with its number. */
    chapter: Chapter | null;
    /** Closed chapters, so an older entry can be tagged with the chapter it was written in. */
    recaps?: StoryArc['recaps'];
  } = $props();

  let fetched = $state<JournalEntry[] | null>(null);
  let text = $state('');
  let saving = $state(false);
  let problem = $state<string | null>(null);

  const newestFirst = $derived([...(fetched ?? entries)].reverse());

  /** The open chapter gets its own number; a closed one is named from its recap, oldest known as "Earlier chapter". */
  function chapterTag(entry: JournalEntry): string | null {
    if (entry.chapter_id === null) return null;
    if (entry.chapter_id === chapter?.id) return `Chapter ${chapter.number}`;
    const recap = recaps.find((r) => r.chapter_id === entry.chapter_id);
    return recap ? `Chapter ${recap.number}: ${recap.title}` : 'Earlier chapter';
  }

  function day(ts: string): string {
    return ts.slice(0, 10);
  }

  async function refresh(): Promise<void> {
    try {
      fetched = await getJournal(campaignId);
    } catch {
      // The snapshot's own entries stay on screen.
    }
  }

  async function add(): Promise<void> {
    const written = text.trim();
    if (written === '' || saving) return;
    saving = true;
    try {
      await addJournalEntry(campaignId, written);
      text = '';
      problem = null;
      await refresh();
    } catch (failure) {
      problem = failure instanceof Error ? failure.message : String(failure);
    } finally {
      saving = false;
    }
  }

  $effect(() => {
    void entries;
    refresh();
  });
</script>

<h3 class="label"><Help k="story.journal" text="Journal" label /></h3>
<form
  class="write"
  onsubmit={(event) => {
    event.preventDefault();
    add();
  }}
>
  <textarea
    bind:value={text}
    rows="2"
    placeholder="Your own note — the DM never writes here"
    aria-label="New journal entry"
  ></textarea>
  <div class="actions">
    <button type="submit" disabled={saving || text.trim() === ''}>Add entry</button>
    <span class="muted note">Yours to keep; the DM can read it.</span>
  </div>
  {#if problem}<span class="chip bad">{problem}</span>{/if}
</form>
{#if newestFirst.length === 0}
  <p class="empty">Nothing written yet.</p>
{:else}
  <ul>
    {#each newestFirst as entry (entry.id)}
      <li>
        <div class="meta">
          <span class="label num">{day(entry.created_at)}</span>
          {#if chapterTag(entry)}<span class="label">{chapterTag(entry)}</span>{/if}
        </div>
        <p class="prose">{entry.text}</p>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .write {
    display: grid;
    gap: 0.3rem;
    margin: 0.2rem 0 0.5rem;
  }

  textarea {
    font-family: var(--font-body);
    font-size: var(--t-15);
    width: 100%;
    max-width: 65ch;
    color: var(--ink);
    background: var(--surface-raised);
    border: 1px solid var(--rule);
    padding: 0.3rem 0.5rem;
    resize: vertical;
  }

  textarea:focus {
    border-color: var(--accent);
  }

  textarea::placeholder {
    color: var(--ink-faint);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .note {
    font-size: var(--t-13);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    padding: 0.2rem 0;
    border-bottom: 1px solid var(--rule);
  }

  .meta {
    display: flex;
    gap: 0.6rem;
  }

  p {
    margin: 0.1rem 0;
    font-size: var(--t-15);
    white-space: pre-wrap;
  }
</style>
