<script lang="ts">
  import Portrait from './Portrait.svelte';
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
      <article>
        <div class="head">
          <Portrait
            path={member.portrait_path ?? null}
            monogram={member.name.slice(0, 1)}
            size={24}
            round
            alt=""
            name={member.name}
          />
          <span class="name">{member.name}</span>
          {#if member.inspiration > 0}
            <span class="star" title="Heroic Inspiration" aria-label="Heroic Inspiration"></span>
          {/if}
          <span class="hp num">{member.hp_current ?? '—'} / {member.hp_max ?? '—'}</span>
        </div>
        <p class="muted">
          {member.creature ?? member.class ?? 'Companion'} · level <span class="num">{member.level}</span> · AC
          <span class="num">{member.ac ?? '—'}</span>
        </p>
        <div class="bar" style="--fill: {fill}%">
          <span class="fill" class:good={fill >= 50} class:warn={fill >= 25 && fill < 50} class:bad={fill < 25}></span>
        </div>
        {#if conditionsOf(member).length > 0 || member.status !== 'active' || member.temp_hp > 0 || member.encumbered}
          <div class="chips">
            {#if member.temp_hp > 0}<span class="chip">+{member.temp_hp} temp</span>{/if}
            {#each conditionsOf(member) as condition (condition)}
              <span class="chip bad">{condition}</span>
            {/each}
            {#if member.status !== 'active'}<span class="chip bad">{member.status}</span>{/if}
            {#if member.encumbered}
              <span class="chip bad num">{member.carried_lb ?? '—'} / {member.capacity_lb ?? '—'} lb</span>
            {/if}
          </div>
        {/if}
      </article>
    {/each}
  </section>
{/if}

<style>
  article {
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--rule);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .name {
    font-family: var(--font-display);
    font-size: var(--t-15);
  }

  .hp {
    margin-left: auto;
    font-size: var(--t-13);
  }

  p {
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
</style>
