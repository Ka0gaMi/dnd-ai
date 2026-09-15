<script lang="ts">
  import { getPlayProfile } from '../lib/api';
  import { engineSummary, exemplarQuotes, tagBars, type PlayProfile } from '../lib/progression';

  let {
    campaignId,
    characterId = null,
    version,
  }: {
    campaignId: number;
    /** Whose play this is; without it the card counts the whole table's. */
    characterId?: number | null;
    /** Bumped by the store when an event could have added a note or a tally. */
    version: number;
  } = $props();

  let open = $state(false);
  let profile = $state<PlayProfile | null>(null);

  const bars = $derived(profile ? tagBars(profile) : []);
  const quotes = $derived(profile ? exemplarQuotes(profile) : []);
  const tallies = $derived(profile ? engineSummary(profile) : []);

  $effect(() => {
    void version;
    if (!open) return;
    getPlayProfile(campaignId, characterId ?? undefined)
      .then((fresh) => (profile = fresh))
      .catch(() => (profile = null));
  });
</script>

<section>
  <h2 class="section-title">
    <button type="button" class="toggle" aria-expanded={open} onclick={() => (open = !open)}>
      <span class="chevron" class:open aria-hidden="true"></span>
      How you play
    </button>
  </h2>
  {#if open}
    {#if bars.length === 0 && quotes.length === 0 && tallies.length === 0}
      <p class="empty">The DM has not noted anything yet.</p>
    {:else}
      {#if bars.length > 0}
        <ul class="tags">
          {#each bars as bar (bar.tag)}
            <li>
              <span class="label tag">{bar.label}</span>
              <span class="track"><span class="fill" style="width: {bar.share}%"></span></span>
              <span class="num count">{bar.count}</span>
            </li>
          {/each}
        </ul>
      {/if}
      {#if quotes.length > 0}
        <h3 class="label">For example</h3>
        {#each quotes as quote (quote.created_at)}
          <blockquote class="prose muted">{quote.text}</blockquote>
        {/each}
      {/if}
      {#if tallies.length > 0}
        <h3 class="label">What the engine has seen</h3>
        {#each tallies as line (line.label)}
          <p class="tally"><span class="label">{line.label}</span> <span class="muted">{line.text}</span></p>
        {/each}
      {/if}
    {/if}
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

  .tags {
    list-style: none;
    margin: 0 0 0.4rem;
    padding: 0;
  }

  .tags li {
    display: grid;
    grid-template-columns: 7rem 1fr auto;
    align-items: center;
    gap: 0.4rem;
    padding: 0.1rem 0;
  }

  .tag {
    color: var(--ink-muted);
  }

  .track {
    height: 0.35rem;
    background: var(--surface);
    border: 1px solid var(--rule);
  }

  .fill {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .count {
    font-size: var(--t-12);
    color: var(--ink-faint);
  }

  blockquote {
    margin: 0.15rem 0;
    padding-left: 0.5rem;
    border-left: 1px solid var(--rule);
    font-size: var(--t-13);
    font-style: italic;
  }

  .tally {
    margin: 0.1rem 0;
    font-size: var(--t-13);
  }

  @media (prefers-reduced-motion: no-preference) {
    .chevron {
      transition: transform 0.15s ease-out;
    }
  }
</style>
