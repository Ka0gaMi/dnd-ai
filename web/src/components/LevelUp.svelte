<script lang="ts">
  import Help from './Help.svelte';
  import PowerReport from './PowerReport.svelte';
  import { applyLevelUp } from '../lib/api';
  import { closeLevelUp, levelup, preparedLevelUp, refreshLevelUp, spendLevelUp } from '../lib/levelup.svelte';
  import {
    ABILITY_KEYS,
    buildLevelUpBody,
    detailHeader,
    emptyPicks,
    featChoiceFields,
    featOptionLabel,
    featureOptionLabel,
    levelUpTitle,
    normaliseOption,
    optionHelp,
    powerChip,
    recommendedAbilities,
    recommendedWhy,
    spellOptionNames,
    type FeatOption,
    type FeatureChoiceSpec,
    type NormalisedOption,
    type OptionDetail,
    type OptionKind,
    type PowerVerdict,
    type SwapPick,
  } from '../lib/progression';
  import { featureHelpKey, helpFor, type Help as HelpEntry } from '../lib/rulesHelp';

  let {
    characterId,
    version,
    onapplied,
  }: {
    characterId: number | null;
    /** Bumped by the store when an event could have prepared or spent a level-up. */
    version: number;
    /** The level is taken: the sheet needs a fresh snapshot. */
    onapplied: () => void;
  } = $props();

  let dialogEl = $state<HTMLDialogElement | undefined>();
  let picks = $state(emptyPicks());
  let preparedAt = $state<string | null>(null);
  let problem = $state<string | null>(null);
  let busy = $state(false);

  const levelUp = $derived(preparedLevelUp());
  const srd = $derived(levelUp?.srd ?? {});
  const details = $derived(srd.details ?? {});
  const recommendations = $derived(levelUp?.recommendations);
  const suggestions = $derived(levelUp?.suggestions ?? []);
  const casting = $derived(srd.spellcasting ?? null);
  const cantripOptions = $derived((casting?.cantrip_options ?? []).map(normaliseOption));
  const spellLevels = $derived(
    Object.entries(casting?.spell_options ?? {}).map(([level, opts]) => [level, opts.map(normaliseOption)] as const),
  );
  const asiAbilities = $derived(recommendedAbilities(recommendations));
  const asiTotal = $derived(ABILITY_KEYS.reduce((sum, ability) => sum + (picks.increases[ability] ?? 0), 0));
  const spellbook = $derived(casting?.spellbook ?? null);
  const spellbookLevels = $derived(
    Object.entries(spellbook?.options ?? {}).map(([level, opts]) => [level, opts.map(normaliseOption)] as const),
  );
  /** The picks as a body, so the reason Apply is disabled is the engine's own rule, not a guess. */
  const built = $derived(buildLevelUpBody(srd, picks, suggestions));
  const blocked = $derived('error' in built ? built.error : null);

  /** The homebrew chip beside an option, and its power label when the DM's own report has one. */
  type Badge = { powerLabel?: PowerVerdict } | null;

  function subclassBadge(choice: { homebrew?: true; power_label?: PowerVerdict }): Badge {
    return choice.homebrew ? { powerLabel: choice.power_label } : null;
  }

  function spellBadge(opt: NormalisedOption, detail: OptionDetail | undefined): Badge {
    if (!opt.homebrew && detail?.homebrew !== true) return null;
    return { powerLabel: opt.powerLabel ?? detail?.power_label };
  }

  /** Ticking one more than the level gives does nothing: the list stays at the count the server wants. */
  function toggle(list: string[], name: string, limit: number): string[] {
    if (list.includes(name)) return list.filter((entry) => entry !== name);
    return list.length >= limit ? list : [...list, name];
  }

  function setIncrease(ability: string, typed: string): void {
    const value = Math.max(0, Math.min(2, Math.round(Number(typed) || 0)));
    picks.increases = { ...picks.increases, [ability]: value };
  }

  function setFeaturePick(spec: FeatureChoiceSpec, name: string): void {
    const held = picks.feature_options[spec.feature] ?? [];
    picks.feature_options = { ...picks.feature_options, [spec.feature]: toggle(held, name, spec.choose) };
  }

  /** A feat's picks are held one list per choice, so a typed box and a radio read the same way. */
  const featValue = (key: string, index: number): string => picks.feat_choices[key]?.[index] ?? '';

  function setFeatValue(key: string, index: number, value: string): void {
    const held = [...(picks.feat_choices[key] ?? [])];
    while (held.length <= index) held.push('');
    held[index] = value;
    picks.feat_choices = { ...picks.feat_choices, [key]: held };
  }

  /** A different feat asks for different things: nothing typed for the last one carries over. */
  function chooseFeat(name: string): void {
    picks.feat = name;
    picks.feat_choices = {};
  }

  async function confirm(): Promise<void> {
    if (characterId === null || busy) return;
    if ('error' in built) {
      problem = built.error;
      return;
    }
    busy = true;
    try {
      await applyLevelUp(characterId, built.body);
      // The dialog goes at once; the fresh sheet arrives with the snapshot.
      spendLevelUp();
      problem = null;
      onapplied();
    } catch (failure) {
      problem = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    void version;
    void refreshLevelUp(characterId);
  });

  /** A window prepared again is a new set of options: nothing half-picked carries over. */
  $effect(() => {
    const stamp = levelUp?.prepared_at ?? null;
    if (stamp === preparedAt) return;
    preparedAt = stamp;
    // The only thing a recommendation preselects: hit points are one of two, never a wrong pick.
    picks = { ...emptyPicks(), hp: recommendations?.hp === 'roll' ? 'roll' : 'average' };
    problem = null;
  });

  /** Native <dialog> owns Esc and focus return; this just mirrors the store's intent. */
  $effect(() => {
    if (!dialogEl) return;
    const wanted = levelup.open && levelUp !== null;
    if (wanted && !dialogEl.open) dialogEl.showModal();
    else if (!wanted && dialogEl.open) dialogEl.close();
  });
</script>

{#snippet option(name: string, fallback: HelpEntry | null, kind: OptionKind, badge: Badge = null, flavourText?: string)}
  {@const why = recommendedWhy(recommendations, kind, name)}
  {@const detail = details[name]}
  <Help text={name} help={optionHelp(name, detail, fallback, why, flavourText)} head={detailHeader(detail)} lead={why} />
  {#if why}<span class="chip accent">DM recommends</span>{/if}
  {#if badge}
    <span class="chip accent">
      <Help k={kind === 'subclass' ? 'custom_subclass' : 'custom_spell'} text="Homebrew" label />
    </span>
    {#if badge.powerLabel}
      {@const powerBadge = powerChip(badge.powerLabel)}
      <span class="chip {powerBadge.tone}">{powerBadge.label}</span>
    {/if}
  {/if}
{/snippet}

{#snippet featFields(feat: FeatOption)}
  {#each featChoiceFields(feat.choices) as field (field.key)}
    <fieldset class="sub">
      <legend class="label">
        {#if field.help}
          <Help k={field.help} text={field.label} label />
        {:else}
          {field.label}
        {/if}
      </legend>
      {#if field.desc}<p class="prose muted hint">{field.desc}</p>{/if}
      {#if field.kind === 'increases'}
        <div class="abilities">
          {#each ABILITY_KEYS as ability (ability)}
            <label class="ability">
              <span class="label">{ability}</span>
              <input
                type="number"
                min="0"
                max="2"
                value={picks.increases[ability] ?? 0}
                aria-label={`${feat.name} ${ability} increase`}
                onchange={(event) => setIncrease(ability, event.currentTarget.value)}
              />
            </label>
          {/each}
        </div>
        <p class="label count">{asiTotal} of 2 spent</p>
      {:else if field.options.length > 0}
        {#each field.options as choice (choice)}
          <label>
            <input
              type="radio"
              name={`feat-${field.key}`}
              aria-label={`${field.label}: ${featOptionLabel(choice)}`}
              checked={featValue(field.key, 0) === choice}
              onchange={() => setFeatValue(field.key, 0, choice)}
            />
            {featOptionLabel(choice)}
          </label>
        {/each}
      {:else}
        {#each Array.from({ length: field.choose }, (_, index) => index) as index (index)}
          <input
            type="text"
            class="typed"
            aria-label={`${field.label} ${index + 1}`}
            value={featValue(field.key, index)}
            onchange={(event) => setFeatValue(field.key, index, event.currentTarget.value)}
          />
        {/each}
      {/if}
    </fieldset>
  {/each}
{/snippet}

{#snippet swap(what: string, held: string[], options: string[], pick: SwapPick)}
  <fieldset>
    <legend class="label"><Help k="spell_swap" text={`Swap a ${what}`} label /></legend>
    <p class="prose muted hint">Levelling lets you trade one {what} for another. Leave it alone to keep what you have.</p>
    <label>
      Give up
      <select aria-label={`The ${what} you give up`} value={pick.old} onchange={(event) => (pick.old = event.currentTarget.value)}>
        <option value="">Nothing</option>
        {#each held as name (name)}<option value={name}>{name}</option>{/each}
      </select>
    </label>
    <label>
      Learn
      <select aria-label={`The ${what} you learn`} value={pick.new} onchange={(event) => (pick.new = event.currentTarget.value)}>
        <option value="">Nothing</option>
        {#each options as name (name)}<option value={name}>{name}</option>{/each}
      </select>
    </label>
  </fieldset>
{/snippet}

<dialog bind:this={dialogEl} class="levelup" aria-label="Level up" onclose={closeLevelUp}>
  {#if levelUp}
    <h2 class="title">{levelUpTitle(levelUp)}</h2>

    <div class="body">
      <div class="columns">
        <div class="side">
          <h3 class="label">Rulebook options</h3>

          {#if srd.hp}
            <fieldset>
              <legend class="label"><Help k="hp" text="Hit points" label /></legend>
              <label>
                <input type="radio" name="hp" checked={picks.hp === 'average'} onchange={() => (picks.hp = 'average')} />
                Average <span class="num">+{srd.hp.average}</span>
                {#if recommendations?.hp === 'average'}<span class="chip accent">DM recommends</span>{/if}
              </label>
              <label>
                <input type="radio" name="hp" checked={picks.hp === 'roll'} onchange={() => (picks.hp = 'roll')} />
                Roll <span class="num">{srd.hp.roll}</span>
                {#if recommendations?.hp === 'roll'}<span class="chip accent">DM recommends</span>{/if}
              </label>
            </fieldset>
          {/if}

          {#if (srd.features ?? []).length > 0}
            <fieldset>
              <legend class="label">You gain</legend>
              {#each srd.features ?? [] as feature (feature.name)}
                <details>
                  <summary>{feature.name}</summary>
                  <p class="prose muted">{feature.text}</p>
                </details>
              {/each}
            </fieldset>
          {/if}

          {#if (srd.subclass_choice ?? []).length > 0}
            <fieldset>
              <legend class="label">Subclass</legend>
              {#each srd.subclass_choice ?? [] as choice (choice.name)}
                <div class="option">
                  <input
                    type="radio"
                    name="subclass"
                    aria-label={choice.name}
                    checked={picks.subclass === choice.name}
                    onchange={() => (picks.subclass = choice.name)}
                  />
                  {@render option(
                    choice.name,
                    { title: choice.name, text: choice.text },
                    'subclass',
                    subclassBadge(choice),
                    choice.flavour_text,
                  )}
                </div>
                {#if choice.summary}<p class="prose muted hint">{choice.summary}</p>{/if}
              {/each}
            </fieldset>
          {/if}

          {#each srd.feature_choices ?? [] as spec (spec.feature)}
            {@const picked = picks.feature_options[spec.feature] ?? []}
            {@const key = featureHelpKey(spec.feature)}
            <fieldset>
              <legend class="label">
                {#if key}<Help k={key} text={spec.feature} label />{:else}{spec.feature}{/if}
              </legend>
              <p class="prose muted hint">{spec.desc}</p>
              <p class="label count">{picked.length} of {spec.choose} picked</p>
              {#each spec.from as choice (choice)}
                <label>
                  <input
                    type="checkbox"
                    aria-label={featureOptionLabel(choice)}
                    checked={picked.includes(choice)}
                    onchange={() => setFeaturePick(spec, choice)}
                  />
                  {featureOptionLabel(choice)}
                </label>
              {/each}
            </fieldset>
          {/each}

          {#if srd.ability_score_improvement}
            <fieldset>
              <legend class="label">Ability Score Improvement</legend>
              <p class="prose muted hint">{srd.ability_score_improvement.rule}</p>
              {#if recommendations?.asi}
                <p class="prose hint">
                  <span class="chip accent">DM recommends</span>
                  {recommendations.asi.why}
                </p>
              {/if}
              <span class="segmented" role="group" aria-label="Ability Score Improvement">
                <button
                  type="button"
                  aria-pressed={picks.asi_mode === 'abilities'}
                  onclick={() => (picks.asi_mode = 'abilities')}
                >
                  Raise scores
                </button>
                <button type="button" aria-pressed={picks.asi_mode === 'feat'} onclick={() => (picks.asi_mode = 'feat')}>
                  Take a feat
                </button>
              </span>
              {#if picks.asi_mode === 'abilities'}
                <div class="abilities">
                  {#each ABILITY_KEYS as ability (ability)}
                    <label class="ability" class:recommended={asiAbilities.includes(ability)}>
                      <span class="label">{ability}</span>
                      <input
                        type="number"
                        min="0"
                        max="2"
                        value={picks.increases[ability] ?? 0}
                        aria-label={`${ability} increase`}
                        onchange={(event) => setIncrease(ability, event.currentTarget.value)}
                      />
                    </label>
                  {/each}
                </div>
                <p class="label count">{asiTotal} of 2 spent</p>
              {:else}
                {#each srd.ability_score_improvement.feat_options as feat (feat.name)}
                  <div class="option">
                    <input
                      type="radio"
                      name="feat"
                      aria-label={feat.name}
                      checked={picks.feat === feat.name}
                      onchange={() => chooseFeat(feat.name)}
                    />
                    {@render option(feat.name, { title: feat.name, text: feat.text }, 'feat')}
                  </div>
                  {#if picks.feat === feat.name}
                    <p class="prose muted hint">{feat.text}</p>
                    {@render featFields(feat)}
                  {/if}
                {/each}
              {/if}
            </fieldset>
          {/if}

          {#if srd.epic_boon}
            <fieldset>
              <legend class="label">{srd.epic_boon.epic ? 'Epic Boon' : 'Feat'}</legend>
              <p class="prose muted hint">{srd.epic_boon.rule}</p>
              {#each srd.epic_boon.feat_options as feat (feat.name)}
                <div class="option">
                  <input
                    type="radio"
                    name="feat"
                    aria-label={feat.name}
                    checked={picks.feat === feat.name}
                    onchange={() => chooseFeat(feat.name)}
                  />
                  {@render option(feat.name, { title: feat.name, text: feat.text }, 'feat')}
                </div>
                {#if picks.feat === feat.name}
                  <p class="prose muted hint">{feat.text}</p>
                  {@render featFields(feat)}
                {/if}
              {/each}
            </fieldset>
          {/if}

          {#if casting && casting.cantrips_to_add > 0}
            <fieldset>
              <legend class="label"><Help k="cantrips" text="New cantrips" label /></legend>
              <p class="label count">{picks.cantrips.length} of {casting.cantrips_to_add} picked</p>
              {#each cantripOptions as opt, i (`${opt.name}:${i}`)}
                <div class="option">
                  <input
                    type="checkbox"
                    aria-label={opt.name}
                    checked={picks.cantrips.includes(opt.name)}
                    onchange={() => (picks.cantrips = toggle(picks.cantrips, opt.name, casting.cantrips_to_add))}
                  />
                  {@render option(opt.name, helpFor('cantrips'), 'cantrip', spellBadge(opt, details[opt.name]))}
                </div>
              {/each}
            </fieldset>
          {/if}

          {#if casting && casting.spells_to_add > 0}
            <fieldset>
              <legend class="label"><Help k="prepared" text="New spells" label /></legend>
              <p class="label count">{picks.spells.length} of {casting.spells_to_add} picked</p>
              {#each spellLevels as [level, options] (level)}
                <p class="label">Level {level}</p>
                {#each options as opt, i (`${opt.name}:${i}`)}
                  <div class="option">
                    <input
                      type="checkbox"
                      aria-label={opt.name}
                      checked={picks.spells.includes(opt.name)}
                      onchange={() => (picks.spells = toggle(picks.spells, opt.name, casting.spells_to_add))}
                    />
                    {@render option(opt.name, helpFor('prepared'), 'spell', spellBadge(opt, details[opt.name]))}
                  </div>
                {/each}
              {/each}
            </fieldset>
          {/if}

          {#if spellbook}
            <fieldset>
              <legend class="label"><Help k="spellbook" text="Spellbook" label /></legend>
              <p class="prose muted hint">
                Copy {spellbook.to_add} new spells into your book. Only what stands in it can be prepared.
              </p>
              <p class="label count">{picks.spellbook.length} of {spellbook.to_add} picked</p>
              {#each spellbookLevels as [level, options] (level)}
                <p class="label">Level {level}</p>
                {#each options as opt, i (`${opt.name}:${i}`)}
                  <div class="option">
                    <input
                      type="checkbox"
                      aria-label={`${opt.name} for the spellbook`}
                      checked={picks.spellbook.includes(opt.name)}
                      onchange={() => (picks.spellbook = toggle(picks.spellbook, opt.name, spellbook.to_add))}
                    />
                    {@render option(opt.name, helpFor('spellbook'), 'spell', spellBadge(opt, details[opt.name]))}
                  </div>
                {/each}
              {/each}
            </fieldset>
          {/if}

          {#if casting?.replace_cantrip}
            {@render swap(
              'cantrip',
              casting.replace_cantrip.held,
              spellOptionNames(casting.replace_cantrip.options),
              picks.swap_cantrip,
            )}
          {/if}

          {#if casting?.replace_spell}
            {@render swap(
              'spell',
              casting.replace_spell.held,
              spellOptionNames(casting.replace_spell.options),
              picks.swap_spell,
            )}
          {/if}
        </div>

        <div class="side">
          <h3 class="label">DM suggestions</h3>
          {#if suggestions.length === 0}
            <p class="empty">The DM has not suggested anything this level.</p>
          {:else}
            <label>
              <input
                type="radio"
                name="suggestion"
                checked={picks.suggestion === null}
                onchange={() => (picks.suggestion = null)}
              />
              Keep to the rulebook
            </label>
            {#each suggestions as suggestion, index (`${suggestion.name}:${index}`)}
              {@const chip = powerChip(suggestion.report?.verdict)}
              <article class="suggestion" class:picked={picks.suggestion === index}>
                <label class="name">
                  <input
                    type="radio"
                    name="suggestion"
                    checked={picks.suggestion === index}
                    onchange={() => (picks.suggestion = index)}
                  />
                  {suggestion.name}
                  <span class="chip {chip.tone}">{chip.label}</span>
                </label>
                <p class="prose">{suggestion.text}</p>
                {#if suggestion.justification}
                  <blockquote class="prose muted">{suggestion.justification}</blockquote>
                {/if}
                {#if suggestion.report}<PowerReport report={suggestion.report} />{/if}
              </article>
            {/each}
          {/if}
        </div>
      </div>
    </div>

    <div class="actions">
      {#if problem}<p class="chip bad">{problem}</p>{/if}
      <button type="button" class="go" disabled={busy || blocked !== null} onclick={confirm}>Take the level</button>
      <button type="button" onclick={() => dialogEl?.close()}>Close</button>
      <span class="muted hint">{blocked ?? 'Nothing changes until you confirm.'}</span>
    </div>
  {/if}
</dialog>

<style>
  /* display lives on [open] alone: the UA's dialog:not([open]) { display: none } must win while closed. */
  .levelup {
    width: min(900px, 92vw);
    max-height: 88vh;
    padding: 0.6rem 0.9rem 0.7rem;
    color: var(--ink);
    background: var(--surface-raised);
    border: 1px solid var(--accent);
    border-left: 3px solid var(--accent);
  }

  .levelup[open] {
    display: flex;
    flex-direction: column;
  }

  .levelup::backdrop {
    background: var(--ground);
    opacity: 0.85;
  }

  .title {
    font-family: var(--font-display);
    font-size: var(--t-18);
    color: var(--accent);
    padding-bottom: 0.35rem;
    border-bottom: 1px solid var(--rule);
  }

  /* The options scroll; the title above and the confirm row below stay put. */
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .columns {
    display: grid;
    gap: 0.9rem;
    margin-top: 0.5rem;
  }

  @media (min-width: 640px) {
    .columns {
      grid-template-columns: 1fr 1fr;
    }
  }

  .side {
    display: grid;
    align-content: start;
    gap: 0.5rem;
    min-width: 0;
  }

  fieldset {
    display: grid;
    gap: 0.15rem;
    border: none;
    border-top: 1px solid var(--rule);
    margin: 0;
    padding: 0.35rem 0 0;
  }

  legend {
    padding: 0;
  }

  label,
  .option {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: var(--t-15);
  }

  input[type='radio'],
  input[type='checkbox'] {
    accent-color: var(--accent);
  }

  /* A feat's own picks, indented under the feat they belong to. */
  fieldset.sub {
    border-top: none;
    margin-left: 1.1rem;
    padding-top: 0.1rem;
  }

  select,
  input[type='text'] {
    font-family: var(--font-mono);
    font-size: var(--t-13);
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule);
    padding: 0.1rem 0.3rem;
  }

  select:focus,
  input[type='text']:focus {
    border-color: var(--accent);
  }

  .typed {
    max-width: 14rem;
  }

  input[type='number'] {
    width: 3rem;
    font-family: var(--font-mono);
    font-size: var(--t-13);
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule);
    padding: 0.1rem 0.3rem;
  }

  .abilities {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.2rem;
  }

  .ability {
    display: grid;
    justify-items: center;
    gap: 0.1rem;
  }

  .ability.recommended {
    color: var(--accent);
    background: var(--accent-soft);
  }

  .ability.recommended input {
    border-color: var(--accent);
  }

  .hint {
    margin: 0 0 0.2rem;
    font-size: var(--t-13);
  }

  .count {
    margin: 0.1rem 0;
  }

  .suggestion {
    display: grid;
    gap: 0.3rem;
    padding: 0.4rem 0;
    border-top: 1px solid var(--rule);
  }

  .suggestion.picked {
    border-left: 3px solid var(--accent);
    padding-left: 0.4rem;
  }

  .name {
    font-size: var(--t-15);
    font-weight: 500;
  }

  .suggestion p {
    margin: 0;
    font-size: var(--t-13);
  }

  blockquote {
    margin: 0;
    padding-left: 0.5rem;
    border-left: 1px solid var(--rule);
    font-size: var(--t-13);
    font-style: italic;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--rule);
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

  @media (prefers-reduced-motion: no-preference) {
    .levelup {
      opacity: 1;
      transition: opacity 150ms ease-out;
    }

    @starting-style {
      .levelup[open] {
        opacity: 0;
      }
    }
  }
</style>
