<script lang="ts">
  import Help from './Help.svelte';
  import Portrait from './Portrait.svelte';
  import type { Combatant } from '../lib/types';

  let {
    combatants,
    activeId,
    round,
    surprised = new Set(),
    portraitOf = () => null,
  }: {
    combatants: Combatant[];
    activeId: number | null;
    round: number;
    /** Who was caught out when the fight began, as the initiative entries marked them. */
    surprised?: Set<number>;
    portraitOf?: (combatant: Combatant) => string | null;
  } = $props();

  const order = $derived([...combatants].sort((a, b) => a.initiative_order - b.initiative_order));
</script>

<section>
  <h2 class="section-title">Initiative · round <span class="num">{round}</span></h2>
  <ol>
    {#each order as combatant (combatant.id)}
      <li class={combatant.team} class:active={combatant.id === activeId} class:down={!combatant.alive}>
        <Portrait
          path={portraitOf(combatant)}
          monogram={combatant.marker}
          size={24}
          round
          alt=""
          name={combatant.name}
        />
        <span class="who">
          <span class="name">{combatant.name}</span>
          <span class="init num"><Help k="initiative" text={String(combatant.initiative)} /></span>
          {#if surprised.has(combatant.id)}
            <span class="chip warn"><Help k="surprise" text="Surprised" /></span>
          {/if}
        </span>
      </li>
    {/each}
  </ol>
</section>

<style>
  ol {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0;
    padding: 0;
  }

  li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.45rem;
    border: 1px solid var(--rule);
    border-left: 3px solid var(--ink-faint);
    background: var(--surface);
  }

  li.party {
    border-left-color: var(--info);
  }

  li.enemy {
    border-left-color: var(--bad);
  }

  li.active {
    background: var(--surface-raised);
    border-color: var(--accent);
    border-left-color: var(--accent);
    box-shadow: 0 1px 0 var(--accent);
  }

  li.down .name,
  li.down .init {
    text-decoration: line-through;
    color: var(--ink-faint);
  }

  li.active :global(.portrait) {
    color: var(--accent);
    border-color: var(--accent);
  }

  .who {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: var(--t-13);
  }

  .init {
    font-size: var(--t-12);
    color: var(--ink-faint);
  }
</style>
