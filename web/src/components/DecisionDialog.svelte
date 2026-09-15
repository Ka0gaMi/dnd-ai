<script lang="ts">
  import PowerReport from './PowerReport.svelte';
  import { ApiError, resolveDecision } from '../lib/api';
  import {
    buildDecisionEdit,
    decisionNumericFields,
    decisionTitle,
    type DecisionChoice,
    type DecisionStore,
    type HomebrewDecisionPayload,
    type HomebrewSpellPayload,
    type HomebrewSubclassPayload,
  } from '../lib/decisions.svelte';
  import { mechanicsWords, spellEffectWords, spellHeader } from '../lib/progression';
  import { secondsLeft } from '../lib/rollprompt.svelte';

  let {
    decisions,
    timeoutS,
    onresolved,
  }: {
    decisions: DecisionStore;
    timeoutS: number;
    /** Accepted homebrew goes on the sheet: the window asks for a fresh snapshot. */
    onresolved: () => void;
  } = $props();

  let now = $state(Date.now());

  /** Subclass features come in bundles at these four levels, and only these four. */
  const SUBCLASS_LEVELS = ['3', '6', '10', '14'];

  const decision = $derived(decisions.current);
  const fields = $derived(decision ? decisionNumericFields(decision) : []);
  const left = $derived(decision ? secondsLeft(decision, timeoutS, now) : 0);

  async function answer(choice: DecisionChoice): Promise<void> {
    const current = decisions.current;
    if (!current || decisions.busy) return;
    decisions.start();
    try {
      decisions.showResult(await resolveDecision(current.id, choice));
      onresolved();
    } catch (problem) {
      fail(problem);
    }
  }

  /** "Edit" sends the numbers the player typed; the server prices them again before applying. */
  async function acceptEdited(): Promise<void> {
    const current = decisions.current;
    if (!current || decisions.busy) return;
    const edited = buildDecisionEdit(current, decisions.edit);
    if ('error' in edited) {
      decisions.fail(edited.error);
      return;
    }
    decisions.start();
    try {
      decisions.showResult(await resolveDecision(current.id, 'edit', edited.edits));
      onresolved();
    } catch (problem) {
      fail(problem);
    }
  }

  function fail(problem: unknown): void {
    if (problem instanceof ApiError && problem.status === 409) {
      decisions.alreadyAnswered();
      return;
    }
    decisions.fail(problem instanceof Error ? problem.message : String(problem));
  }

  /** The DM waits as long as they wait for a roll, then carries on; the card does not go away. */
  $effect(() => {
    if (!decision || decisions.phase === 'answered' || decisions.timedOut) return;
    const waiting = decision;
    const tick = (): void => {
      now = Date.now();
      if (secondsLeft(waiting, timeoutS, now) === 0) decisions.markTimedOut();
    };
    const timer = setInterval(tick, 1000);
    now = Date.now();
    return () => clearInterval(timer);
  });
</script>

{#if decision}
  <section class="decision">
    <h2 class="title">{decisionTitle(decision)}</h2>

    {#if decision.kind === 'homebrew_subclass'}
      {@const payload = decision.payload as HomebrewSubclassPayload}
      <p class="prose">{payload.schema.flavour_text}</p>
      {#if payload.justification}<blockquote class="prose muted">{payload.justification}</blockquote>{/if}
      {#each SUBCLASS_LEVELS as level (level)}
        {@const features = payload.schema.features[level] ?? []}
        {@const bundle = payload.report.bundles.find((b) => String(b.level) === level)}
        <div class="bundle">
          <h3 class="label">Level {level}</h3>
          {#if features.length === 0}
            <p class="muted note">Nothing new at this level.</p>
          {:else}
            {#each features as feature (feature.name)}
              <div class="feature">
                <span class="feature-name">{feature.name}</span>
                <p class="prose muted">{feature.text}</p>
                {#if feature.mechanics}
                  <ul class="mechanics">
                    {#each mechanicsWords(feature.mechanics) as word, index (index)}
                      <li>{word}</li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/each}
          {/if}
          {#if bundle}
            <PowerReport
              report={{
                budget_used: bundle.budget_used,
                budget_allowed: bundle.budget_allowed,
                items: bundle.items,
                verdict: bundle.verdict,
                text: '',
              }}
              open={bundle.verdict === 'over_budget'}
            />
          {/if}
        </div>
      {/each}
    {:else if decision.kind === 'homebrew_spell'}
      {@const payload = decision.payload as HomebrewSpellPayload}
      <p class="spell-head">{spellHeader(payload.schema)}</p>
      <p class="prose">{spellEffectWords(payload.schema.effect)}</p>
      <p class="prose muted">{payload.schema.text}</p>
      {#if payload.justification}<blockquote class="prose muted">{payload.justification}</blockquote>{/if}
      <PowerReport report={payload.report} open={payload.report.verdict === 'over_budget'} />
    {:else}
      {@const payload = decision.payload as HomebrewDecisionPayload}
      {@const words = mechanicsWords(payload.mechanics)}
      <p class="prose">{payload.text}</p>

      {#if words.length > 0}
        <ul class="mechanics">
          {#each words as word, index (index)}
            <li>{word}</li>
          {/each}
        </ul>
      {/if}

      {#if payload.justification}
        <blockquote class="prose muted">{payload.justification}</blockquote>
      {/if}

      <PowerReport report={payload.report} open={payload.report.verdict === 'over_budget'} />
    {/if}

    {#if decisions.timedOut && decisions.phase !== 'answered'}
      <p class="muted note">The DM stopped waiting and moved on. Your answer still counts.</p>
    {/if}
    {#if decisions.note}<p class="muted note">{decisions.note}</p>{/if}
    {#if decisions.error}<p class="chip bad">{decisions.error}</p>{/if}

    {#if decisions.phase === 'answered'}
      <div class="buttons">
        <button type="button" onclick={() => decisions.dismiss()}>Close</button>
      </div>
    {:else if decisions.phase === 'editing'}
      <form
        class="edit"
        onsubmit={(event) => {
          event.preventDefault();
          acceptEdited();
        }}
      >
        {#each fields as field (field.key)}
          <label>
            <span class="label">{field.label}</span>
            <input
              type="number"
              min={field.min}
              max={field.max}
              value={decisions.edit[field.key] ?? String(field.value)}
              aria-label={field.label}
              oninput={(event) => (decisions.edit[field.key] = event.currentTarget.value)}
            />
          </label>
        {/each}
        {#if fields.length === 0}
          <p class="muted note">Nothing here has a number to change.</p>
        {/if}
        <button type="submit" class="go" disabled={decisions.busy || fields.length === 0}>Accept edited</button>
        <button type="button" onclick={() => decisions.cancelEdit()}>Cancel</button>
      </form>
    {:else}
      <div class="buttons">
        <button type="button" class="go" disabled={decisions.busy} onclick={() => answer('accept')}>Accept</button>
        <button type="button" disabled={decisions.busy} onclick={() => answer('reject')}>Reject</button>
        <button type="button" disabled={decisions.busy} onclick={() => decisions.startEdit()}>Edit</button>
        {#if !decisions.timedOut}
          <span class="count num" class:soon={left <= 10}>{left}s</span>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .decision {
    display: grid;
    gap: 0.4rem;
    border: 1px solid var(--accent);
    border-left: 3px solid var(--accent);
    background: var(--surface-raised);
    padding: 0.5rem 0.7rem 0.6rem;
  }

  .title {
    font-family: var(--font-display);
    font-size: var(--t-18);
    color: var(--accent);
    padding-bottom: 0.35rem;
    border-bottom: 1px solid var(--rule);
  }

  p {
    margin: 0;
  }

  .mechanics {
    list-style: none;
    margin: 0;
    padding: 0;
    font-family: var(--font-mono);
    font-size: var(--t-13);
    color: var(--ink-muted);
  }

  .bundle {
    display: grid;
    gap: 0.3rem;
    padding: 0.35rem 0;
    border-top: 1px solid var(--rule);
  }

  .feature {
    display: grid;
    gap: 0.1rem;
  }

  .feature-name {
    font-weight: 500;
  }

  .spell-head {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--t-13);
    color: var(--ink-muted);
  }

  blockquote {
    margin: 0;
    padding-left: 0.5rem;
    border-left: 1px solid var(--rule);
    font-size: var(--t-13);
    font-style: italic;
  }

  .note {
    font-size: var(--t-13);
  }

  .buttons,
  .edit {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }

  .edit label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }

  .edit input {
    width: 4rem;
    font-family: var(--font-mono);
    font-size: var(--t-13);
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule);
    padding: 0.1rem 0.3rem;
  }

  .count {
    margin-left: auto;
    font-size: var(--t-13);
    color: var(--ink-faint);
  }

  .count.soon {
    color: var(--warn);
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
</style>
