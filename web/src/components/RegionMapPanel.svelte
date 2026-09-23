<script lang="ts">
  import RegionMap from './RegionMap.svelte';
  import { getRegionMap } from '../lib/api';
  import type { PlayerRegionMap } from '../lib/regionmap';

  let {
    campaignId,
    version,
  }: {
    campaignId: number;
    /** Bumped by the store when an event could have changed the codex. */
    version: number;
  } = $props();

  let map = $state<PlayerRegionMap | null | undefined>(undefined);
  let problem = $state<string | null>(null);
  let loadedId: number | null = null;

  $effect(() => {
    const id = campaignId;
    void version;
    let live = true;
    if (id !== loadedId) {
      map = undefined;
      loadedId = id;
    }
    getRegionMap(id)
      .then((answer) => {
        if (!live) return;
        map = answer;
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
  <h2 class="section-title">Map</h2>
  {#if problem}
    <p class="chip bad">{problem}</p>
  {:else if map === undefined}
    <p class="muted">Loading the map…</p>
  {:else}
    <RegionMap {map} />
  {/if}
</section>
