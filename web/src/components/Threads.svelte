<script lang="ts">
  import Fold from './Fold.svelte';
  import Help from './Help.svelte';
  import { cluesByThread } from '../lib/story';
  import type { Clue, PlotThread, Rumour, ThreadStatus } from '../lib/types';

  let {
    threads,
    clues,
    rumours,
    campaignId,
    showSecrets,
    store = (typeof localStorage === 'undefined' ? null : (localStorage as Store)) ?? null,
  }: {
    threads: PlotThread[];
    clues: Clue[];
    /** The same snapshot list Heard gets; the ones tied to a thread also show under it. */
    rumours: Rumour[];
    /** The open thread's fold remembers its state per campaign in storage. */
    campaignId: number;
    /** The spoiler setting: the DM's hidden threads and clues stay off screen without it. */
    showSecrets: boolean;
    /** Overridable so tests can hand in their own storage; the window uses localStorage. */
    store?: Store | null;
  } = $props();

  type Store = Pick<Storage, 'getItem' | 'setItem'>;

  const TONES: Record<ThreadStatus, string> = { open: 'accent', resolved: 'good', dropped: '' };

  /** Open threads are the working list, so Fold's closed-by-default is overridden for them. */
  function threadStore(count: number): Store | null {
    const base = store;
    if (!base) return null;
    return {
      getItem: (key) => base.getItem(key) ?? JSON.stringify({ open: true, seen: count }),
      setItem: (key, value) => base.setItem(key, value),
    };
  }

  const grouped = $derived(cluesByThread(threads, clues, showSecrets, rumours));
  const open = $derived(grouped.threads.filter((group) => group.thread.status === 'open'));
  const closed = $derived(grouped.threads.filter((group) => group.thread.status !== 'open'));
</script>

<h3 class="label"><Help k="story.thread" text="Threads & clues" label /></h3>
{#if grouped.threads.length === 0 && grouped.loose.length === 0}
  <p class="empty">Nothing hanging over you yet.</p>
{:else}
  {#each open as group (group.thread.id)}
    <div class:secret={group.thread.hidden}>
      <Fold
        label={group.thread.title}
        count={group.clues.length + group.rumours.length}
        {campaignId}
        block={`thread:${group.thread.id}`}
        store={threadStore(group.clues.length + group.rumours.length)}
      >
        {#snippet filter()}
          <span class="chip {TONES[group.thread.status]}">{group.thread.status}</span>
          {#if group.thread.hidden}<span class="chip warn">[secret]</span>{/if}
        {/snippet}
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
        {#if group.rumours.length > 0}
          <ul class="rumours">
            {#each group.rumours as rumour (rumour.id)}
              <li class="muted">heard: {rumour.text}</li>
            {/each}
          </ul>
        {/if}
      </Fold>
    </div>
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

  {#if closed.length > 0}
    <Fold label="Resolved" count={closed.length} {campaignId} block="threads:resolved" {store}>
      <ul class="closed">
        {#each closed as group (group.thread.id)}
          <li class:secret={group.thread.hidden}>
            <span class="title">{group.thread.title}</span>
            <span class="chip {TONES[group.thread.status]}">{group.thread.status}</span>
            <span class="muted">{group.clues.length} {group.clues.length === 1 ? 'clue' : 'clues'}</span>
            {#if group.thread.hidden}<span class="chip warn">[secret]</span>{/if}
          </li>
        {/each}
      </ul>
    </Fold>
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

  .rumours li {
    color: var(--ink-muted);
  }

  .closed li {
    padding: 0.1rem 0;
  }

  .status.found {
    color: var(--good);
  }
</style>
