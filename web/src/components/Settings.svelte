<script lang="ts">
  import { patchSettings } from '../lib/api';
  import Help from './Help.svelte';
  import {
    DIFFICULTY_OPTIONS,
    ENCUMBRANCE_OPTIONS,
    PLAYER_ROLLS_OPTIONS,
    ROLL_MODE_OPTIONS,
    RULES_MODE_OPTIONS,
    TREASURE_PACING_OPTIONS,
    VISIBILITY_OPTIONS,
    XP_MODE_OPTIONS,
    luckWord,
    type CampaignSettings,
  } from '../lib/settings';

  let {
    campaignId,
    settings,
    onchange,
  }: {
    campaignId: number;
    settings: CampaignSettings;
    onchange: (settings: CampaignSettings) => void;
  } = $props();

  let error = $state<string | null>(null);

  async function patch(part: Partial<CampaignSettings>): Promise<void> {
    try {
      onchange(await patchSettings(campaignId, part));
      error = null;
    } catch (problem) {
      error = problem instanceof Error ? problem.message : String(problem);
    }
  }

  function setTimeout_(value: string): void {
    const seconds = Number(value);
    if (Number.isInteger(seconds) && seconds > 0) patch({ roll_timeout_s: seconds });
  }
</script>

<div class="panel">
  <div class="row">
    <span class="label">Enemy detail</span>
    <span class="segmented" role="group" aria-label="Enemy detail">
      {#each VISIBILITY_OPTIONS as option (option.id)}
        <button
          type="button"
          aria-pressed={settings.visibility === option.id}
          title={option.hint}
          onclick={() => patch({ visibility: option.id })}
        >
          {option.label}
        </button>
      {/each}
    </span>
  </div>

  <div class="row">
    <span class="label">Rolls</span>
    <span class="segmented" role="group" aria-label="Who rolls">
      {#each ROLL_MODE_OPTIONS as option (option.id)}
        <button
          type="button"
          aria-pressed={settings.roll_mode === option.id}
          onclick={() => patch({ roll_mode: option.id })}
        >
          {option.label}
        </button>
      {/each}
    </span>
    <label class="timeout">
      <span class="label">Timeout</span>
      <input
        type="number"
        min="5"
        max="600"
        step="5"
        value={settings.roll_timeout_s}
        onchange={(event) => setTimeout_(event.currentTarget.value)}
      />
      <span class="label">s</span>
    </label>
  </div>

  <div class="row">
    <span class="label">In a fight</span>
    <span class="segmented" role="group" aria-label="Which dice you roll in a fight">
      {#each PLAYER_ROLLS_OPTIONS as option (option.id)}
        <button
          type="button"
          aria-pressed={settings.player_rolls === option.id}
          title={option.hint}
          disabled={settings.roll_mode !== 'player'}
          onclick={() => patch({ player_rolls: option.id })}
        >
          {option.label}
        </button>
      {/each}
    </span>
    <span class="muted note">Which dice the fight asks you for: attacks and saves, damage too, or none.</span>
  </div>

  <div class="row">
    <span class="label">Luck</span>
    <input
      type="range"
      min="-2"
      max="2"
      step="1"
      aria-label="Luck dial"
      value={settings.luck_bias}
      onchange={(event) => patch({ luck_bias: Number(event.currentTarget.value) })}
    />
    <span class="word num">{luckWord(settings.luck_bias)}</span>
  </div>

  <div class="row">
    <span class="label">Encumbrance</span>
    <span class="segmented" role="group" aria-label="Encumbrance">
      {#each ENCUMBRANCE_OPTIONS as option (option.id)}
        <button
          type="button"
          aria-pressed={settings.encumbrance === option.id}
          title={option.hint}
          onclick={() => patch({ encumbrance: option.id })}
        >
          {option.label}
        </button>
      {/each}
    </span>
    <span class="muted note">Whether carrying too much slows the party down.</span>
  </div>

  <div class="row">
    <span class="label"><Help k="rules_mode" text="Rules" label /></span>
    <span class="segmented" role="group" aria-label="Rules mode">
      {#each RULES_MODE_OPTIONS as option (option.id)}
        <button
          type="button"
          aria-pressed={settings.rules_mode === option.id}
          title={option.hint}
          onclick={() => patch({ rules_mode: option.id })}
        >
          {option.label}
        </button>
      {/each}
    </span>
    <span class="muted note" class:warn={settings.rules_mode === 'freeform'}>
      {RULES_MODE_OPTIONS.find((option) => option.id === settings.rules_mode)?.hint}
    </span>
  </div>

  <div class="row">
    <span class="label"><Help k="xp_mode" text="Levelling" label /></span>
    <span class="segmented" role="group" aria-label="XP mode">
      {#each XP_MODE_OPTIONS as option (option.id)}
        <button
          type="button"
          aria-pressed={settings.xp_mode === option.id}
          title={option.hint}
          onclick={() => patch({ xp_mode: option.id })}
        >
          {option.label}
        </button>
      {/each}
    </span>
    <span class="muted note">{XP_MODE_OPTIONS.find((option) => option.id === settings.xp_mode)?.hint}</span>
  </div>

  <div class="row">
    <span class="label">Difficulty</span>
    <span class="segmented" role="group" aria-label="Difficulty">
      {#each DIFFICULTY_OPTIONS as option (option.id)}
        <button
          type="button"
          aria-pressed={settings.difficulty === option.id}
          onclick={() => patch({ difficulty: option.id })}
        >
          {option.label}
        </button>
      {/each}
    </span>
    <span class="muted note">How hard fights are built for a solo party. A fight you pick deliberately keeps its real strength.</span>
  </div>

  <div class="row">
    <span class="label">Treasure pacing</span>
    <span class="segmented" role="group" aria-label="Treasure pacing">
      {#each TREASURE_PACING_OPTIONS as option (option.id)}
        <button
          type="button"
          aria-pressed={settings.treasure_pacing === option.id}
          onclick={() => patch({ treasure_pacing: option.id })}
        >
          {option.label}
        </button>
      {/each}
    </span>
    <span class="muted note">How freely treasure is handed out.</span>
  </div>

  <div class="row">
    <span class="label">Rules coach</span>
    <button
      type="button"
      class="toggle"
      aria-pressed={settings.rules_coach}
      onclick={() => patch({ rules_coach: !settings.rules_coach })}
    >
      {settings.rules_coach ? 'On' : 'Off'}
    </button>
    <span class="muted note">The DM explains a rule in one sentence the first time it matters each session.</span>
  </div>

  <div class="row">
    <span class="label">Auto portraits</span>
    <button
      type="button"
      class="toggle"
      aria-pressed={settings.auto_portraits}
      onclick={() => patch({ auto_portraits: !settings.auto_portraits })}
    >
      {settings.auto_portraits ? 'On' : 'Off'}
    </button>
    <span class="muted note">Portraits are generated automatically for your character, companions and enemies when Cloudflare portraits are enabled.</span>
  </div>

  <div class="row">
    <span class="label">Cheat mode</span>
    <button
      type="button"
      class="toggle"
      aria-pressed={settings.cheat_mode}
      onclick={() => patch({ cheat_mode: !settings.cheat_mode })}
    >
      {settings.cheat_mode ? 'On' : 'Off'}
    </button>
    <span class="muted note">Edit your own rolls and sheet numbers. The DM never sees any of it.</span>
  </div>

  <div class="row">
    <span class="label">Spoilers</span>
    <button
      type="button"
      class="toggle"
      aria-pressed={settings.show_secrets}
      onclick={() => patch({ show_secrets: !settings.show_secrets })}
    >
      {settings.show_secrets ? 'On' : 'Off'}
    </button>
    <span class="muted note">Shows the DM's secrets — hidden threads, clues and notes. Spoils surprises.</span>
  </div>

  {#if error}<span class="chip bad">{error}</span>{/if}
</div>

<style>
  .panel {
    flex-basis: 100%;
    display: grid;
    gap: 0.4rem;
    padding: 0.5rem 0 0.2rem;
    border-top: 1px solid var(--rule);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .row > .label:first-child {
    min-width: 7rem;
  }

  button {
    font-family: var(--font-mono);
    font-size: var(--t-12);
    letter-spacing: 0.04em;
    color: var(--ink-muted);
  }

  .toggle[aria-pressed='true'] {
    color: var(--accent);
    background: var(--accent-soft);
    border-color: var(--accent);
  }

  .timeout {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }

  input[type='number'] {
    width: 4rem;
    font-family: var(--font-mono);
    font-size: var(--t-12);
    color: var(--ink);
    background: var(--surface-raised);
    border: 1px solid var(--rule);
    padding: 0.1rem 0.3rem;
  }

  input[type='range'] {
    width: 9rem;
    accent-color: var(--accent);
  }

  .word {
    font-size: var(--t-12);
    color: var(--accent);
  }

  .note {
    font-size: var(--t-13);
  }

  /* Freeform lets anything on the sheet: the line under it says so in the warning colour. */
  .note.warn {
    color: var(--warn);
  }
</style>
