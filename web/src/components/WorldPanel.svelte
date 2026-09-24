<script lang="ts">
  import { getWorld, regardLabel, type PlayerWorld } from '../lib/world';

  let {
    campaignId,
    version,
  }: {
    campaignId: number;
    /** Bumped by the store when an event could have changed the world. */
    version: number;
  } = $props();

  let world = $state<PlayerWorld | null | undefined>(undefined);
  let problem = $state<string | null>(null);
  let loadedId: number | null = null;

  $effect(() => {
    const id = campaignId;
    void version;
    let live = true;
    if (id !== loadedId) {
      world = undefined;
      loadedId = id;
    }
    getWorld(id)
      .then((answer) => {
        if (!live) return;
        world = answer;
        problem = null;
      })
      .catch((failure) => {
        if (!live) return;
        problem = failure instanceof Error ? failure.message : String(failure);
      });
    return () => {
      live = false;
    };
  });
</script>

<section>
  <h2 class="section-title">World</h2>
  {#if problem}
    <p class="chip bad">{problem}</p>
  {:else if world === undefined}
    <p class="muted">Loading the world…</p>
  {:else if world === null}
    <p class="muted">Nothing has reached the party's ears yet.</p>
  {:else}
    {#if world.clocks.length > 0}
      <h3 class="label">Threats</h3>
      {#each world.clocks as clock (clock.id)}
        <article>
          <p class="head">{clock.faction} — {clock.goal}</p>
          <div class="clock" role="img" aria-label={`${clock.filled} of ${clock.size} segments filled`}>
            {#each Array.from({ length: clock.size }, (_, index) => index) as segment (segment)}
              <span class="segment" class:filled={segment < clock.filled}></span>
            {/each}
          </div>
          {#if clock.signs.length > 0}
            <ul class="signs muted">
              {#each clock.signs as sign, index (index)}
                <li>{sign}</li>
              {/each}
            </ul>
          {/if}
        </article>
      {/each}
    {/if}

    {#if world.news.length > 0}
      <h3 class="label">News</h3>
      <ul class="news">
        {#each world.news as item (item.id)}
          <li>
            <span class="prose">{item.text}</span>
            {#if item.local}<span class="chip">local</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}

    {#if world.regard.length > 0}
      <h3 class="label">Standing</h3>
      <ul class="regard">
        {#each world.regard as faction (faction.id)}
          <li>
            <span>{faction.faction}: {regardLabel(faction.value)}</span>
            {#if faction.reasons.length > 0}
              <span class="muted reason">{faction.reasons[0].reason}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  h3 {
    margin: 0.7rem 0 0.25rem;
  }

  article {
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--rule);
    margin-bottom: 0.4rem;
  }

  .head {
    margin: 0;
    font-weight: 500;
  }

  .clock {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    margin: 0.3rem 0;
  }

  .segment {
    width: 0.7rem;
    height: 0.7rem;
    border: 1px solid var(--rule);
    background: var(--surface-raised);
  }

  .segment.filled {
    background: var(--accent);
    border-color: var(--accent);
  }

  .signs {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: var(--t-13);
  }

  ul.news,
  ul.regard {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: var(--t-13);
  }

  ul.news li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.45rem;
    padding: 0.15rem 0;
    border-bottom: 1px solid var(--rule);
  }

  ul.regard li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    padding: 0.1rem 0;
  }

  .reason {
    font-size: var(--t-13);
  }
</style>
