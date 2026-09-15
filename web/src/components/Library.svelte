<script lang="ts">
  import Help from './Help.svelte';
  import { getLibrary, saveToLibrary } from '../lib/api';
  import { canSaveToLibrary, libraryView, powerChip, type Homebrew } from '../lib/progression';

  let {
    campaignId,
    version,
  }: {
    campaignId: number;
    /** Bumped by the store when an event could have added homebrew. */
    version: number;
  } = $props();

  let open = $state(false);
  let lists = $state(libraryView(null));
  let problem = $state<string | null>(null);
  let saving = $state<number | null>(null);

  const total = $derived(lists.campaign.length + lists.library.length);

  async function refresh(): Promise<void> {
    try {
      lists = libraryView(await getLibrary(campaignId));
      problem = null;
    } catch (failure) {
      problem = failure instanceof Error ? failure.message : String(failure);
    }
  }

  async function keep(entry: Homebrew): Promise<void> {
    saving = entry.id;
    try {
      await saveToLibrary(entry.id);
      await refresh();
    } catch (failure) {
      problem = failure instanceof Error ? failure.message : String(failure);
    } finally {
      saving = null;
    }
  }

  $effect(() => {
    void version;
    if (!open) return;
    refresh();
  });
</script>

<section>
  <h2 class="section-title">
    <button type="button" class="toggle" aria-expanded={open} onclick={() => (open = !open)}>
      <span class="chevron" class:open aria-hidden="true"></span>
      <Help k="library" text="Library" label />
      {#if open}<span class="label count">{total}</span>{/if}
    </button>
  </h2>
  {#if open}
    {#if problem}<p class="chip bad">{problem}</p>{/if}
    {#each [{ title: 'This story', entries: lists.campaign }, { title: 'My library', entries: lists.library }] as list (list.title)}
      <h3 class="label">{list.title}</h3>
      {#if list.entries.length === 0}
        <p class="empty">Nothing here yet.</p>
      {:else}
        <ul>
          {#each list.entries as entry (entry.id)}
            {@const chip = powerChip(entry.power_label)}
            <li>
              <div class="head">
                <span class="name">{entry.name}</span>
                {#if entry.kind === 'subclass'}
                  <span class="chip accent"><Help k="custom_subclass" text="Subclass" label /></span>
                {:else if entry.kind === 'spell'}
                  <span class="chip accent"><Help k="custom_spell" text="Spell" label /></span>
                {:else}
                  <span class="label kind">{entry.kind}</span>
                {/if}
                <span class="chip {chip.tone}">{chip.label}</span>
              </div>
              {#if entry.schema.text}<p class="prose muted">{entry.schema.text}</p>{/if}
              {#if canSaveToLibrary(entry)}
                <button type="button" class="label keep" disabled={saving === entry.id} onclick={() => keep(entry)}>
                  Save to my library
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/each}
  {/if}
</section>

<style>
  .toggle {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    width: 100%;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    text-align: left;
  }

  /* The same CSS chevron the other collapsibles use: no glyph, no icon font. */
  .chevron {
    flex: none;
    width: 0;
    height: 0;
    border-left: 5px solid var(--accent);
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .count {
    color: var(--ink-faint);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    padding: 0.3rem 0;
    border-bottom: 1px solid var(--rule);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
  }

  .name {
    font-weight: 500;
  }

  .kind {
    color: var(--ink-faint);
  }

  li p {
    margin: 0.1rem 0;
    font-size: var(--t-13);
  }

  .keep {
    border: 1px solid var(--rule);
    padding: 0.05rem 0.4rem;
    color: var(--ink-muted);
  }

  @media (prefers-reduced-motion: no-preference) {
    .chevron {
      transition: transform 0.15s ease-out;
    }
  }
</style>
