<script lang="ts">
  import Help from './Help.svelte';
  import WizardAbilities from './WizardAbilities.svelte';
  import { ApiError, createCharacter, getCharacterOptions } from '../lib/api';
  import {
    ABILITY_NAMES,
    CLASS_INFO,
    EMPTY_OPTIONS,
    LANGUAGES_TO_CHOOSE,
    SPELLBOOK_SIZE,
    characterBody,
    characterProblems,
    emptyCharacter,
    featChoiceFields,
    fieldForError,
    isCompleteCharacter,
    pickSlots,
    speciesLineages,
    type AbilityId,
    type CharacterOptions,
    type CreatedCharacter,
    type FeatureChoice,
    type FieldId,
    type Scores,
  } from '../lib/wizard';

  let {
    campaignId,
    suggested,
    onskip,
    ondone,
  }: {
    campaignId: number;
    /** The classes the chosen setting recommends, with the reason it gives. */
    suggested: Array<{ class: string; why: string }>;
    onskip: () => void;
    /** The answer: a finished sheet, or the draft the server kept for the DM. */
    ondone: (result: CreatedCharacter) => void;
  } = $props();

  let mode = $state<'ask' | 'build'>('ask');
  let draft = $state(emptyCharacter());
  let options = $state<CharacterOptions>(EMPTY_OPTIONS);
  let tried = $state(false);
  let sending = $state(false);
  let serverError = $state<string | null>(null);
  let serverField = $state<FieldId | null>(null);

  const problems = $derived(characterProblems(draft, options));
  const shown = $derived<Partial<Record<FieldId, string>>>(
    tried ? { ...problems, ...(serverField ? { [serverField]: serverError } : {}) } : {},
  );
  const casting = $derived(options.class_detail?.spellcasting ?? null);
  const lineages = $derived(speciesLineages(options, draft.species));
  /** The prepared spells are pages of the book already; the player names the rest. */
  const extraPages = $derived(SPELLBOOK_SIZE - (casting?.spells_to_choose ?? 0));
  const tools = $derived(options.class_detail?.tool_choices ?? []);
  const toolsWanted = $derived(tools.reduce((sum, group) => sum + group.choose, 0));
  const featFields = $derived(featChoiceFields(options.background_detail?.feat.choices));
  const slots = $derived(pickSlots(draft, options));
  const why = (name: string): string | null => suggested.find((s) => s.class === name)?.why ?? null;

  const skillLabel = (key: string): string =>
    key
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

  const bundleText = (items: Array<{ name: string; qty: number }>, gold: number): string =>
    [...items.map((item) => `${item.qty}x ${item.name}`), ...(gold ? [`${gold} gp`] : [])].join(', ');

  const optionLabel = (value: string): string => ABILITY_NAMES[value as AbilityId] ?? skillLabel(value);

  const traitText = (traits: Array<{ name: string; text: string }>): string =>
    traits.map((trait) => `${trait.name}: ${trait.text}`).join(' ');

  const inBook = (spell: string): boolean => draft.spells.includes(spell) || draft.spellbook.includes(spell);

  /** The options endpoint is asked again only when one of the three picks changes. */
  let loadedFor = '';

  $effect(() => {
    const query = { class: draft.class, species: draft.species, background: draft.background };
    const key = `${query.class}|${query.species}|${query.background}`;
    if (key === loadedFor) return;
    loadedFor = key;
    getCharacterOptions(query)
      .then((next) => {
        if (loadedFor === key) options = next;
      })
      .catch(() => undefined);
  });

  function pickClass(name: string): void {
    draft = {
      ...draft,
      class: name,
      skills: [],
      equipment: null,
      equipment_picks: [],
      tools: [],
      feature_options: {},
      cantrips: [],
      spells: [],
      spellbook: [],
    };
  }

  function pickBackground(name: string): void {
    draft = { ...draft, background: name, bonus_option: null, background_equipment: null, feat_choices: {} };
  }

  function setFeature(choice: FeatureChoice, option: string): void {
    const picked = draft.feature_options[choice.feature] ?? [];
    draft = {
      ...draft,
      feature_options: { ...draft.feature_options, [choice.feature]: toggle(picked, option, choice.choose) },
    };
  }

  function setFeatChoice(key: string, value: string): void {
    draft = { ...draft, feat_choices: { ...draft.feat_choices, [key]: value } };
  }

  /** One name per "choose from this category" slot; an empty one is left to the server. */
  function setPick(index: number, value: string): void {
    const picks = [...draft.equipment_picks];
    while (picks.length <= index) picks.push('');
    picks[index] = value;
    draft = { ...draft, equipment_picks: picks };
  }

  /** Checkbox groups stop at their count: the server refuses anything else. */
  function toggle(list: string[], value: string, limit: number): string[] {
    if (list.includes(value)) return list.filter((entry) => entry !== value);
    return list.length >= limit ? list : [...list, value];
  }

  async function submit(): Promise<void> {
    tried = true;
    serverError = null;
    serverField = null;
    if (Object.keys(problems).length > 0) return;
    sending = true;
    try {
      ondone(await createCharacter(campaignId, characterBody(draft, options)));
    } catch (problem) {
      serverError = problem instanceof ApiError ? problem.message : String(problem);
      serverField = fieldForError(serverError);
    } finally {
      sending = false;
    }
  }
</script>

{#if mode === 'ask'}
  <div class="paths">
    <button type="button" class="path" onclick={onskip}>
      <span class="head">Let the DM build it with me in chat</span>
      <span class="prose muted">
        The DM asks you what you want to play and fills the sheet in as you answer. Nothing to do here.
      </span>
    </button>
    <button type="button" class="path" onclick={() => (mode = 'build')}>
      <span class="head">Build it here</span>
      <span class="prose muted">
        Class, species, background, scores and starting gear, with every choice explained.
      </span>
    </button>
  </div>
{:else}
  <form
    class="build"
    onsubmit={(event) => {
      event.preventDefault();
      submit();
    }}
  >
    {#if serverError && serverField === null}
      <p class="chip bad top">{serverError}</p>
    {/if}

    <section>
      <h3 class="label">Class</h3>
      <ul class="grid">
        {#each options.classes as option (option.name)}
          {@const info = CLASS_INFO[option.name]}
          <li>
            <button
              type="button"
              class="card"
              aria-pressed={draft.class === option.name}
              onclick={() => pickClass(option.name)}
            >
              <span class="name">{option.name}</span>
              <span class="prose desc">{info?.desc ?? ''}</span>
              <span class="chips">
                {#each info?.roles ?? [] as role (role)}
                  <span class="chip">{role}</span>
                {/each}
                <span class="chip">{info?.complexity ?? ''}</span>
                <span class="chip">{option.hit_die}</span>
              </span>
              {#if why(option.name)}
                <span class="chip accent fit">fits this setting — {why(option.name)}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
      {#if shown.class}<p class="chip bad">{shown.class}</p>{/if}
    </section>

    <section>
      <h3 class="label">Species</h3>
      <ul class="grid small">
        {#each options.species as option (option.name)}
          <li>
            <button
              type="button"
              class="card"
              aria-pressed={draft.species === option.name}
              onclick={() => (draft = { ...draft, species: option.name, lineage: '' })}
            >
              <span class="name">{option.name}</span>
              <span class="chips">
                {#if option.size}<span class="chip">{option.size}</span>{/if}
                <span class="chip">{option.speed} ft</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
      {#if shown.species}<p class="chip bad">{shown.species}</p>{/if}
    </section>

    {#if lineages.length > 0}
      <section>
        <h3 class="label">Lineage</h3>
        <p class="prose muted note">
          Which kind of {draft.species} you are. Leave it and the DM picks it with you.
        </p>
        <ul class="grid">
          {#each lineages as lineage, i (i)}
            <li>
              <button
                type="button"
                class="card"
                aria-pressed={draft.lineage === lineage.name}
                onclick={() => (draft = { ...draft, lineage: lineage.name })}
              >
                <span class="name">{lineage.name}</span>
                <span class="prose desc muted">{traitText(lineage.traits)}</span>
              </button>
            </li>
          {/each}
        </ul>
        {#if shown.lineage}<p class="chip bad">{shown.lineage}</p>{/if}
      </section>
    {/if}

    <section>
      <h3 class="label">Background</h3>
      <ul class="grid small">
        {#each options.backgrounds as option (option.name)}
          <li>
            <button
              type="button"
              class="card"
              aria-pressed={draft.background === option.name}
              onclick={() => pickBackground(option.name)}
            >
              <span class="name">{option.name}</span>
              <span class="prose desc muted">{option.skills.map(skillLabel).join(', ')}</span>
              <span class="chips">
                <span class="chip">{option.feat}</span>
                {#each option.ability_scores as ability (ability)}
                  <span class="chip">{ability}</span>
                {/each}
              </span>
            </button>
          </li>
        {/each}
      </ul>
      {#if shown.background}<p class="chip bad">{shown.background}</p>{/if}
    </section>

    <section>
      <WizardAbilities
        method={draft.ability_method}
        abilities={draft.abilities}
        bonusOption={draft.bonus_option}
        allowed={options.background_detail?.ability_scores ?? []}
        background={draft.background}
        problems={{ abilities: shown.abilities, bonuses: shown.bonuses }}
        onmethod={(method) => (draft = { ...draft, ability_method: method })}
        onscores={(scores: Scores) => (draft = { ...draft, abilities: scores })}
        onbonus={(id) => (draft = { ...draft, bonus_option: id })}
      />
    </section>

    {#if options.class_detail}
      {@const detail = options.class_detail}
      {@const wanted = detail.skill_choices.reduce((sum, group) => sum + group.choose, 0)}
      {#if detail.skill_choices.length > 0}
        <section>
          <h3 class="label"><Help k="skills" text="Skills" /></h3>
          {#each detail.skill_choices as group (group.desc)}
            <p class="prose muted note">{group.desc} — choose {group.choose}.</p>
            <ul class="checks">
              {#each group.from as skill (skill)}
                <li>
                  <label class="choice" for={`char-skill-${skill}`}>
                    <input
                      id={`char-skill-${skill}`}
                      type="checkbox"
                      checked={draft.skills.includes(skill)}
                      onchange={() => (draft = { ...draft, skills: toggle(draft.skills, skill, wanted) })}
                    />
                    <Help k={`skill.${skill}`} text={skillLabel(skill)} />
                  </label>
                </li>
              {/each}
            </ul>
          {/each}
          {#if shown.skills}<p class="chip bad">{shown.skills}</p>{/if}
        </section>
      {/if}

      {#if tools.length > 0}
        <section>
          <h3 class="label">Tools (optional)</h3>
          <p class="prose muted note">
            Kits and instruments you were taught to use. Leave it and the server picks one for you.
          </p>
          {#each tools as group (group.desc)}
            <p class="prose muted note">{group.desc} - choose {group.choose}.</p>
            <ul class="checks">
              {#each group.from as tool (tool)}
                <li>
                  <label class="choice" for={`char-tool-${tool}`}>
                    <input
                      id={`char-tool-${tool}`}
                      type="checkbox"
                      checked={draft.tools.includes(tool)}
                      onchange={() => (draft = { ...draft, tools: toggle(draft.tools, tool, toolsWanted) })}
                    />
                    <span>{tool}</span>
                  </label>
                </li>
              {/each}
            </ul>
          {/each}
        </section>
      {/if}

      {#if (detail.feature_choices ?? []).length > 0}
        <section>
          <h3 class="label">What your class lets you specialise in (optional)</h3>
          <p class="prose muted note">
            Every {detail.name} gets these at level 1. Leave any of them and the server chooses.
          </p>
          {#each detail.feature_choices ?? [] as choice (choice.feature)}
            <p class="prose muted note">
              <strong>{choice.feature}</strong> - {choice.desc} Choose {choice.choose}.
            </p>
            <ul class="checks">
              {#each choice.from as option (option)}
                <li>
                  <label class="choice" for={`char-feature-${choice.feature}-${option}`}>
                    <input
                      id={`char-feature-${choice.feature}-${option}`}
                      type="checkbox"
                      checked={(draft.feature_options[choice.feature] ?? []).includes(option)}
                      onchange={() => setFeature(choice, option)}
                    />
                    <span>{optionLabel(option)}</span>
                  </label>
                </li>
              {/each}
            </ul>
          {/each}
        </section>
      {/if}

      {#if detail.equipment_options.length > 0}
        <section>
          <h3 class="label">Starting equipment</h3>
          {#each detail.equipment_options as bundle (bundle.label)}
            <label class="choice" for={`char-equipment-${bundle.label}`}>
              <input
                id={`char-equipment-${bundle.label}`}
                type="radio"
                name="char-equipment"
                value={bundle.label}
                checked={draft.equipment === bundle.label}
                onchange={() => (draft = { ...draft, equipment: bundle.label })}
              />
              <span class="prose">
                <span class="pack num">{bundle.label})</span>
                {bundleText(bundle.items, bundle.gold)}
              </span>
            </label>
          {/each}
          {#if shown.equipment}<p class="chip bad">{shown.equipment}</p>{/if}
        </section>
      {/if}

      {#if casting}
        <section>
          <h3 class="label"><Help k="cantrips" text="Cantrips" /></h3>
          <p class="prose muted note">Choose {casting.cantrips_to_choose}.</p>
          <ul class="checks">
            {#each casting.cantrip_options as spell (spell)}
              <li>
                <label class="choice" for={`char-cantrip-${spell}`}>
                  <input
                    id={`char-cantrip-${spell}`}
                    type="checkbox"
                    checked={draft.cantrips.includes(spell)}
                    onchange={() =>
                      (draft = {
                        ...draft,
                        cantrips: toggle(draft.cantrips, spell, casting.cantrips_to_choose),
                      })}
                  />
                  <span>{spell}</span>
                </label>
              </li>
            {/each}
          </ul>
          {#if shown.cantrips}<p class="chip bad">{shown.cantrips}</p>{/if}

          <h3 class="label">Level 1 spells</h3>
          <p class="prose muted note">Choose {casting.spells_to_choose}.</p>
          <ul class="checks">
            {#each casting.spell_options as spell (spell)}
              <li>
                <label class="choice" for={`char-spell-${spell}`}>
                  <input
                    id={`char-spell-${spell}`}
                    type="checkbox"
                    checked={draft.spells.includes(spell)}
                    onchange={() =>
                      (draft = {
                        ...draft,
                        spells: toggle(draft.spells, spell, casting.spells_to_choose),
                        spellbook: [],
                      })}
                  />
                  <span>{spell}</span>
                </label>
              </li>
            {/each}
          </ul>
          {#if shown.spells}<p class="chip bad">{shown.spells}</p>{/if}

          {#if draft.class === 'Wizard'}
            <h3 class="label">Spellbook — {SPELLBOOK_SIZE} level 1 spells (optional)</h3>
            <p class="prose muted note">
              Your book holds more than you prepare. The {casting.spells_to_choose} above are in it already; name
              {extraPages} more, or leave it and the server fills the pages.
            </p>
            <ul class="checks">
              {#each casting.spell_options as spell (spell)}
                <li>
                  <label class="choice" for={`char-book-${spell}`}>
                    <input
                      id={`char-book-${spell}`}
                      type="checkbox"
                      checked={inBook(spell)}
                      disabled={draft.spells.includes(spell)}
                      onchange={() =>
                        (draft = { ...draft, spellbook: toggle(draft.spellbook, spell, extraPages) })}
                    />
                    <span>{spell}</span>
                  </label>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}
    {/if}

    {#if (options.background_detail?.equipment_options ?? []).length > 0}
      <section>
        <h3 class="label">What your background brings (optional)</h3>
        <p class="prose muted note">The gear the {draft.background} background starts with, or the coin instead.</p>
        {#each options.background_detail?.equipment_options ?? [] as bundle (bundle.label)}
          <label class="choice" for={`char-bg-equipment-${bundle.label}`}>
            <input
              id={`char-bg-equipment-${bundle.label}`}
              type="radio"
              name="char-bg-equipment"
              value={bundle.label}
              checked={draft.background_equipment === bundle.label}
              onchange={() => (draft = { ...draft, background_equipment: bundle.label })}
            />
            <span class="prose">
              <span class="pack num">{bundle.label})</span>
              {bundleText(bundle.items, bundle.gold)}
            </span>
          </label>
        {/each}
      </section>
    {/if}

    {#if slots.length > 0}
      <section>
        <h3 class="label">Gear you name yourself (optional)</h3>
        <p class="prose muted note">
          A few of your starting items are a category, not a thing. Leave one and the server takes the first.
        </p>
        {#each slots as slot, i (i)}
          <div class="pickrow">
            <label class="prose muted note" for={`char-pick-${i}`}>{slot.desc}</label>
            <select
              id={`char-pick-${i}`}
              value={draft.equipment_picks[i] ?? ''}
              onchange={(event) => setPick(i, event.currentTarget.value)}
            >
              <option value="">Let the DM choose</option>
              {#each slot.options as option (option)}
                <option value={option}>{option}</option>
              {/each}
            </select>
          </div>
        {/each}
      </section>
    {/if}

    {#if featFields.length > 0}
      <section>
        <h3 class="label">{options.background_detail?.feat.name ?? 'Background feat'} (optional)</h3>
        <p class="prose muted note">
          The free feat your background grants still has a choice or two in it. Leave them to the DM if you like.
        </p>
        {#each featFields as field (field.key)}
          <div class="pickrow">
            <label class="prose muted note" for={`char-feat-${field.key}`}>{field.label}</label>
            <select
              id={`char-feat-${field.key}`}
              value={draft.feat_choices[field.key] ?? ''}
              onchange={(event) => setFeatChoice(field.key, event.currentTarget.value)}
            >
              <option value="">Let the DM choose</option>
              {#each field.options as option (option)}
                <option value={option}>{optionLabel(option)}</option>
              {/each}
            </select>
          </div>
        {/each}
      </section>
    {/if}

    {#if options.languages}
      {@const languages = options.languages}
      <section>
        <h3 class="label">Languages (optional)</h3>
        <p class="prose muted note">
          You already speak {languages.known.join(', ')}. Pick {LANGUAGES_TO_CHOOSE} more, or leave it and the server
          picks ones your people would know.
        </p>
        <ul class="checks wide">
          {#each languages.options as language (language.name)}
            <li>
              <label class="choice" for={`char-language-${language.name}`}>
                <input
                  id={`char-language-${language.name}`}
                  type="checkbox"
                  checked={draft.languages.includes(language.name)}
                  onchange={() =>
                    (draft = {
                      ...draft,
                      languages: toggle(draft.languages, language.name, LANGUAGES_TO_CHOOSE),
                    })}
                />
                <span>{language.name} <span class="muted hint">{language.speakers}</span></span>
              </label>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <section class="who">
      <label class="label" for="char-name">Character name</label>
      <input id="char-name" type="text" bind:value={draft.name} />
      {#if shown.name}<p class="chip bad">{shown.name}</p>{/if}

      <label class="label" for="char-alignment">Alignment (optional)</label>
      <input id="char-alignment" type="text" bind:value={draft.alignment} />

      <label class="label" for="char-backstory">Backstory (optional)</label>
      <textarea id="char-backstory" rows="3" bind:value={draft.backstory}></textarea>
    </section>

    <div class="submit">
      <button type="submit" class="primary" disabled={sending}>
        {sending ? 'Creating…' : isCompleteCharacter(draft, options) ? 'Create this character' : 'Save this — the DM finishes it'}
      </button>
      <button type="button" onclick={onskip}>Skip — the DM will do it in chat</button>
    </div>
  </form>
{/if}

<style>
  .paths {
    display: grid;
    gap: 0.6rem;
    grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  }

  .path {
    display: grid;
    gap: 0.3rem;
    text-align: left;
    padding: 0.8rem 0.9rem;
    background: var(--surface);
  }

  .path:hover {
    color: inherit;
    border-color: var(--accent);
  }

  .head {
    font-family: var(--font-display);
    font-size: var(--t-15);
    color: var(--accent);
  }

  .build {
    display: grid;
    gap: 1.1rem;
  }

  section {
    display: grid;
    gap: 0.3rem;
  }

  h3 {
    margin: 0;
  }

  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
  }

  .grid.small {
    grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
  }

  .card {
    display: grid;
    gap: 0.25rem;
    align-content: start;
    width: 100%;
    height: 100%;
    text-align: left;
    padding: 0.5rem 0.6rem;
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
    font-size: var(--t-15);
    color: var(--accent);
  }

  .desc {
    font-size: var(--t-13);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .fit {
    white-space: normal;
  }

  .checks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.1rem;
    grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
    max-height: 18rem;
    overflow-y: auto;
  }

  .checks.wide {
    grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  }

  .hint {
    font-size: var(--t-12);
  }

  .pickrow {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
  }

  select {
    font-family: var(--font-body);
    font-size: var(--t-15);
    max-width: 100%;
    color: var(--ink);
    background: var(--surface-raised);
    border: 1px solid var(--rule);
    padding: 0.15rem 0.3rem;
  }

  select:focus {
    border-color: var(--accent);
  }

  .choice {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: var(--t-15);
  }

  input[type='checkbox'],
  input[type='radio'] {
    accent-color: var(--accent);
  }

  .note {
    margin: 0.2rem 0 0.1rem;
    font-size: var(--t-13);
  }

  .pack {
    color: var(--accent);
  }

  .who {
    gap: 0.15rem;
  }

  .who input,
  textarea {
    font-family: var(--font-body);
    font-size: var(--t-15);
    max-width: 65ch;
    color: var(--ink);
    background: var(--surface-raised);
    border: 1px solid var(--rule);
    padding: 0.3rem 0.5rem;
  }

  .who input:focus,
  textarea:focus {
    border-color: var(--accent);
  }

  .who .label {
    margin-top: 0.4rem;
  }

  .submit {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .primary {
    color: var(--accent);
    border-color: var(--accent);
  }

  .chip {
    justify-self: start;
    white-space: normal;
  }

  .top {
    margin-bottom: 0.3rem;
  }
</style>
