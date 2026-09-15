<script lang="ts">
  import { fightLogChips, fightLogNotes, type Totals } from '../lib/combat.svelte';
  import type { Combatant, CombatLogEntry } from '../lib/types';

  const EXPANDED_KEY = 'dndai.fight.expanded';
  const RECENT = 8;

  let {
    log,
    combatants,
    totals,
  }: { log: CombatLogEntry[]; combatants: Combatant[]; totals: Map<number, Totals> } = $props();

  let expanded = $state(typeof localStorage !== 'undefined' && localStorage.getItem(EXPANDED_KEY) === 'true');

  const shown = $derived(expanded ? log : log.slice(0, RECENT));
  const names = $derived(new Map(combatants.map((c) => [c.id, c.name])));
  const scored = $derived(
    combatants
      .map((c) => ({ id: c.id, name: c.name, team: c.team, ...(totals.get(c.id) ?? { dealt: 0, taken: 0, healed: 0 }) }))
      .filter((row) => row.dealt > 0 || row.taken > 0 || row.healed > 0),
  );

  function setExpanded(value: boolean): void {
    expanded = value;
    localStorage.setItem(EXPANDED_KEY, String(value));
  }
</script>

<section>
  <h2 class="section-title">Fight log</h2>
  {#if log.length === 0}
    <p class="empty">Nothing has happened yet.</p>
  {:else}
    {#if scored.length > 0}
      <ul class="totals">
        {#each scored as row (row.id)}
          <li class={row.team}>
            <span class="who">{row.name}</span>
            <span class="num" title="Damage dealt">{row.dealt}</span>
            <span class="num" title="Damage taken">{row.taken}</span>
            <span class="num" title="Healed">{row.healed}</span>
          </li>
        {/each}
        <li class="heads label">
          <span class="who">Totals</span><span>dealt</span><span>taken</span><span>healed</span>
        </li>
      </ul>
    {/if}

    <ol>
      {#each shown as entry (entry.id)}
        {@const chips = fightLogChips(entry)}
        {@const notes = fightLogNotes(entry)}
        <li>
          <div class="head">
            <span class="round num">R{entry.round}</span>
            <span class="who">
              {names.get(entry.actor_id ?? -1) ?? ''}
              {#if entry.actor_id !== null && entry.target_id !== null}<span class="arrow">→</span>{/if}
              {names.get(entry.target_id ?? -1) ?? ''}
            </span>
            <span class="chip">{entry.kind.replace('_', ' ')}</span>
          </div>
          {#if chips.length > 0}
            <div class="chips">
              {#each chips as chip, i (i)}
                <span class="chip {chip.tone}">{chip.label}</span>
              {/each}
            </div>
          {:else}
            <p class="prose muted">{entry.text}</p>
          {/if}
          {#each notes as note, i (i)}
            <p class="prose muted">{note}</p>
          {/each}
        </li>
      {/each}
    </ol>

    {#if log.length > RECENT}
      <button type="button" class="label more" onclick={() => setExpanded(!expanded)}>
        {expanded ? 'Show recent' : `Show all (${log.length})`}
      </button>
    {/if}
  {/if}
</section>

<style>
  ol,
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .totals li {
    display: grid;
    grid-template-columns: 1fr 3rem 3rem 3rem;
    gap: 0.3rem;
    font-size: var(--t-13);
    text-align: right;
    border-bottom: 1px solid var(--rule);
    padding: 0.05rem 0;
  }

  .totals .who {
    text-align: left;
  }

  .totals li.enemy .who {
    color: var(--ink-muted);
  }

  .totals .heads {
    border-bottom: none;
    order: -1;
  }

  .totals {
    display: flex;
    flex-direction: column;
    margin-bottom: 0.6rem;
  }

  ol li {
    padding: 0.3rem 0;
    border-bottom: 1px solid var(--rule);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    font-size: var(--t-13);
  }

  .round {
    font-size: var(--t-12);
    color: var(--ink-faint);
  }

  .arrow {
    color: var(--ink-faint);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.2rem;
  }

  p {
    margin: 0.1rem 0 0;
    font-size: var(--t-13);
  }

  .more {
    display: block;
    border: none;
    padding: 0.4rem 0;
    color: var(--ink-muted);
  }

  @media (prefers-reduced-motion: no-preference) {
    ol li {
      animation: slide-in 160ms ease-out;
    }

    @keyframes slide-in {
      from {
        opacity: 0;
        transform: translateY(-0.35rem);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
  }
</style>
