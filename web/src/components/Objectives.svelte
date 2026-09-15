<script lang="ts">
  import { canFilterByChapter, inChapter } from '../lib/story';
  import type { Quest } from '../lib/types';

  let {
    quests,
    chapterId = null,
  }: {
    quests: Quest[];
    /** The open chapter, for the "this chapter" filter; null hides the toggle. */
    chapterId?: number | null;
  } = $props();

  const KINDS: Array<[Quest['kind'], string]> = [
    ['main', 'Main'],
    ['side', 'Side'],
    ['personal', 'Personal'],
  ];

  let thisChapter = $state(false);

  const tagged = $derived(canFilterByChapter(quests, chapterId));
  const shown = $derived(inChapter(quests, chapterId, thisChapter));
  const grouped = $derived(KINDS.map(([kind, label]) => ({ label, list: shown.filter((q) => q.kind === kind) })));
</script>

<section>
  <h2 class="section-title">
    Objectives
    {#if tagged}
      <button type="button" class="label filter" aria-pressed={thisChapter} onclick={() => (thisChapter = !thisChapter)}>
        This chapter
      </button>
    {/if}
  </h2>
  {#if shown.length === 0}
    <p class="empty">{thisChapter ? 'No open quests from this chapter.' : 'No open quests.'}</p>
  {:else}
    {#each grouped as group (group.label)}
      {#if group.list.length > 0}
        <h3 class="label">{group.label}</h3>
        {#each group.list as quest (quest.id)}
          <article class:closed={quest.status !== 'open'}>
            <div class="head">
              <span class="title">{quest.title}</span>
              {#if quest.status !== 'open'}<span class="chip">{quest.status}</span>{/if}
            </div>
            {#if quest.summary}<p class="prose muted">{quest.summary}</p>{/if}
            <ul>
              {#each quest.steps as step (step.id)}
                <li class:done={step.done}>
                  <span class="box" class:checked={step.done} aria-hidden="true"></span>
                  <span>{step.text}</span>
                </li>
              {/each}
            </ul>
          </article>
        {/each}
      {/if}
    {/each}
  {/if}
</section>

<style>
  .section-title {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
  }

  .filter {
    margin-left: auto;
    border: none;
    padding: 0;
  }

  .filter[aria-pressed='true'] {
    color: var(--accent);
  }

  h3 {
    margin: 0.7rem 0 0.25rem;
  }

  article {
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--rule);
    margin-bottom: 0.4rem;
  }

  article.closed {
    color: var(--ink-faint);
  }

  .head {
    display: flex;
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
    font-size: var(--t-13);
  }

  ul li {
    display: grid;
    grid-template-columns: 0.8rem 1fr;
    align-items: baseline;
    gap: 0.4rem;
    padding: 0.05rem 0;
  }

  .box {
    width: 0.65rem;
    height: 0.65rem;
    border: 1px solid var(--ink-faint);
    align-self: center;
    position: relative;
  }

  .box.checked {
    border-color: var(--good);
  }

  /* Read-only tick, drawn rather than typed. */
  .box.checked::after {
    content: '';
    position: absolute;
    left: 0.15rem;
    top: 0.01rem;
    width: 0.22rem;
    height: 0.42rem;
    border: solid var(--good);
    border-width: 0 2px 2px 0;
    transform: rotate(42deg);
  }

  li.done span:last-child {
    color: var(--ink-faint);
  }
</style>
