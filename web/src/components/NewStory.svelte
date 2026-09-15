<script lang="ts">
  import WizardCharacter from './WizardCharacter.svelte';
  import WizardSetting from './WizardSetting.svelte';
  import WizardTone from './WizardTone.svelte';
  import { ApiError, createCampaign, getPresets } from '../lib/api';
  import { EMPTY_PRESETS, defaultDials, findPreset, type DialValue, type PresetFile } from '../lib/presets';
  import {
    STEPS,
    STORY_SHAPES,
    campaignBody,
    chosenForYou,
    dmTodoLine,
    draftLine,
    emptyDraft,
    type CreatedCharacter,
    type DmWork,
    type StepId,
  } from '../lib/wizard';

  let {
    onclose,
    onopen,
  }: {
    onclose: () => void;
    /** The player chose to play the story they just made: select it in the window. */
    onopen: (id: number) => void;
  } = $props();

  let file = $state<PresetFile>(EMPTY_PRESETS);
  let draft = $state(emptyDraft());
  let step = $state<StepId>('name');
  let created = $state<{ id: number; name: string; needs_ai_fill: { name: boolean; premise: boolean } } | null>(
    null,
  );
  /** What POST .../character answered: a sheet, or the draft the DM will finish. */
  let made = $state<CreatedCharacter | null>(null);
  let creating = $state(false);
  let error = $state<string | null>(null);

  const index = $derived(STEPS.findIndex((entry) => entry.id === step));
  const preset = $derived(findPreset(file, draft.setting_preset));
  const work = $derived<DmWork>({
    needs_ai_fill: created?.needs_ai_fill,
    character_draft: made?.character_draft ?? null,
    pc: made?.character ?? null,
  });

  $effect(() => {
    getPresets()
      .then((next) => (file = next))
      .catch(() => (error = 'Could not load the setting presets. The server may need a restart.'));
  });

  /** A setting comes with a reading of the six dials; the player moves whatever they disagree with. */
  function chooseSetting(id: string | null): void {
    draft = { ...draft, setting_preset: id, tone_dials: defaultDials(id, file.tone_dials) };
  }

  function setDial(id: string, value: DialValue): void {
    draft = { ...draft, tone_dials: { ...draft.tone_dials, [id]: value } };
  }

  function go(next: StepId): void {
    step = next;
  }

  async function create(): Promise<boolean> {
    if (created) return true;
    creating = true;
    error = null;
    try {
      const row = await createCampaign(campaignBody(draft));
      created = {
        id: row.id,
        name: row.name,
        needs_ai_fill: { name: !draft.name.trim(), premise: !row.premise },
      };
      return true;
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : String(failure);
      return false;
    } finally {
      creating = false;
    }
  }

  async function next(): Promise<void> {
    if (step === 'premise') {
      if (await create()) go('character');
      return;
    }
    go(STEPS[Math.min(index + 1, STEPS.length - 1)].id);
  }

  /** "Skip ahead": the shell exists at once and the DM invents everything left empty in play. */
  async function skipAhead(): Promise<void> {
    if (await create()) go('done');
  }
</script>

<main>
  <div class="top">
    <h1>New story</h1>
    <button type="button" onclick={onclose}>Back to stories</button>
  </div>

  <ol class="dots">
    {#each STEPS as entry, i (entry.id)}
      <li class="label" class:now={entry.id === step} class:past={i < index} aria-current={entry.id === step ? 'step' : undefined}>
        <span class="dot"></span>{entry.title}
      </li>
    {/each}
  </ol>

  {#if error}<p class="chip bad">{error}</p>{/if}

  {#if step === 'name'}
    <form
      class="step"
      onsubmit={(event) => {
        event.preventDefault();
        next();
      }}
    >
      <label class="label" for="story-name">What is this story called? (optional)</label>
      <p class="prose muted">Leave it empty and the DM names it once it knows what the story is.</p>
      <input id="story-name" type="text" bind:value={draft.name} autocomplete="off" />

      <span class="label shape-title">Shape</span>
      {#each STORY_SHAPES as shape (shape.id)}
        <label class="choice" for={`story-shape-${shape.id}`}>
          <input
            id={`story-shape-${shape.id}`}
            type="radio"
            name="story-shape"
            value={shape.id}
            checked={draft.story_shape === shape.id}
            onchange={() => (draft = { ...draft, story_shape: shape.id })}
          />
          <span>
            <span class="pick">{shape.label}</span>
            <span class="prose muted line">{shape.line}</span>
          </span>
        </label>
      {/each}

      <div class="nav">
        <button type="submit">Next</button>
        <button type="button" onclick={skipAhead} disabled={creating}>
          Skip ahead — let the DM do the rest
        </button>
      </div>
    </form>
  {:else if step === 'setting'}
    <div class="step">
      <WizardSetting presets={file.presets} selected={draft.setting_preset} onselect={chooseSetting} />
      <div class="nav">
        <button type="button" onclick={() => go('name')}>Back</button>
        <button type="button" onclick={next}>Next</button>
      </div>
    </div>
  {:else if step === 'tone'}
    <div class="step">
      <WizardTone
        dials={file.tone_dials}
        values={draft.tone_dials}
        fields={file.session_zero_fields}
        lines={draft.lines}
        veils={draft.veils}
        ondial={setDial}
        onlines={(text) => (draft = { ...draft, lines: text })}
        onveils={(text) => (draft = { ...draft, veils: text })}
      />
      <div class="nav">
        <button type="button" onclick={() => go('setting')}>Back</button>
        <button type="button" onclick={next}>Next</button>
      </div>
    </div>
  {:else if step === 'premise'}
    <div class="step">
      <label class="label" for="story-premise">Premise (optional)</label>
      <p class="prose muted">Leave empty and the DM invents it from the name and setting.</p>
      <textarea id="story-premise" rows="5" bind:value={draft.premise}></textarea>
      <div class="nav">
        <button type="button" onclick={() => go('tone')}>Back</button>
        <button type="button" onclick={next} disabled={creating}>
          {creating ? 'Creating…' : 'Create the story'}
        </button>
      </div>
    </div>
  {:else if step === 'character' && created}
    <div class="step">
      <p class="prose muted">
        <strong>{created.name}</strong> exists. Now the person you play — or leave it to the DM.
      </p>
      <WizardCharacter
        campaignId={created.id}
        suggested={preset?.suggested_classes ?? []}
        onskip={() => go('done')}
        ondone={(result) => {
          made = result;
          go('done');
        }}
      />
    </div>
  {:else if step === 'done' && created}
    {@const story = created}
    {@const todo = dmTodoLine(work)}
    {@const chosen = made ? chosenForYou(made) : []}
    <div class="step">
      <div class="summary">
        <h2 class="name">{story.name}</h2>
        <p class="prose">
          <span class="chip">{draft.story_shape}</span>
          {#if preset}<span class="chip">{preset.name}</span>{/if}
        </p>
        {#if made?.character}
          <p class="prose">Playing <strong>{made.character.name}</strong>.</p>
        {:else if made?.character_draft}
          <p class="prose muted">Your character so far: {draftLine(made.character_draft)}</p>
        {:else}
          <p class="prose muted">No character yet — the DM will build one with you in chat.</p>
        {/if}
        {#if chosen.length > 0}
          <p class="prose muted">Chosen for you: {chosen.join('; ')}</p>
        {/if}
        {#if todo}
          <p class="prose muted">{todo}</p>
        {/if}
        <p class="prose">
          Open in ChatGPT: type <span class="num">/resume</span> and pick {story.name}.
        </p>
      </div>
      <div class="nav">
        <button type="button" class="primary" onclick={() => onopen(story.id)}>
          Open {story.name} in this window
        </button>
        <button type="button" onclick={onclose}>Back to stories</button>
      </div>
    </div>
  {/if}
</main>

<style>
  main {
    max-width: 56rem;
    padding: 2.5rem 2rem 4rem clamp(1.5rem, 6vw, 5rem);
  }

  .top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  h1 {
    font-family: var(--font-display);
    font-size: var(--t-36);
    color: var(--accent);
  }

  .dots {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 0.9rem;
    margin: 0 0 1.2rem;
    padding: 0 0 0.5rem;
    border-bottom: 1px solid var(--rule);
  }

  .dots li {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    border: 1px solid var(--ink-faint);
  }

  .past .dot {
    background: var(--ink-faint);
  }

  .now {
    color: var(--accent);
  }

  .now .dot {
    background: var(--accent);
    border-color: var(--accent);
  }

  .step {
    display: grid;
    gap: 0.5rem;
    justify-items: start;
  }

  .step > :global(*) {
    max-width: 100%;
  }

  input[type='text'],
  textarea {
    font-family: var(--font-body);
    font-size: var(--t-18);
    width: min(100%, 34rem);
    color: var(--ink);
    background: var(--surface-raised);
    border: 1px solid var(--rule);
    padding: 0.35rem 0.55rem;
  }

  textarea {
    font-size: var(--t-15);
    width: min(100%, 65ch);
  }

  input:focus,
  textarea:focus {
    border-color: var(--accent);
  }

  .shape-title {
    margin-top: 0.6rem;
  }

  .choice {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  .pick {
    display: block;
  }

  .line {
    display: block;
    font-size: var(--t-13);
  }

  input[type='radio'] {
    accent-color: var(--accent);
  }

  .nav {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .primary {
    color: var(--accent);
    border-color: var(--accent);
  }

  .summary {
    display: grid;
    gap: 0.3rem;
    width: min(100%, 65ch);
    padding: 0.8rem 0.9rem;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-left: 3px solid var(--accent);
  }

  .name {
    font-family: var(--font-display);
    font-size: var(--t-24);
    color: var(--accent);
  }

  .summary p {
    margin: 0;
  }

  .chip + .chip {
    margin-left: 0.3rem;
  }
</style>
