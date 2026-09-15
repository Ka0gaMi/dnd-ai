<script lang="ts">
  import Help from './Help.svelte';
  import type { DialValue, SessionZeroField, ToneDial } from '../lib/presets';

  let {
    dials,
    values,
    fields,
    lines,
    veils,
    ondial,
    onlines,
    onveils,
  }: {
    dials: ToneDial[];
    values: Record<string, DialValue>;
    fields: SessionZeroField[];
    lines: string;
    veils: string;
    ondial: (id: string, value: DialValue) => void;
    onlines: (text: string) => void;
    onveils: (text: string) => void;
  } = $props();

  const LEVELS: DialValue[] = [1, 2, 3];

  const field = (id: string): SessionZeroField | null => fields.find((entry) => entry.id === id) ?? null;
</script>

<div class="step">
  <p class="prose muted">
    Six dials tell the DM how this story feels. A setting sets them for you; move whatever does not
    match the game you want.
  </p>

  <ul class="dials">
    {#each dials as dial (dial.id)}
      <li>
        <span class="label">{dial.name}</span>
        <span class="segmented" role="group" aria-label={dial.name}>
          {#each LEVELS as level (level)}
            <button
              type="button"
              aria-pressed={(values[dial.id] ?? 2) === level}
              onclick={() => ondial(dial.id, level)}
            >
              {dial.levels[level - 1]}
            </button>
          {/each}
        </span>
      </li>
    {/each}
  </ul>

  {#each [{ id: 'lines', value: lines, set: onlines }, { id: 'veils', value: veils, set: onveils }] as row (row.id)}
    {@const entry = field(row.id)}
    <div class="safety">
      <label for={`story-${row.id}`}>
        <Help
          help={entry ? { title: entry.name, text: entry.help } : null}
          text={entry?.name ?? row.id}
          label
        />
      </label>
      <p class="hint muted">{entry?.help ?? ''}</p>
      <input
        id={`story-${row.id}`}
        type="text"
        value={row.value}
        oninput={(event) => row.set(event.currentTarget.value)}
      />
    </div>
  {/each}
</div>

<style>
  .step {
    display: grid;
    gap: 0.8rem;
  }

  .dials {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }

  .dials li {
    display: grid;
    gap: 0.2rem;
  }

  /* The level words are long, so this one wraps; the rest comes from .segmented. */
  .segmented {
    display: flex;
    flex-wrap: wrap;
  }

  .segmented button {
    flex: 1;
    min-width: 9rem;
    font-family: var(--font-body);
    font-size: var(--t-13);
    text-align: left;
  }

  .safety {
    display: grid;
    gap: 0.15rem;
  }

  .hint {
    max-width: 65ch;
    margin: 0;
    font-size: var(--t-13);
  }

  input {
    font-family: var(--font-body);
    font-size: var(--t-15);
    max-width: 65ch;
    color: var(--ink);
    background: var(--surface-raised);
    border: 1px solid var(--rule);
    padding: 0.3rem 0.5rem;
  }

  input:focus {
    border-color: var(--accent);
  }
</style>
