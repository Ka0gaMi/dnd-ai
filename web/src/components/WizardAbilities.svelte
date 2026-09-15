<script lang="ts">
  import Help from './Help.svelte';
  import {
    ABILITIES,
    ABILITY_NAMES,
    POINT_BUY_BUDGET,
    STANDARD_ARRAY,
    abilityMod,
    assignStandard,
    bonusOptions,
    pointBuyCost,
    pointBuyScores,
    signed,
    standardScores,
    type AbilityId,
    type Scores,
  } from '../lib/wizard';

  let {
    method,
    abilities,
    bonusOption,
    allowed,
    background,
    problems,
    onmethod,
    onscores,
    onbonus,
  }: {
    method: 'standard_array' | 'point_buy';
    abilities: Scores;
    bonusOption: string | null;
    /** The three abilities the chosen background may raise. */
    allowed: string[];
    background: string;
    problems: { abilities?: string; bonuses?: string };
    onmethod: (method: 'standard_array' | 'point_buy') => void;
    onscores: (scores: Scores) => void;
    onbonus: (id: string) => void;
  } = $props();

  const POINT_BUY_RANGE = [8, 9, 10, 11, 12, 13, 14, 15];

  const options = $derived(bonusOptions(allowed));
  const spent = $derived(method === 'point_buy' ? pointBuyCost(abilities) : 0);
  const bonuses = $derived(options.find((option) => option.id === bonusOption)?.bonuses ?? {});

  function setMethod(next: 'standard_array' | 'point_buy'): void {
    if (next === method) return;
    onmethod(next);
    onscores(next === 'standard_array' ? standardScores() : pointBuyScores());
  }

  function setScore(ability: AbilityId, value: number): void {
    onscores(
      method === 'standard_array'
        ? assignStandard(abilities, ability, value)
        : { ...abilities, [ability]: value },
    );
  }
</script>

<div class="block">
  <div class="row">
    <span class="label">Ability scores</span>
    <span class="segmented" role="group" aria-label="How to set ability scores">
      <button type="button" aria-pressed={method === 'standard_array'} onclick={() => setMethod('standard_array')}>
        Standard array
      </button>
      <button type="button" aria-pressed={method === 'point_buy'} onclick={() => setMethod('point_buy')}>
        Point buy
      </button>
    </span>
    {#if method === 'standard_array'}
      <span class="muted note">Hand out 15, 14, 13, 12, 10 and 8; swapping one swaps the other back.</span>
    {:else}
      <span class="num note" class:over={spent > POINT_BUY_BUDGET}>
        {POINT_BUY_BUDGET - spent} of {POINT_BUY_BUDGET} points left
      </span>
    {/if}
  </div>

  <ul class="scores">
    {#each ABILITIES as ability (ability)}
      {@const bonus = bonuses[ability] ?? 0}
      {@const total = abilities[ability] + bonus}
      <li>
        <label class="label" for={`char-ability-${ability}`}>
          <Help k={`ability.${ability}`} text={ABILITY_NAMES[ability]} />
        </label>
        <select
          id={`char-ability-${ability}`}
          value={abilities[ability]}
          onchange={(event) => setScore(ability, Number(event.currentTarget.value))}
        >
          {#each method === 'standard_array' ? STANDARD_ARRAY : POINT_BUY_RANGE as value (value)}
            <option {value}>{value}</option>
          {/each}
        </select>
        <span class="num bonus">{bonus > 0 ? `+${bonus}` : ''}</span>
        <span class="num total">{total}</span>
        <span class="num mod">{signed(abilityMod(total))}</span>
      </li>
    {/each}
  </ul>
  {#if problems.abilities}<p class="chip bad" id="char-abilities-error">{problems.abilities}</p>{/if}

  {#if allowed.length > 0}
    <fieldset>
      <legend class="label">{background} bonus</legend>
      <p class="prose muted note">
        The background raises its three abilities by +2 and +1, or by +1 each.
      </p>
      {#each options as option (option.id)}
        <label class="choice" for={`char-bonus-${option.id}`}>
          <input
            id={`char-bonus-${option.id}`}
            type="radio"
            name="char-bonus"
            value={option.id}
            checked={bonusOption === option.id}
            onchange={() => onbonus(option.id)}
          />
          <span>{option.label}</span>
        </label>
      {/each}
      {#if problems.bonuses}<p class="chip bad" id="char-bonuses-error">{problems.bonuses}</p>{/if}
    </fieldset>
  {/if}
</div>

<style>
  .block {
    display: grid;
    gap: 0.5rem;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .segmented button {
    font-family: var(--font-mono);
    font-size: var(--t-12);
    letter-spacing: 0.04em;
  }

  .note {
    font-size: var(--t-13);
  }

  .over {
    color: var(--bad);
  }

  .scores {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.2rem;
  }

  .scores li {
    display: grid;
    grid-template-columns: 8rem 5rem 2rem 2.5rem 2.5rem;
    align-items: center;
    gap: 0.4rem;
  }

  select {
    font-family: var(--font-mono);
    font-size: var(--t-15);
    color: var(--ink);
    background: var(--surface-raised);
    border: 1px solid var(--rule);
    padding: 0.15rem 0.3rem;
  }

  select:focus {
    border-color: var(--accent);
  }

  .bonus {
    font-size: var(--t-12);
    color: var(--accent);
  }

  .total {
    font-size: var(--t-15);
  }

  .mod {
    font-size: var(--t-18);
    color: var(--accent);
  }

  fieldset {
    display: grid;
    gap: 0.15rem;
    border: none;
    border-top: 1px solid var(--rule);
    margin: 0.3rem 0 0;
    padding: 0.4rem 0 0;
  }

  legend {
    padding: 0;
  }

  .choice {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: var(--t-15);
  }

  input[type='radio'] {
    accent-color: var(--accent);
  }

  .chip {
    justify-self: start;
    margin: 0.2rem 0 0;
    white-space: normal;
  }
</style>
