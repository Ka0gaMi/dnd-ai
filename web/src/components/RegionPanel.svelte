<script lang="ts">
  import { getRegion, postRegion } from '../lib/api';
  import {
    DEFAULT_TAG_CHOICE,
    TAG_GROUPS,
    parseSeed,
    summaryLine,
    tagsFor,
    type PlayerRegionSummary,
    type RegionRequest,
    type TagChoice,
  } from '../lib/region';

  let {
    campaignId,
    initial,
    onchange = () => undefined,
  }: {
    campaignId: number;
    initial?: PlayerRegionSummary | null;
    onchange?: (region: PlayerRegionSummary) => void;
  } = $props();

  // svelte-ignore state_referenced_locally -- the caller's initial summary is a starting point, not a live binding.
  let region = $state<PlayerRegionSummary | null>(initial ?? null);
  let choice = $state<TagChoice>({ ...DEFAULT_TAG_CHOICE });
  let seedText = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  /** Which form the player reopened after a region exists; null leaves both hidden. */
  let openForm = $state<'generate' | 'upload' | null>(null);

  const replacing = $derived(region !== null);

  const message = (problem: unknown): string => (problem instanceof Error ? problem.message : String(problem));

  /** Only when the caller has not already told us: an undefined initial means "load it yourself". */
  $effect(() => {
    if (initial !== undefined) return;
    getRegion(campaignId)
      .then((answer) => (region = answer.region))
      .catch((problem) => (error = message(problem)));
  });

  function pick(groupId: string, optionId: string | null): void {
    choice = { ...choice, [groupId]: optionId };
  }

  async function generate(): Promise<void> {
    const seed = parseSeed(seedText);
    if (seed === null) {
      error = 'That seed is not a whole number.';
      return;
    }
    await send({ mode: 'generate', seed: seed ?? undefined, tags: tagsFor(choice), replace: replacing });
  }

  async function upload(event: Event): Promise<void> {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    let realm: unknown;
    try {
      realm = JSON.parse(await file.text());
    } catch {
      error = 'That file is not JSON.';
      return;
    }
    await send({ mode: 'upload', realm: realm as object, replace: replacing });
  }

  async function send(body: RegionRequest): Promise<void> {
    busy = true;
    error = null;
    try {
      const answer = await postRegion(campaignId, body);
      region = answer.region;
      openForm = null;
      onchange(answer.region);
    } catch (problem) {
      error = message(problem);
    } finally {
      busy = false;
    }
  }
</script>

<section class="panel">
  <h2 class="section-title">Region</h2>
  <p class="muted hint">The DM sets the story in this region. Dangers stay hidden from you until the story reveals them.</p>

  {#if region}
    <p class="summary">{summaryLine(region)}</p>
    {#if region.settlements.length > 0}
      <ul class="settlements">
        {#each region.settlements as settlement}
          <li><span class="name">{settlement.name}</span> <span class="muted size">{settlement.size}</span></li>
        {/each}
      </ul>
    {/if}
    {#if region.tags.length > 0}
      <div class="chips">
        {#each region.tags as tag (tag)}
          <span class="chip">{tag}</span>
        {/each}
      </div>
    {/if}
    <div class="actions">
      <button type="button" onclick={() => (openForm = 'generate')} disabled={busy}>Generate another</button>
      <button type="button" onclick={() => (openForm = 'upload')} disabled={busy}>Upload another</button>
    </div>
  {/if}

  {#if !region || openForm === 'generate'}
    <div class="form">
      {#each TAG_GROUPS as group (group.id)}
        <div class="row">
          <span class="label">{group.label}</span>
          <span class="segmented" role="group" aria-label={group.label}>
            <button
              type="button"
              aria-pressed={choice[group.id] === null}
              disabled={busy}
              onclick={() => pick(group.id, null)}
            >
              Any
            </button>
            {#each group.options as option (option.id)}
              <button
                type="button"
                aria-pressed={choice[group.id] === option.id}
                disabled={busy}
                onclick={() => pick(group.id, option.id)}
              >
                {option.label}
              </button>
            {/each}
          </span>
        </div>
      {/each}
      <div class="row">
        <span class="label">Seed</span>
        <input type="text" placeholder="random" aria-label="Seed" bind:value={seedText} disabled={busy} />
        <button type="button" onclick={generate} disabled={busy}>Generate</button>
      </div>
    </div>
  {/if}

  {#if !region || openForm === 'upload'}
    <div class="row">
      <span class="label">Upload</span>
      <input type="file" accept=".json" aria-label="Region file" disabled={busy} onchange={upload} />
    </div>
  {/if}

  {#if busy}
    <p class="muted note">Generating the region — this opens a browser in the background and can take up to a minute.</p>
  {/if}
  {#if error}<span class="chip bad">{error}</span>{/if}
</section>

<style>
  .panel {
    display: grid;
    gap: 0.5rem;
  }

  .hint,
  .note {
    font-size: var(--t-13);
    margin: 0;
  }

  .summary {
    margin: 0;
    font-size: var(--t-15);
  }

  .settlements {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .settlements li {
    font-size: var(--t-15);
    padding: 0.05rem 0;
  }

  .name {
    color: var(--accent);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .form {
    display: grid;
    gap: 0.4rem;
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

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  input[type='text'] {
    width: 8rem;
    font-family: var(--font-mono);
    font-size: var(--t-12);
    color: var(--ink);
    background: var(--surface-raised);
    border: 1px solid var(--rule);
    padding: 0.1rem 0.3rem;
  }
</style>
