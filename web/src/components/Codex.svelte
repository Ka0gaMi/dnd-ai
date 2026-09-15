<script lang="ts">
  import Entity from './Entity.svelte';
  import Portrait from './Portrait.svelte';
  import { getCodex } from '../lib/api';
  import type { CodexListItem, EntityKind } from '../lib/types';

  let {
    campaignId,
    version,
    showSecrets,
  }: {
    campaignId: number;
    /** Bumped by the store when an event could have changed the codex. */
    version: number;
    showSecrets: boolean;
  } = $props();

  const KINDS: EntityKind[] = ['npc', 'faction', 'place', 'item', 'deity', 'event'];

  let entities = $state<CodexListItem[]>([]);
  let query = $state('');
  let kind = $state<EntityKind | null>(null);
  let openId = $state<number | null>(null);

  const matches = $derived(
    entities.filter((entry) => {
      const needle = query.trim().toLowerCase();
      if (kind !== null && entry.kind !== kind) return false;
      if (needle === '') return true;
      return entry.name.toLowerCase().includes(needle) || entry.summary.toLowerCase().includes(needle);
    }),
  );

  const monogram = (name: string): string => name.trim().slice(0, 1).toUpperCase();

  /** One line of the summary in the list; the entry itself carries the rest. */
  function oneLine(summary: string): string {
    const flat = summary.replace(/\s+/g, ' ').trim();
    return flat.length <= 90 ? flat : `${flat.slice(0, 89)}…`;
  }

  $effect(() => {
    void version;
    getCodex(campaignId)
      .then((answer) => (entities = answer.entities))
      .catch(() => (entities = []));
  });
</script>

<section>
  <h2 class="section-title">Codex <span class="label count">{entities.length}</span></h2>
  {#if openId !== null}
    <Entity
      {campaignId}
      entityId={openId}
      {version}
      {showSecrets}
      onpick={(id) => (openId = id)}
      onback={() => (openId = null)}
    />
  {:else}
    <input type="search" placeholder="Search the codex" bind:value={query} aria-label="Search the codex" />
    <div class="kinds" role="group" aria-label="Kind">
      <button type="button" class="label kind" aria-pressed={kind === null} onclick={() => (kind = null)}>All</button>
      {#each KINDS as option (option)}
        <button
          type="button"
          class="label kind"
          aria-pressed={kind === option}
          onclick={() => (kind = kind === option ? null : option)}
        >
          {option}
        </button>
      {/each}
    </div>
    {#if matches.length === 0}
      <p class="empty">Nothing named here yet.</p>
    {:else}
      <ul>
        {#each matches as entry (entry.id)}
          <li>
            <Portrait path={entry.portrait_path} monogram={monogram(entry.name)} size={28} alt="" name={entry.name} />
            <span class="lines">
              <span class="head">
                <button type="button" class="name" onclick={() => (openId = entry.id)}>{entry.name}</button>
                <span class="label kind-tag">{entry.kind}</span>
                {#if entry.status !== 'alive'}<span class="label status">{entry.status}</span>{/if}
              </span>
              {#if entry.summary}<span class="muted summary">{oneLine(entry.summary)}</span>{/if}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .count {
    margin-left: 0.4rem;
  }

  .kinds {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin: 0.5rem 0;
  }

  .kind {
    padding: 0.05rem 0.4rem;
  }

  .kind[aria-pressed='true'] {
    color: var(--accent);
    border-color: var(--accent);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /* The name opens the entry; the portrait beside it opens the lightbox instead. */
  li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0;
    border-bottom: 1px solid var(--rule);
  }

  .lines {
    display: grid;
    gap: 0.05rem;
    min-width: 0;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
  }

  .name {
    border: none;
    padding: 0;
    font-size: var(--t-15);
  }

  .kind-tag,
  .status {
    color: var(--ink-faint);
  }

  .summary {
    font-size: var(--t-13);
  }
</style>
