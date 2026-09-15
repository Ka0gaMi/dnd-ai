<script lang="ts">
  import { ApiError, boostRoll, inspireRoll, previewRoll, resolveRoll } from '../lib/api';
  import { editedTotal, modifierText, rollLabel, secondsLeft, type RollPromptStore } from '../lib/rollprompt.svelte';
  import { groupDice, isD20, rollChips } from '../lib/store.svelte';
  import type { Die } from '../lib/types';

  let {
    prompt,
    cheat,
    inspiration = false,
    timeoutS,
    onresolved,
  }: {
    prompt: RollPromptStore;
    cheat: boolean;
    /** The player is holding Heroic Inspiration: a d20 they have seen can be rerolled with it. */
    inspiration?: boolean;
    timeoutS: number;
    onresolved: () => void;
  } = $props();

  /** How long the result stays on the card before it collapses into the ledger. */
  const SHOW_MS = 2000;

  let now = $state(Date.now());

  const roll = $derived(prompt.current);
  const result = $derived(prompt.result);
  const left = $derived(roll ? secondsLeft(roll, timeoutS, now) : 0);
  const chips = $derived(
    result
      ? rollChips({
          key: '',
          purpose: result.purpose,
          expr: result.expr,
          groups: result.groups,
          total: result.total,
          dc: result.dc,
          outcome: result.outcome,
          natural: result.natural,
          overridden: false,
          ts: '',
        })
      : null,
  );

  const dropped = (die: Die): boolean => die.modifiers.some((m) => m.startsWith('drop'));

  /** What this card is for, in the server's own words, and the dice the player may set on it. */
  const label = $derived(roll ? rollLabel(roll, prompt.context) : null);
  const dice = $derived(prompt.editableDice);
  const modifier = $derived(roll ? modifierText(roll.expr) : '');
  const boosts = $derived(roll?.boosts_available ?? []);
  /** A d20 test the player may buy a second roll of; damage is never one. */
  const inspirable = $derived(Boolean(roll) && inspiration && isD20(roll!.expr) && roll!.roll_type !== 'damage');
  const typedTotal = $derived(roll ? editedTotal(roll.expr, prompt.edit) : null);

  function handle(problem: unknown): void {
    if (problem instanceof ApiError && problem.status === 409) {
      // The timeout or the DM got there first: the ledger already has the answer.
      prompt.resolvedElsewhere();
      onresolved();
      return;
    }
    prompt.fail(problem instanceof Error ? problem.message : String(problem));
  }

  async function rollIt(): Promise<void> {
    const current = prompt.current;
    if (!current || prompt.busy) return;
    prompt.start();
    try {
      // Cheat mode edits it, inspiration rerolls it: either way the player sees it before it stands.
      if (cheat || inspirable) prompt.showPreview(await previewRoll(current.id));
      else prompt.showResult(await resolveRoll(current.id));
    } catch (problem) {
      handle(problem);
    }
  }

  /** Homebrew boosts can only be chosen while the roll is still waiting for its first result. */
  async function chooseBoost(boostId: string): Promise<void> {
    const current = prompt.current;
    if (!current || prompt.phase !== 'waiting' || prompt.busy || current.boosts_chosen?.includes(boostId)) return;
    prompt.start();
    try {
      prompt.boosted(await boostRoll(current.id, boostId));
    } catch (problem) {
      handle(problem);
    }
  }

  /** Accepts the previewed roll as it stands. */
  async function accept(): Promise<void> {
    const current = prompt.current;
    if (!current || prompt.busy) return;
    prompt.start();
    try {
      prompt.showResult(await resolveRoll(current.id));
    } catch (problem) {
      handle(problem);
    }
  }

  /** The 2024 rule: spend the star, take the second d20 whatever it says. */
  async function useInspiration(): Promise<void> {
    const current = prompt.current;
    if (!current || prompt.busy) return;
    prompt.start();
    try {
      prompt.showResult(await inspireRoll(current.id));
    } catch (problem) {
      handle(problem);
    }
  }

  /** Cheat mode sets the dice themselves; the modifiers stay as the expression wrote them. */
  async function acceptEdited(): Promise<void> {
    const current = prompt.current;
    if (!current || prompt.busy) return;
    if (typedTotal === null) {
      prompt.fail(`Set every die: ${dice.map((sides) => `1 to ${sides}`).join(', ')}.`);
      return;
    }
    prompt.start();
    try {
      prompt.showResult(await resolveRoll(current.id, { dice: prompt.edit.map((typed) => Number(typed.trim())) }));
    } catch (problem) {
      handle(problem);
    }
  }

  /** Enter does whatever the card's brass button does. */
  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || !roll || event.target instanceof HTMLInputElement) return;
    if (prompt.phase === 'waiting') rollIt();
    else if (prompt.phase === 'preview') accept();
  }

  $effect(() => {
    if (!roll || prompt.phase !== 'waiting') return;
    const waiting = roll;
    const tick = (): void => {
      now = Date.now();
      // Out of time: the server rolled it itself, so the card says so and steps aside.
      if (secondsLeft(waiting, timeoutS, now) === 0) prompt.resolvedElsewhere();
    };
    const timer = setInterval(tick, 1000);
    now = Date.now();
    return () => clearInterval(timer);
  });

  $effect(() => {
    if (prompt.phase !== 'resolved') return;
    const timer = setTimeout(() => {
      prompt.dismiss();
      onresolved();
    }, SHOW_MS);
    return () => clearTimeout(timer);
  });
</script>

<svelte:window {onkeydown} />

{#if roll}
  <section class="prompt">
    <h2 class="section-title">The DM asks you to roll</h2>
    <div class="ask">
      <span class="purpose">{roll.purpose}</span>
      <span class="expr num">{roll.expr}</span>
      {#if roll.dc !== null}<span class="chip">DC {roll.dc}</span>{/if}
      {#if label}
        <span class="chip" class:accent={prompt.context !== null}>{label}</span>
      {/if}
      {#if roll.advantage !== 'none'}<span class="chip accent">{roll.advantage}</span>{/if}
      {#if prompt.phase === 'waiting'}
        <span class="count num" class:soon={left <= 10}>{left}s</span>
      {/if}
    </div>

    {#if result}
      <div class="result">
        <span class="dice">
          {#each result.groups as group, g (g)}
            {#each groupDice(group) as die, d (d)}
              <span
                class="die num"
                class:crit={g === 0 && isD20(result.expr) && die.value === 20}
                class:fumble={g === 0 && isD20(result.expr) && die.value === 1}
                class:dropped={dropped(die)}
              >
                {die.value}
              </span>
            {/each}
          {/each}
        </span>
        <span class="total num">{result.total}</span>
        {#if chips && chips.natural !== null}
          <span class="chip" class:accent={chips.natural === 20} class:bad={chips.natural === 1}>
            Natural {chips.natural}
          </span>
        {/if}
        {#if chips?.outcome}<span class="chip {chips.outcome.tone}">{chips.outcome.label}</span>{/if}
        {#if prompt.phase === 'preview'}<span class="label">not sent yet</span>{/if}
      </div>
    {/if}

    {#if prompt.note}<p class="muted note">{prompt.note}</p>{/if}
    {#if prompt.error}<p class="chip bad">{prompt.error}</p>{/if}

    {#if prompt.phase === 'waiting' && boosts.length > 0}
      <div class="boosts" aria-label="Available homebrew boosts">
        {#each boosts as boost (boost.id)}
          {@const chosen = roll.boosts_chosen?.includes(boost.id) ?? false}
          <button
            type="button"
            class="boost"
            class:chosen
            aria-pressed={chosen}
            disabled={prompt.busy || chosen}
            onclick={() => chooseBoost(boost.id)}
          >
            <span>{boost.name}</span>
            <span class="boost-description">{boost.describe}</span>
            <span class="num">{boost.uses_left} left</span>
          </button>
        {/each}
      </div>
    {/if}

    {#if prompt.phase === 'editing'}
      <form
        class="edit"
        onsubmit={(event) => {
          event.preventDefault();
          acceptEdited();
        }}
      >
        <span class="label">Dice</span>
        {#each dice as sides, index (index)}
          <input
            type="number"
            min="1"
            max={sides}
            aria-label={`d${sides}`}
            value={prompt.edit[index] ?? ''}
            oninput={(event) => (prompt.edit[index] = event.currentTarget.value)}
          />
        {/each}
        {#if modifier}<span class="num">{modifier}</span>{/if}
        <span class="num">= {typedTotal ?? '?'}</span>
        <button type="submit" class="go" disabled={prompt.busy || typedTotal === null}>Accept</button>
        <button type="button" onclick={() => (result ? prompt.showPreview(result) : prompt.dismiss())}>
          Cancel
        </button>
      </form>
    {:else if prompt.phase === 'preview'}
      <div class="buttons">
        <button type="button" class="go" disabled={prompt.busy} onclick={accept}>Accept</button>
        {#if inspirable}
          <button type="button" disabled={prompt.busy} onclick={useInspiration}>
            Reroll with Heroic Inspiration <span aria-hidden="true">★</span>
          </button>
        {/if}
        {#if cheat}
          <button type="button" disabled={prompt.busy} onclick={() => prompt.editResult()}>Change</button>
        {/if}
      </div>
    {:else if prompt.phase === 'waiting'}
      <div class="buttons">
        <button type="button" class="go" disabled={prompt.busy} onclick={rollIt}>Roll</button>
        {#if cheat}
          <button type="button" disabled={prompt.busy} onclick={() => prompt.editResult()}>Set result…</button>
        {/if}
        <span class="label hint">Enter</span>
      </div>
    {/if}
  </section>
{/if}

<style>
  .prompt {
    border: 1px solid var(--accent);
    border-left: 3px solid var(--accent);
    background: var(--surface-raised);
    padding: 0.5rem 0.7rem 0.6rem;
  }

  .ask {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.45rem;
  }

  .purpose {
    font-size: var(--t-18);
    font-weight: 500;
  }

  .expr {
    font-size: var(--t-13);
    color: var(--ink-faint);
  }

  .count {
    margin-left: auto;
    font-size: var(--t-13);
    color: var(--ink-faint);
  }

  .count.soon {
    color: var(--warn);
  }

  .result {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.45rem;
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
    font-size: var(--t-36);
    font-weight: 600;
    line-height: 1;
  }

  .note {
    margin: 0.3rem 0 0;
    font-size: var(--t-13);
  }

  .buttons,
  .edit,
  .boosts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.5rem;
  }

  .boosts {
    align-items: stretch;
  }

  .boost {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.3rem;
    text-align: left;
  }

  .boost.chosen {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .boost-description {
    color: var(--ink-muted);
  }

  .edit input {
    width: 4rem;
    font-family: var(--font-mono);
    font-size: var(--t-13);
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule);
    padding: 0.1rem 0.3rem;
    margin-left: 0.3rem;
  }

  .go {
    color: var(--accent);
    border-color: var(--accent);
  }

  button:disabled {
    color: var(--ink-faint);
    border-color: var(--rule);
    cursor: not-allowed;
  }

  .hint {
    border: 1px solid var(--rule);
    padding: 0 0.3rem;
  }

  @media (prefers-reduced-motion: no-preference) {
    .die.crit {
      animation: brass-pulse 900ms ease-out 1;
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
