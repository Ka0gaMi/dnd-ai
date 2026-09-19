<script lang="ts">
  import Help from './Help.svelte';
  import { getRumoursInScope } from '../lib/api';
  import type { Rumour, RumourScope } from '../lib/types';

  let {
    campaignId,
    rumours,
  }: {
    campaignId: number;
    /** The handful the snapshot carries; the endpoint fills in the rest. */
    rumours: Rumour[];
  } = $props();

  const SCOPES: Array<{ id: RumourScope | 'all'; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'world', label: 'World' },
    { id: 'region', label: 'Region' },
    { id: 'location', label: 'Location' },
  ];

  let fetched = $state<Rumour[] | null>(null);
  let scope = $state<RumourScope | 'all'>('all');

  const all = $derived(fetched ?? rumours);
  /** A followed rumour lives under its thread now; only a resolved one keeps its muted row here. */
  const remaining = $derived(all.filter((rumour) => !(rumour.followed && !rumour.resolved)));
  const shown = $derived(scope === 'all' ? remaining : remaining.filter((rumour) => rumour.scope === scope));

  /** The snapshot is replaced on every story event, which is exactly when the talk may have changed. */
  $effect(() => {
    void rumours;
    getRumoursInScope(campaignId)
      .then((list) => (fetched = list))
      .catch(() => undefined);
  });
</script>

{#if remaining.length > 0}
  <h3 class="label"><Help k="story.rumour_scope" text="Heard" label /></h3>
  <div class="scopes segmented" role="group" aria-label="Rumour scope">
    {#each SCOPES as option (option.id)}
      <button type="button" class="label" aria-pressed={scope === option.id} onclick={() => (scope = option.id)}>
        {option.label}
      </button>
    {/each}
  </div>
  {#if shown.length === 0}
    <p class="empty">No talk worth repeating.</p>
  {:else}
    <ul>
      {#each shown as rumour (rumour.id)}
        <li class:resolved={rumour.resolved}>
          <span class="chip">{rumour.scope}</span>
          <span class="prose">{rumour.text}</span>
          {#if rumour.resolved}<span class="chip">resolved</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  .scopes {
    margin: 0.15rem 0 0.35rem;
  }

  .scopes button {
    padding: 0.05rem 0.45rem;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.45rem;
    padding: 0.15rem 0;
    border-bottom: 1px solid var(--rule);
    font-size: var(--t-13);
  }

  li.resolved {
    color: var(--ink-faint);
  }
</style>
