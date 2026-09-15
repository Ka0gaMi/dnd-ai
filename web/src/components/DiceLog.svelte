<script lang="ts">
  import { groupDice, isD20, RECENT_ROLLS, rollChips, visibleRolls } from '../lib/store.svelte';
  import type { Die, RollEntry } from '../lib/types';

  const EXPANDED_KEY = 'dndai.dice.expanded';

  let { rolls, cheat = false }: { rolls: RollEntry[]; cheat?: boolean } = $props();

  let expanded = $state(remembered());

  const shown = $derived(visibleRolls(rolls, expanded));

  const dropped = (die: Die): boolean => die.modifiers.some((m) => m.startsWith('drop'));

  /** Collapsed unless the player last expanded it (and on the server, where there is no storage). */
  function remembered(): boolean {
    return typeof localStorage !== 'undefined' && localStorage.getItem(EXPANDED_KEY) === 'true';
  }

  function setExpanded(value: boolean): void {
    expanded = value;
    localStorage.setItem(EXPANDED_KEY, String(value));
  }
</script>

<section>
  <h2 class="section-title">Dice</h2>
  {#if rolls.length === 0}
    <p class="empty">No rolls yet.</p>
  {:else}
    <ol>
      {#each shown as roll (roll.key)}
        {@const chips = rollChips(roll)}
        <li>
          <div class="head">
            <span class="purpose">{roll.purpose}</span>
            <span class="expr num">{roll.expr}</span>
          </div>
          <div class="result">
            <span class="dice">
              {#each roll.groups as group, g (g)}
                {#each groupDice(group) as die, d (d)}
                  <span
                    class="die num"
                    class:crit={g === 0 && isD20(roll.expr) && die.value === 20}
                    class:fumble={g === 0 && isD20(roll.expr) && die.value === 1}
                    class:dropped={dropped(die)}
                  >
                    {die.value}
                  </span>
                {/each}
              {/each}
            </span>
            <span class="total num">{roll.total}</span>
            {#if roll.dc !== null}<span class="dc num">DC {roll.dc}</span>{/if}
            {#if chips.natural !== null}
              <span class="chip natural" class:accent={chips.natural === 20} class:bad={chips.natural === 1}>
                Natural {chips.natural}
              </span>
            {/if}
            {#if chips.outcome}
              <span class="chip {chips.outcome.tone}">{chips.outcome.label}</span>
            {/if}
            {#if cheat && roll.overridden}
              <span class="edited label" title="You set this result yourself.">edited</span>
            {/if}
          </div>
          {#if (roll.rules_applied ?? []).length > 0}
            <div class="rules">
              {#each roll.rules_applied ?? [] as rule, i (i)}
                <span class="chip rule">{rule}</span>
              {/each}
            </div>
          {/if}
        </li>
      {/each}
    </ol>
    {#if rolls.length > RECENT_ROLLS}
      <button type="button" class="label more" onclick={() => setExpanded(!expanded)}>
        {expanded ? 'Show recent' : `Show all (${rolls.length})`}
      </button>
    {/if}
  {/if}
</section>

<style>
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--rule);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
  }

  .purpose {
    font-weight: 500;
  }

  .expr {
    font-size: var(--t-12);
    color: var(--ink-faint);
  }

  .result {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.2rem;
  }

  .dice {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .die {
    min-width: 1.7rem;
    text-align: center;
    font-size: var(--t-13);
    padding: 0.05rem 0.25rem;
    border: 1px solid var(--rule);
    color: var(--ink-muted);
  }

  .die.crit {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-soft);
  }

  .die.fumble {
    border-color: var(--bad);
    color: var(--bad);
  }

  .die.dropped {
    color: var(--ink-faint);
    text-decoration: line-through;
  }

  .total {
    font-size: var(--t-24);
    font-weight: 600;
    line-height: 1;
    margin-left: 0.15rem;
  }

  .dc {
    font-size: var(--t-12);
    color: var(--ink-faint);
  }

  /* What the server added on top of the DM's expression: a tool bonus, exhaustion, advantage. */
  .rules {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.2rem;
  }

  .rule {
    color: var(--ink-faint);
  }

  /* Only the player's window knows a roll was edited, and only while they are cheating. */
  .edited {
    color: var(--accent);
    text-transform: none;
    letter-spacing: 0.04em;
  }

  .more {
    display: block;
    border: none;
    padding: 0.4rem 0;
    color: var(--ink-muted);
  }

  @media (prefers-reduced-motion: no-preference) {
    li {
      animation: slide-in 160ms ease-out;
    }

    .die.crit,
    .chip.natural.accent {
      animation: brass-pulse 900ms ease-out 1;
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

    @keyframes brass-pulse {
      0% {
        box-shadow: 0 0 0 0 var(--accent-soft);
      }
      35% {
        box-shadow: 0 0 10px 3px var(--accent-soft);
      }
      100% {
        box-shadow: 0 0 0 0 transparent;
      }
    }
  }
</style>
