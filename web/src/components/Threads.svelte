<script lang="ts">
  import Help from './Help.svelte';
  import { cluesByThread } from '../lib/story';
  import type { Clue, PlotThread, ThreadStatus } from '../lib/types';

  let {
    threads,
    clues,
    showSecrets,
  }: {
    threads: PlotThread[];
    clues: Clue[];
    /** The spoiler setting: the DM's hidden threads and clues stay off screen without it. */
    showSecrets: boolean;
  } = $props();

  const TONES: Record<ThreadStatus, string> = { open: 'accent', resolved: 'good', dropped: '' };

  const grouped = $derived(cluesByThread(threads, clues, showSecrets));
</script>

<h3 class="label"><Help k="story.thread" text="Threads & clues" label /></h3>
{#if grouped.threads.length === 0 && grouped.loose.length === 0}
  <p class="empty">Nothing hanging over you yet.</p>
{:else}
  {#each grouped.threads as group (group.thread.id)}
    <article class:secret={group.thread.hidden}>
      <div class="head">
        <span class="title">{group.thread.title}</span>
        <span class="chip {TONES[group.thread.status]}">{group.thread.status}</span>
        {#if group.thread.hidden}<span class="chip warn">[secret]</span>{/if}
      </div>
      {#if group.thread.summary}<p class="prose muted">{group.thread.summary}</p>{/if}
      {#if group.clues.length > 0}
        <ul>
          {#each group.clues as clue (clue.id)}
            <li class:secret={clue.hidden}>
              <span class="label status" class:found={clue.status === 'found'}>{clue.status}</span>
              <span class="prose">{clue.text}</span>
              {#if clue.hidden}<span class="chip warn">[secret]</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </article>
  {/each}
  {#if grouped.loose.length > 0}
    <article>
      <div class="head"><span class="title muted">Loose ends</span></div>
      <ul>
        {#each grouped.loose as clue (clue.id)}
          <li class:secret={clue.hidden}>
            <span class="label status" class:found={clue.status === 'found'}>{clue.status}</span>
            <span class="prose">{clue.text}</span>
            {#if clue.hidden}<span class="chip warn">[secret]</span>{/if}
          </li>
        {/each}
      </ul>
    </article>
  {/if}
{/if}

<style>
  article {
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--rule);
    margin-bottom: 0.4rem;
  }

  /* A hidden row the player chose to see: a muted stripe marks it as the DM's own. */
  .secret {
    border-left: 3px solid var(--warn);
    padding-left: 0.45rem;
    color: var(--ink-muted);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
  }

  .title {
    font-weight: 500;
  }

  p {
    margin: 0.1rem 0;
    font-size: var(--t-13);
  }

  ul {
    list-style: none;
    margin: 0.25rem 0 0;
    padding: 0;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.45rem;
    padding: 0.05rem 0;
    font-size: var(--t-13);
  }

  .status.found {
    color: var(--good);
  }
</style>
