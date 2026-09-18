<script lang="ts">
  import { openCompanionSheet } from '../lib/companionSheet.svelte';
  import type { PartyMember } from '../lib/types';

  let { companions }: { companions: PartyMember[] } = $props();

  const conditionsOf = (member: PartyMember): string[] =>
    Array.isArray(member.conditions) ? member.conditions : [];

  const percent = (member: PartyMember): number =>
    member.hp_max ? Math.max(0, Math.min(100, ((member.hp_current ?? 0) / member.hp_max) * 100)) : 0;
</script>

{#if companions.length > 0}
  <section>
    <h2 class="section-title">Companions</h2>
    {#each companions as member (member.id)}
      {@const fill = percent(member)}
      <button
        type="button"
        class="row"
        aria-haspopup="dialog"
        onclick={() => openCompanionSheet(member.id)}
      >
        <span class="sr-only">Open the character sheet of</span>
        <span class="head">
          {#if member.portrait_path}
            <img class="portrait round" src={member.portrait_path} alt="" width="24" height="24" />
          {:else}
            <span class="portrait monogram round num" aria-hidden="true">{member.name.slice(0, 1)}</span>
          {/if}
          <span class="name">{member.name}</span>
          {#if member.inspiration > 0}
            <span class="star" title="Heroic Inspiration" aria-label="Heroic Inspiration"></span>
          {/if}
          <span class="hp num">{member.hp_current ?? '—'} / {member.hp_max ?? '—'}</span>
        </span>
        <span class="muted info">
          {member.creature ?? member.class ?? 'Companion'} · level <span class="num">{member.level}</span> · AC
          <span class="num">{member.ac ?? '—'}</span>
        </span>
        <span class="bar" style="--fill: {fill}%">
          <span class="fill" class:good={fill >= 50} class:warn={fill >= 25 && fill < 50} class:bad={fill < 25}></span>
        </span>
        {#if conditionsOf(member).length > 0 || member.status !== 'active' || member.temp_hp > 0 || member.encumbered}
          <span class="chips">
            {#if member.temp_hp > 0}<span class="chip">+{member.temp_hp} temp</span>{/if}
            {#each conditionsOf(member) as condition (condition)}
              <span class="chip bad">{condition}</span>
            {/each}
            {#if member.status !== 'active'}<span class="chip bad">{member.status}</span>{/if}
            {#if member.encumbered}
              <span class="chip bad num">{member.carried_lb ?? '—'} / {member.capacity_lb ?? '—'} lb</span>
            {/if}
          </span>
        {/if}
      </button>
    {/each}
  </section>
{/if}

<style>
  .row {
    display: block;
    width: 100%;
    padding: 0.35rem 0;
    border: none;
    border-bottom: 1px solid var(--rule);
    text-align: left;
  }

  .row:hover {
    color: inherit;
    border-color: var(--rule);
    background: var(--surface-raised);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .portrait {
    flex: none;
    width: 24px;
    height: 24px;
    border: 1px solid var(--rule);
    object-fit: cover;
  }

  .portrait.round {
    border-radius: 50%;
  }

  .monogram {
    display: grid;
    place-items: center;
    font-size: 12px;
    color: var(--ink-muted);
  }

  .name {
    font-family: var(--font-display);
    font-size: var(--t-15);
  }

  .hp {
    margin-left: auto;
    font-size: var(--t-13);
  }

  .info {
    display: block;
    margin: 0.05rem 0 0.25rem;
    font-size: var(--t-13);
  }

  .star {
    width: 0.7rem;
    height: 0.7rem;
    background: var(--accent);
    clip-path: polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%);
  }

  .bar {
    display: block;
    position: relative;
    height: 0.45rem;
    border: 1px solid var(--rule);
    background: var(--surface);
    overflow: hidden;
  }

  .fill {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: var(--fill);
  }

  .fill.good {
    background: var(--good);
  }

  .fill.warn {
    background: var(--warn);
  }

  .fill.bad {
    background: var(--bad);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.25rem;
  }
  /* Read by a screen reader ahead of the row's own text, so the button keeps its whole name. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
