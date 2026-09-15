<script lang="ts">
  import type { NowState } from '../lib/types';

  let { now }: { now: NowState | null } = $props();
</script>

{#if now}
  <p class="now">
    <span class="date num">{now.date_text}</span>
    <span class="chip">{now.time_of_day}</span>
    <span class="chip">{now.season}</span>
    <span class="muted weather">{now.weather}</span>
  </p>
{/if}

<style>
  .now {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.6rem;
    margin: 0;
    font-size: var(--t-13);
  }

  .date {
    font-size: var(--t-13);
    color: var(--ink-muted);
  }

  .weather {
    font-style: italic;
  }
</style>
