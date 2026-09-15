<script lang="ts">
  import type { EncounterEnd } from '../lib/combat.svelte';

  let { end }: { end: EncounterEnd } = $props();
</script>

<section>
  <h2 class="section-title">Encounter over</h2>
  <p class="prose">
    The fight ended in <span class="outcome">{end.outcome}</span> after
    <span class="num">{end.rounds}</span>
    {end.rounds === 1 ? 'round' : 'rounds'}.
  </p>
  {#if end.defeated.length > 0}
    <p class="prose muted">
      Defeated: {end.defeated
        .map((foe) => (foe.cr === null ? foe.name : `${foe.name} (CR ${foe.cr}, ${foe.xp} XP)`))
        .join(', ')}.
    </p>
  {/if}
  {#if end.xp_suggestion > 0}
    <p class="label">Suggested XP <span class="num">{end.xp_suggestion}</span></p>
  {/if}
  {#if end.combatants && end.combatants.length > 0}
    <ul class="tally">
      <li class="label"><span class="who">Totals</span><span>dealt</span><span>taken</span><span>healed</span></li>
      {#each end.combatants as row (row.id)}
        <li class={row.team}>
          <span class="who" class:down={!row.alive}>{row.name}</span>
          <span class="num" title="Damage dealt">{row.damage_dealt}</span>
          <span class="num" title="Damage taken">{row.damage_taken}</span>
          <span class="num" title="Healed">{row.healed}</span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  section {
    border: 1px solid var(--accent);
    padding: 0.5rem 0.6rem;
  }

  p {
    margin: 0.15rem 0;
    font-size: var(--t-13);
  }

  .outcome {
    color: var(--accent);
  }

  .tally {
    list-style: none;
    margin: 0.4rem 0 0;
    padding: 0;
  }

  .tally li {
    display: grid;
    grid-template-columns: 1fr 3rem 3rem 3rem;
    gap: 0.3rem;
    font-size: var(--t-13);
    text-align: right;
  }

  .tally .who {
    text-align: left;
  }

  .tally li.enemy .who {
    color: var(--ink-muted);
  }

  .tally .down {
    text-decoration: line-through;
  }
</style>
