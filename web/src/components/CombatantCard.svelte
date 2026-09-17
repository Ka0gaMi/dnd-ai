<script lang="ts">
  import Help from './Help.svelte';
  import Portrait from './Portrait.svelte';
  import { uploadCharacterPortrait, uploadCreaturePortrait } from '../lib/api';
  import { flagChips, visibleHp, visibleKnown } from '../lib/combat.svelte';
  import { dropImage } from '../lib/dropzone';
  import { creatureName } from '../lib/portraits.svelte';
  import {
    conditionHelp,
    conditionHelpKey,
    damageHelpKey,
    flagHelpKey,
    senseHelp,
    sizeHelpKey,
    typeHelpKey,
  } from '../lib/rulesHelp';
  import type { Combatant, Visibility } from '../lib/types';

  let {
    combatant,
    visibility,
    active = false,
    campaignId,
    portrait = null,
    effects = new Map(),
    nameOf = (id: number) => `#${id}`,
  }: {
    combatant: Combatant;
    visibility: Visibility;
    active?: boolean;
    campaignId: number;
    /** The face for this combatant, if one has been uploaded or generated. */
    portrait?: string | null;
    /** What each condition does, as the fight log reported it; keyed by the condition name. */
    effects?: Map<string, string>;
    /** Names the flag chips need: who is grappling whom. */
    nameOf?: (id: number) => string;
  } = $props();

  let problem = $state<string | null>(null);

  /** Dropping a file on the card gives this creature - or this character - a face. */
  async function upload(file: File): Promise<void> {
    try {
      if (combatant.character_id !== null) await uploadCharacterPortrait(combatant.character_id, file);
      else await uploadCreaturePortrait(campaignId, creatureName(combatant.name), file);
      problem = null;
    } catch (failure) {
      problem = failure instanceof Error ? failure.message : String(failure);
    }
  }

  const hp = $derived(visibleHp(combatant, visibility));
  const known = $derived(visibleKnown(combatant, visibility));
  const inspiration = $derived((combatant.inspiration ?? 0) > 0);
  const exhaustion = $derived(combatant.exhaustion ?? 0);
  const percent = $derived(hp.fraction * 100);
  const tempPercent = $derived(
    combatant.hp_max > 0 ? Math.max(0, Math.min(100 - percent, (combatant.temp_hp / combatant.hp_max) * 100)) : 0,
  );
  const tone = $derived(percent >= 50 ? 'good' : percent >= 25 ? 'warn' : 'bad');
  /** No portrait yet: the token marker, as drawn on the map. */
  const monogram = $derived(combatant.marker);
  /** "Darkvision 60 ft., passive Perception 9" reads as one tooltip per sense. */
  const senses = $derived((known?.senses ?? []).map((sense) => ({ sense, help: senseHelp(sense) })));

  const states = $derived(flagChips(combatant, nameOf));
  /** Armour they were never trained in is the player's own business: only their side is told. */
  const untrainedArmour = $derived(combatant.armor_penalty === true && combatant.team === 'party');

  const damageTokens = (value: string): Array<{ token: string; key: string | null }> =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((token) => ({ token, key: damageHelpKey(token) }));
</script>

<article class={combatant.team} class:active class:down={!combatant.alive} use:dropImage={{ ondrop: upload }}>
  <div class="head" title="Drop an image here to set a portrait">
    <Portrait path={portrait} {monogram} size={28} alt="" name={combatant.name} />
    <span class="name">{combatant.name}</span>
    {#if inspiration}
      <span class="star on" title="Heroic Inspiration" aria-label="Heroic Inspiration"></span>
    {/if}
    {#if hp.numbers}
      <span class="hp num">{combatant.hp_current} / {combatant.hp_max}</span>
      {#if combatant.temp_hp > 0}<span class="chip">+{combatant.temp_hp} temp</span>{/if}
    {:else if hp.bloodied}
      <span class="chip bad"><Help k="bloodied" text="Bloodied" /></span>
    {/if}
    {#if !combatant.alive}<span class="chip bad">Dead</span>{/if}
  </div>

  {#if hp.bar}
    <div
      class="bar"
      style="--fill: {percent}%; --temp: {tempPercent}%"
      role="meter"
      aria-valuenow={Math.round(percent)}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-label="Hit points"
    >
      <span class="fill {tone}"></span>
      <span class="temp"></span>
    </div>
  {/if}

  <dl class="stats">
    {#if hp.ac}
      <div><dt class="label"><Help k="ac" text="AC" /></dt><dd class="num">{combatant.ac}</dd></div>
    {/if}
    <div><dt class="label"><Help k="speed" text="Speed" /></dt><dd class="num">{combatant.speed} ft</dd></div>
    {#if combatant.team === 'party'}
      <div>
        <dt class="label"><Help k="movement_left" text="Move left" /></dt>
        <dd class="num">{combatant.movement_left} ft</dd>
      </div>
    {/if}
    {#if combatant.distance_ft !== null}
      <div>
        <dt class="label"><Help k="distance" text="Distance" /></dt>
        <dd class="num">{combatant.distance_ft} ft</dd>
      </div>
    {/if}
  </dl>

  {#if known}
    {#snippet damageList(label: string, helpKey: string, value: string)}
      <div>
        <dt class="label"><Help k={helpKey} text={label} /></dt>
        <dd>
          {#each damageTokens(value) as part, i (i)}
            {#if i > 0}, {/if}{#if part.key}<Help k={part.key} text={part.token} />{:else}{part.token}{/if}
          {/each}
        </dd>
      </div>
    {/snippet}

    <dl class="stats known">
      {#if known.cr !== null}
        <div><dt class="label"><Help k="cr" text="CR" /></dt><dd class="num">{known.cr}</dd></div>
      {/if}
      {#if known.type}
        <div>
          <dt class="label"><Help k="creature_type" text="Type" /></dt>
          <dd>
            {#if known.size}<Help k={sizeHelpKey(known.size)} text={known.size} />{/if}
            <Help k={typeHelpKey(known.type)} text={known.type} />
          </dd>
        </div>
      {/if}
      {#if senses.length > 0}
        <div>
          <dt class="label"><Help k="senses" text="Senses" /></dt>
          <dd>
            {#each senses as entry, i (i)}
              {#if i > 0}, {/if}<Help help={entry.help} k="senses" text={entry.sense} />
            {/each}
          </dd>
        </div>
      {/if}
      {#if known.damage_resistances}
        {@render damageList('Resists', 'resistances', known.damage_resistances)}
      {/if}
      {#if known.damage_immunities}
        {@render damageList('Immune', 'immunities', known.damage_immunities)}
      {/if}
      {#if known.damage_vulnerabilities}
        {@render damageList('Vulnerable', 'vulnerabilities', known.damage_vulnerabilities)}
      {/if}
      {#if known.condition_immunities}
        <div>
          <dt class="label"><Help k="conditions" text="Cond. immune" /></dt>
          <dd>
            {#each known.condition_immunities.split(',').map((c) => c.trim()) as condition, i (i)}
              {#if i > 0}, {/if}<Help k={conditionHelpKey(condition)} text={condition} />
            {/each}
          </dd>
        </div>
      {/if}
    </dl>
  {/if}

  {#if combatant.conditions.length > 0 || states.length > 0 || combatant.concentration || exhaustion > 0 || untrainedArmour}
    <div class="chips">
      {#each combatant.conditions as condition (condition)}
        <span class="chip bad">
          <Help
            k={conditionHelpKey(condition)}
            help={conditionHelp(condition, effects.get(condition))}
            text={condition}
          />
        </span>
      {/each}
      {#each states as state (state.flag)}
        <span class="chip"><Help k={flagHelpKey(state.flag)} text={state.label} /></span>
      {/each}
      {#if untrainedArmour}
        <span class="chip warn"><Help k="armor_proficiency" text="Armour: not proficient" /></span>
      {/if}
      {#if combatant.concentration}
        <span class="chip accent">
          <Help k="concentration" text="Concentrating: {combatant.concentration.name}" />
        </span>
      {/if}
      {#if exhaustion > 0}
        <span class="chip warn"><Help k="exhaustion" text="Exhaustion {exhaustion}" /></span>
      {/if}
    </div>
  {/if}

  {#if problem}<span class="chip bad">{problem}</span>{/if}

  {#if combatant.hp_current === 0 && combatant.alive && combatant.team === 'party'}
    <div class="deaths">
      <span class="label"><Help k="death_saves" text="Death saves" /></span>
      <span class="rings">
        {#each [0, 1, 2] as i (i)}
          <span class="ring good" class:on={combatant.death_saves.successes > i}></span>
        {/each}
      </span>
      <span class="rings">
        {#each [0, 1, 2] as i (i)}
          <span class="ring bad" class:on={combatant.death_saves.failures > i}></span>
        {/each}
      </span>
    </div>
  {/if}
</article>

<style>
  article {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.45rem 0.55rem;
    border: 1px solid var(--rule);
    border-left: 3px solid var(--ink-faint);
  }

  article.party {
    border-left-color: var(--info);
  }

  article.enemy {
    border-left-color: var(--bad);
  }

  article.active {
    border-color: var(--accent);
    border-left-color: var(--accent);
  }

  article.down {
    color: var(--ink-faint);
  }

  article.down .name {
    text-decoration: line-through;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem;
  }

  article:global(.dropping) {
    outline: 1px dashed var(--accent);
    outline-offset: 2px;
  }

  .name {
    font-family: var(--font-display);
    font-size: var(--t-15);
  }

  .hp {
    margin-left: auto;
    font-size: var(--t-15);
    font-weight: 600;
  }

  /* A five-pointed star drawn from a square, so no glyph or image is needed. */
  .star {
    width: 0.8rem;
    height: 0.8rem;
    background: var(--ink-faint);
    clip-path: polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%);
  }

  .star.on {
    background: var(--accent);
  }

  .bar {
    position: relative;
    height: 0.6rem;
    border: 1px solid var(--rule);
    background: var(--surface);
    overflow: hidden;
  }

  .fill,
  .temp {
    position: absolute;
    top: 0;
    bottom: 0;
  }

  .fill {
    left: 0;
    width: var(--fill);
  }

  .fill.good {
    background: var(--good);
  }

  .fill.warn {
    background: var(--warn);
  }

  .fill.bad {
    background: var(--bad);
  }

  .temp {
    left: var(--fill);
    width: var(--temp);
    background: var(--info);
    opacity: 0.55;
  }

  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.15rem 0.8rem;
    margin: 0;
  }

  .stats div {
    display: flex;
    align-items: baseline;
    gap: 0.3rem;
  }

  .stats dd {
    margin: 0;
    font-size: var(--t-13);
  }

  /* The stat-block facts read as lines, not as a row of pairs. */
  .known {
    flex-direction: column;
    gap: 0.1rem;
    color: var(--ink-muted);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .deaths {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .rings {
    display: inline-flex;
    gap: 0.25rem;
  }

  .ring {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    border: 1px solid var(--ink-faint);
  }

  .ring.good.on {
    background: var(--good);
    border-color: var(--good);
  }

  .ring.bad.on {
    background: var(--bad);
    border-color: var(--bad);
  }

  @media (prefers-reduced-motion: no-preference) {
    .fill,
    .temp {
      transition: width 200ms ease-out;
    }
  }
</style>
