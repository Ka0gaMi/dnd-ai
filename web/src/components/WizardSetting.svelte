<script lang="ts">
  import type { SettingPreset } from '../lib/presets';

  let {
    presets,
    selected,
    onselect,
  }: {
    presets: SettingPreset[];
    selected: string | null;
    onselect: (id: string | null) => void;
  } = $props();

  const chosen = $derived(presets.find((preset) => preset.id === selected) ?? null);

  function surprise(): void {
    if (presets.length === 0) return;
    const pool = presets.filter((preset) => preset.id !== selected);
    const list = pool.length > 0 ? pool : presets;
    onselect(list[Math.floor(Math.random() * list.length)].id);
  }
</script>

<div class="step">
  <p class="prose muted">
    A setting tells the DM what kind of world this is. Pick one, or leave it open and say what you
    want in the premise.
  </p>

  <div class="actions">
    <button type="button" onclick={surprise}>Surprise me</button>
    <button type="button" aria-pressed={selected === null} onclick={() => onselect(null)}>None</button>
  </div>

  <ul class="grid">
    {#each presets as preset (preset.id)}
      <li>
        <button
          type="button"
          class="card"
          aria-pressed={selected === preset.id}
          onclick={() => onselect(preset.id)}
        >
          <span class="name">{preset.name}</span>
          <span class="pitch prose">{preset.pitch}</span>
          <span class="chips">
            <span class="chip">{preset.pacing}</span>
            {#each preset.tone as word (word)}
              <span class="chip">{word}</span>
            {/each}
          </span>
          <span class="notes muted">{preset.content_notes}</span>
        </button>
      </li>
    {/each}
  </ul>

  {#if chosen}
    <div class="drawer">
      <h3 class="section-title">{chosen.name}</h3>
      <h4 class="label">Themes</h4>
      <p class="prose">{chosen.themes.join(' · ')}</p>
      <h4 class="label">Typical conflicts</h4>
      <p class="prose">{chosen.typical_conflicts.join(' · ')}</p>
      <h4 class="label">Sample hooks</h4>
      <ul class="hooks">
        {#each chosen.sample_hooks as hook (hook)}
          <li class="prose">{hook}</li>
        {/each}
      </ul>
      <h4 class="label">Classes that fit</h4>
      <ul class="suggested">
        {#each chosen.suggested_classes as suggestion (suggestion.class)}
          <li class="prose"><span class="who">{suggestion.class}</span> <span class="muted">{suggestion.why}</span></li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .step {
    display: grid;
    gap: 0.8rem;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  .actions button[aria-pressed='true'] {
    color: var(--accent);
    background: var(--accent-soft);
    border-color: var(--accent);
  }

  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.6rem;
    grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  }

  .card {
    display: grid;
    gap: 0.3rem;
    width: 100%;
    height: 100%;
    text-align: left;
    padding: 0.6rem 0.7rem;
    background: var(--surface);
  }

  .card:hover {
    color: inherit;
  }

  .card[aria-pressed='true'] {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .name {
    font-family: var(--font-display);
    font-size: var(--t-18);
    color: var(--accent);
  }

  .pitch {
    font-size: var(--t-15);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .notes {
    font-size: var(--t-12);
  }

  .drawer {
    border-top: 1px solid var(--rule);
    padding-top: 0.6rem;
  }

  .drawer h4 {
    margin-top: 0.6rem;
  }

  .drawer p {
    margin: 0.1rem 0;
  }

  .hooks,
  .suggested {
    list-style: none;
    margin: 0.1rem 0;
    padding: 0;
  }

  .hooks li,
  .suggested li {
    font-size: var(--t-15);
    padding: 0.1rem 0;
  }

  .who {
    color: var(--accent);
  }
</style>
