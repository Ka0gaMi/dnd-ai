<script lang="ts">
  import Help from './Help.svelte';
  import Portrait from './Portrait.svelte';
  import { setOverrides, uploadCharacterPortrait } from '../lib/api';
  import { dropImage } from '../lib/dropzone';
  import { loadBar, itemWeightLabel } from '../lib/encumbrance';
  import { flatItems, itemBadges, purseLine } from '../lib/inventory';
  import { awaitingDm, openLevelUp, preparedLevelUp } from '../lib/levelup.svelte';
  import { handSetDot, overridePatch, type OverrideField } from '../lib/overrides';
  import { spellTooltip } from '../lib/progression';
  import { conditionHelpKey, damageHelpKey, sizeHelpKey } from '../lib/rulesHelp';
  import type { XpMode } from '../lib/settings';
  import { spellDetail, wantSpellDetails } from '../lib/spellDetails.svelte';
  import { draftLine, type CharacterDraftRow } from '../lib/wizard';
  import type { Pc } from '../lib/types';

  let {
    pc,
    draft = null,
    concentration = null,
    cheat = false,
    portraitsOff = false,
    encumbranceOff = false,
    xpMode = 'xp',
  }: {
    pc: Pc | null;
    /** The wizard let the player stop half-way: the DM finishes this sheet on first play. */
    draft?: CharacterDraftRow | null;
    concentration?: string | null;
    /** Cheat mode: the sheet's numbers become editable. */
    cheat?: boolean;
    /** Portrait generation is off, so the only way to a face is dropping a file here. */
    portraitsOff?: boolean;
    /** The encumbrance setting is 'off': the weight bar stays hidden. */
    encumbranceOff?: boolean;
    /** 'milestone' does not count experience points, so the XP vital is hidden. */
    xpMode?: XpMode;
  } = $props();

  let editing = $state<OverrideField | null>(null);
  let typed = $state('');
  let problem = $state<string | null>(null);

  function open(field: OverrideField, current: string): void {
    editing = field;
    typed = current;
    problem = null;
  }

  async function save(field: OverrideField): Promise<void> {
    const edit = overridePatch(field, typed);
    if ('error' in edit) {
      problem = edit.error;
      return;
    }
    await send(field, edit.patch);
  }

  async function send(field: OverrideField, patch: Record<string, number | null>): Promise<void> {
    if (!pc?.id) return;
    try {
      await setOverrides(pc.id, patch);
      editing = null;
      problem = null;
    } catch (failure) {
      problem = failure instanceof Error ? failure.message : String(failure);
      editing = field;
    }
  }

  async function upload(file: File): Promise<void> {
    if (!pc?.id) return;
    try {
      await uploadCharacterPortrait(pc.id, file);
      problem = null;
    } catch (failure) {
      problem = failure instanceof Error ? failure.message : String(failure);
    }
  }

  const ABILITIES: Array<[string, string]> = [
    ['str', 'STR'],
    ['dex', 'DEX'],
    ['con', 'CON'],
    ['int', 'INT'],
    ['wis', 'WIS'],
    ['cha', 'CHA'],
  ];

  const SKILLS: Array<[string, string]> = [
    ['acrobatics', 'Acrobatics'],
    ['animal_handling', 'Animal Handling'],
    ['arcana', 'Arcana'],
    ['athletics', 'Athletics'],
    ['deception', 'Deception'],
    ['history', 'History'],
    ['insight', 'Insight'],
    ['intimidation', 'Intimidation'],
    ['investigation', 'Investigation'],
    ['medicine', 'Medicine'],
    ['nature', 'Nature'],
    ['perception', 'Perception'],
    ['performance', 'Performance'],
    ['persuasion', 'Persuasion'],
    ['religion', 'Religion'],
    ['sleight_of_hand', 'Sleight of Hand'],
    ['stealth', 'Stealth'],
    ['survival', 'Survival'],
  ];

  const num = (value: number | null | undefined): string =>
    value === null || value === undefined ? '—' : String(value);

  const signed = (value: number | null | undefined): string =>
    value === null || value === undefined ? '—' : `${value >= 0 ? '+' : ''}${value}`;

  /** Two dots for expertise, one for proficiency, none otherwise. */
  const dots = (trained: { proficient?: boolean; expertise?: boolean } | undefined): number =>
    trained?.expertise ? 2 : trained?.proficient ? 1 : 0;

  const hpPercent = $derived(
    pc?.hp_max ? Math.max(0, Math.min(100, ((pc.hp_current ?? 0) / pc.hp_max) * 100)) : 0,
  );
  const tempPercent = $derived(
    pc?.hp_max ? Math.max(0, Math.min(100 - hpPercent, ((pc.temp_hp ?? 0) / pc.hp_max) * 100)) : 0,
  );
  const tickPercent = $derived(pc?.hp_max ? Math.max(2, (5 / pc.hp_max) * 100) : 100);
  const hpTone = $derived(hpPercent >= 50 ? 'good' : hpPercent >= 25 ? 'warn' : 'bad');
  const spellSlots = $derived(Object.entries(pc?.spell_slots ?? {}).sort(([a], [b]) => Number(a) - Number(b)));
  const proficiencies = $derived(
    Object.entries(pc?.proficiencies ?? {}).filter(([, list]) => (list ?? []).length > 0),
  );
  const weight = $derived(loadBar(pc?.carried_lb ?? 0, pc?.capacity_lb ?? 0));
  /** Drops repeated names (case-insensitive) so a damaged spell list can't render or key twice. */
  function dedupeNames(list: string[] | undefined): string[] | undefined {
    if (!list) return list;
    const seen = new Set<string>();
    return list.filter((name) => {
      const key = name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const spellLists = $derived<Array<{ label: string; help: string; list: string[] | undefined }>>([
    { label: 'Cantrips', help: 'cantrips', list: dedupeNames(pc?.spells?.cantrips) },
    { label: 'Prepared', help: 'prepared', list: dedupeNames(pc?.spells?.prepared) },
    { label: 'Known', help: 'known', list: dedupeNames(pc?.spells?.known) },
    { label: 'Spellbook', help: 'spellbook', list: dedupeNames(pc?.spells?.spellbook) },
    { label: 'Always prepared (feat)', help: 'always_prepared', list: dedupeNames(pc?.spells?.granted) },
  ]);
  /** Which of the book's pages are prepared today, matched the way the server matches spell names. */
  const preparedNames = $derived(
    new Set((pc?.spells?.prepared ?? []).map((name) => name.trim().toLowerCase())),
  );
  const untrainedWeapons = $derived((pc?.weapons_not_proficient ?? []).map((name) => name.toLowerCase()));
  const notProficient = (name: string | undefined): boolean =>
    untrainedWeapons.some((weapon) => (name ?? '').toLowerCase().includes(weapon));
  /** Resistances, vulnerabilities and immunities as one line each, only where there is something to say. */
  const damageLines = $derived(
    [
      { label: 'Resists', help: 'resistances', types: pc?.resistances ?? [] },
      { label: 'Vulnerable', help: 'vulnerabilities', types: pc?.vulnerabilities ?? [] },
      { label: 'Immune', help: 'immunities', types: pc?.immunities ?? [] },
    ].filter((line) => line.types.length > 0),
  );
  const homebrewSpells = $derived(pc?.homebrew_spells ?? []);
  /** The inventory as rows, a container followed by what it holds. */
  const inventoryRows = $derived(flatItems(pc?.inventory));
  /** "chain mail · shield · +1 Shield: +1 AC": where the armour class comes from, when the server says. */
  const acNote = $derived.by(() => {
    const ac = pc?.ac_breakdown;
    if (!ac) return null;
    // The server's notes already spell out the feature and magic bonuses; the numbers are the fallback.
    const detail =
      (ac.notes?.length ?? 0) > 0
        ? ac.notes!
        : [
            ...(ac.feature_bonus ? [`+${ac.feature_bonus} features`] : []),
            ...(ac.magic_bonus ? [`+${ac.magic_bonus} magic`] : []),
          ];
    return [ac.armor ?? 'no armour', ...(ac.shield ? ['shield'] : []), ...detail].join(' · ');
  });
  /** "1200 / 2700" once the server sends the next threshold; the plain total otherwise. */
  const xpShown = $derived(
    typeof pc?.xp_next === 'number' ? `${num(pc.xp)} / ${num(pc.xp_next)}` : num(pc?.xp),
  );
  /** "800 XP to level 5", or "top level" at 20; absent on a server that has not sent xp_next yet. */
  const xpNote = $derived(
    typeof pc?.xp_next === 'number'
      ? (pc.xp ?? 0) >= pc.xp_next
        ? `Level ${num((pc.level ?? 0) + 1)} reached`
        : `${num(pc.xp_next - (pc.xp ?? 0))} XP to level ${num((pc.level ?? 0) + 1)}`
      : pc?.xp_next === null
        ? 'top level'
        : null,
  );
  /** "Concentrating on Fireball (slot 3)": the spell held in mind, with its slot level when known. */
  const concentratingLabel = $derived(
    pc?.concentrating_on
      ? `Concentrating on ${pc.concentrating_on.spell}${
          pc.concentrating_on.slot_level ? ` (slot ${pc.concentrating_on.slot_level})` : ''
        }`
      : null,
  );

  /** Every spell name the sheet shows, so their tooltips can be fetched in one batch. */
  const shownSpellNames = $derived([
    ...(pc?.spells?.cantrips ?? []),
    ...(pc?.spells?.prepared ?? []),
    ...(pc?.spells?.known ?? []),
    ...(pc?.spells?.spellbook ?? []),
    ...(pc?.spells?.granted ?? []),
    ...homebrewSpells.map((spell) => spell.name),
  ]);

  $effect(() => {
    void wantSpellDetails(shownSpellNames);
  });
</script>

<section>
  <h2 class="section-title">Character</h2>

  {#if !pc}
    {#if draft}
      <p class="empty prose">Waiting for the DM to finish this character: {draftLine(draft)}.</p>
    {:else}
      <p class="empty prose">No character yet. Ask the DM to start character creation.</p>
    {/if}
  {:else}
    <div class="identity" use:dropImage={{ ondrop: upload }}>
      <Portrait
        path={pc.portrait_path ?? null}
        monogram={(pc.name ?? '?').slice(0, 1)}
        size={64}
        round
        alt=""
        name={pc.name ?? 'Unnamed'}
      />
      <div class="who">
        <h3>{pc.name ?? 'Unnamed'}</h3>
        <p class="muted">
          Level <span class="num">{num(pc.level)}</span>
          {pc.species ?? ''}
          {#if pc.size}(<Help k={sizeHelpKey(pc.size)} text={pc.size} />){/if}
          {pc.class ?? ''}{pc.subclass ? ` (${pc.subclass})` : ''}
          {#if pc.background}· {pc.background}{/if}
        </p>
        {#if pc.status && pc.status !== 'active'}<span class="chip bad">{pc.status}</span>{/if}
        {#if preparedLevelUp()}
          <button type="button" class="levelup" onclick={openLevelUp}>Level up available</button>
        {:else if awaitingDm()}
          <p class="label levelup-wait">Level-up available — ask the DM to prepare your options.</p>
        {/if}
        {#if portraitsOff && !pc.portrait_path}
          <p class="label drop-hint">Portraits: off — drop an image here</p>
        {/if}
      </div>
    </div>

    <div class="hp">
      <div class="hp-head">
        <span class="label"><Help k="hp" text="Hit points" /></span>
        <span class="hp-value num">{num(pc.hp_current)} / {num(pc.hp_max)}</span>
        {#if pc.temp_hp}<span class="chip"><Help k="temp_hp" text="+{pc.temp_hp} temp" /></span>{/if}
      </div>
      <div
        class="bar"
        style="--fill: {hpPercent}%; --temp: {tempPercent}%; --tick: {tickPercent}%"
        role="meter"
        aria-valuenow={pc.hp_current ?? 0}
        aria-valuemin="0"
        aria-valuemax={pc.hp_max ?? 0}
        aria-label="Hit points"
      >
        <span class="fill {hpTone}"></span>
        <span class="temp"></span>
        <span class="ticks"></span>
      </div>
      {#if pc.hp_current === 0}
        <div class="deaths">
          <span class="label"><Help k="death_saves" text="Death saves" /></span>
          {#if pc.stable}<span class="chip good"><Help k="stable" text="Stable" /></span>{/if}
          <span class="rings">
            {#each [0, 1, 2] as i (i)}
              <span class="ring good" class:on={(pc.death_saves?.successes ?? 0) > i}></span>
            {/each}
          </span>
          <span class="rings">
            {#each [0, 1, 2] as i (i)}
              <span class="ring bad" class:on={(pc.death_saves?.failures ?? 0) > i}></span>
            {/each}
          </span>
        </div>
      {/if}
      {#if pc.last_long_rest_at}<p class="muted last-rest">Last long rest: {pc.last_long_rest_at}</p>{/if}
    </div>

    {#snippet vital(
      label: string,
      shown: string,
      field: OverrideField | null,
      raw: string,
      helpKey: string,
      note: string | null = null,
    )}
      <div>
        <dt class="label"><Help k={helpKey} text={label} /></dt>
        <dd class="num">
          {#if field && editing === field}
            <form
              onsubmit={(event) => {
                event.preventDefault();
                save(field);
              }}
            >
              <input
                type="text"
                inputmode="numeric"
                aria-label={label}
                bind:value={typed}
                onkeydown={(event) => {
                  if (event.key === 'Escape') editing = null;
                }}
              />
            </form>
          {:else}
            {shown}
            {@const dot = handSetDot(cheat, pc?.hand_set, field ?? '')}
            {#if dot === 'button'}
              <button
                type="button"
                class="handset"
                title="hand-set; click to clear"
                aria-label="Clear hand-set {label}"
                onclick={() => field && send(field, { [field]: null })}
              ></button>
            {:else if dot === 'marker'}
              <span class="handset" title="hand-set" aria-hidden="true"></span>
            {/if}
            {#if cheat && field}
              <button
                type="button"
                class="pencil"
                title="Hand-set {label}"
                aria-label="Hand-set {label}"
                onclick={() => open(field, raw)}
              ></button>
            {/if}
          {/if}
        </dd>
        {#if note}<p class="muted note">{note}</p>{/if}
      </div>
    {/snippet}

    <dl class="vitals">
      {@render vital('AC', num(pc.ac), 'ac', num(pc.ac), 'ac', acNote)}
      {@render vital(
        'Speed',
        pc.speed === null || pc.speed === undefined ? '—' : `${pc.speed} ft`,
        'speed',
        num(pc.speed),
        'speed',
        pc.speed_reason ?? null,
      )}
      {@render vital('Init', signed(pc.initiative_bonus), 'initiative_bonus', num(pc.initiative_bonus), 'initiative')}
      {@render vital(
        'Prof',
        signed(pc.proficiency_bonus),
        'proficiency_bonus',
        num(pc.proficiency_bonus),
        'proficiency_bonus',
      )}
      {@render vital(
        'Passive',
        num(pc.passive_perception),
        'passive_perception',
        num(pc.passive_perception),
        'passive_perception',
      )}
      {#if xpMode !== 'milestone'}
        {@render vital('XP', xpShown, null, '', 'xp', xpNote)}
      {/if}
      {@render vital('Gold', num(pc.gold), 'gold', num(pc.gold), 'gold', purseLine(pc.coins))}
    </dl>
    {#if pc.attunement}
      <p class="muted attuned">
        <span class="label"><Help k="attunement" text="Attuned" /></span>
        <span class="num">{pc.attunement.used ?? 0}/{pc.attunement.max ?? 0}</span>
        {#if (pc.attunement.items?.length ?? 0) > 0}— {pc.attunement.items?.join(', ')}{/if}
      </p>
    {/if}
    {#if problem}<span class="chip bad">{problem}</span>{/if}

    <div class="counters">
      <span class="counter">
        <span class="star" class:on={pc.inspiration === 1} aria-hidden="true"></span>
        <span class="label"><Help k="inspiration" text="Heroic Inspiration" /></span>
      </span>
      <span class="counter">
        <span class="label"><Help k="exhaustion" text="Exhaustion" /></span>
        {#if editing === 'exhaustion'}
          <form
            onsubmit={(event) => {
              event.preventDefault();
              save('exhaustion');
            }}
          >
            <input
              type="text"
              inputmode="numeric"
              aria-label="Exhaustion"
              bind:value={typed}
              onkeydown={(event) => {
                if (event.key === 'Escape') editing = null;
              }}
            />
          </form>
        {:else}
          <span class="num" class:warn={(pc.exhaustion ?? 0) > 0}>{pc.exhaustion ?? 0}</span>
          {#if cheat}
            <button
              type="button"
              class="pencil"
              title="Hand-set Exhaustion"
              aria-label="Hand-set Exhaustion"
              onclick={() => open('exhaustion', String(pc.exhaustion ?? 0))}
            ></button>
          {/if}
        {/if}
      </span>
      {#if concentration}
        <span class="chip accent"><Help k="concentration" text="Concentrating: {concentration}" /></span>
      {/if}
      {#if concentratingLabel}
        <span class="chip accent"><Help k="concentration" text={concentratingLabel} /></span>
      {/if}
    </div>

    {#if (pc.conditions?.length ?? 0) > 0 || pc.armor_penalty || pc.stealth_disadvantage}
      <div class="chips">
        {#each pc.conditions ?? [] as condition (condition)}
          <span class="chip bad"><Help k={conditionHelpKey(condition)} text={condition} /></span>
        {/each}
        {#if pc.armor_penalty}
          <span class="chip warn"><Help k="armor_proficiency" text="Armour: not proficient" /></span>
        {/if}
        {#if pc.stealth_disadvantage}
          <span class="chip warn"><Help k="stealth_disadvantage" text="Stealth: disadvantage (armour)" /></span>
        {/if}
      </div>
    {/if}

    {#if damageLines.length > 0}
      <p class="prose damage">
        {#each damageLines as line, i (line.label)}
          {#if i > 0} · {/if}<span class="label"><Help k={line.help} text={line.label} /></span>
          {#each line.types as type, t (type)}
            {#if t > 0}, {/if}{#if damageHelpKey(type)}<Help
                k={damageHelpKey(type) ?? 'damage_types'}
                text={type}
              />{:else}{type}{/if}
          {/each}
        {/each}
      </p>
    {/if}

    <div class="abilities">
      {#each ABILITIES as [key, label] (key)}
        <div class="ability">
          <span class="label"><Help k="ability.{key}" text={label} /></span>
          <span class="mod num"><Help k="ability_modifier" text={signed(pc.abilities?.[key]?.mod)} /></span>
          <span class="score num"><Help k="ability_score" text={num(pc.abilities?.[key]?.score)} /></span>
        </div>
      {/each}
    </div>

    <div class="ledgers">
      <div>
        <h4 class="label"><Help k="saving_throws" text="Saving throws" /></h4>
        <ul class="ledger">
          {#each ABILITIES as [key, label] (key)}
            <li>
              <span class="dots" aria-hidden="true">
                {#each { length: dots(pc.saves?.[key]) } as _, i (i)}<span class="dot"></span>{/each}
              </span>
              <span class="name" class:trained={dots(pc.saves?.[key]) > 0}>
                <Help k="save.{key}" text={label} />
              </span>
              <span class="num">{signed(pc.saves?.[key]?.bonus)}</span>
            </li>
          {/each}
        </ul>
      </div>
      <div>
        <h4 class="label"><Help k="skills" text="Skills" /></h4>
        <ul class="ledger">
          {#each SKILLS as [key, label] (key)}
            <li>
              <span class="dots" aria-hidden="true">
                {#each { length: dots(pc.skills?.[key]) } as _, i (i)}<span class="dot"></span>{/each}
              </span>
              <span class="name" class:trained={dots(pc.skills?.[key]) > 0}>
                <Help k="skill.{key}" text={label} />
              </span>
              <span class="num">{signed(pc.skills?.[key]?.bonus)}</span>
            </li>
          {/each}
        </ul>
      </div>
    </div>

    {#if proficiencies.length > 0}
      <div class="block">
        <h4 class="label">Proficiencies</h4>
        {#each proficiencies as [kind, list] (kind)}
          <p class="prose">
            <span class="label">
              {#if kind === 'languages'}<Help k="languages" text={kind} label />{:else}{kind}{/if}
            </span>
            {(list ?? []).join(', ')}
          </p>
        {/each}
      </div>
    {/if}

    {#if (pc.features?.length ?? 0) > 0}
      <div class="block">
        <h4 class="label">Features</h4>
        {#each pc.features ?? [] as feature (feature.name)}
          <details>
            <summary>
              <span class="feature-name">{feature.name ?? 'Feature'}</span>
              <span class="chip" class:accent={feature.source === 'homebrew'}>{feature.source ?? 'srd'}</span>
              {#if feature.mechanics?.over_budget}
                <span class="over-budget"><Help k="power_budget" text="over budget" label /></span>
              {/if}
            </summary>
            <p class="prose muted">{feature.text ?? '—'}</p>
          </details>
        {/each}
      </div>
    {/if}

    {#if pc.spells || spellSlots.length > 0 || homebrewSpells.length > 0}
      <div class="block">
        <h4 class="label">Spells</h4>
        {#if pc.spells?.spellcasting_ability}
          <p class="muted">
            <Help k="spellcasting_ability" text={pc.spells.spellcasting_ability} /> ·
            <Help k="spell_save_dc" text="save DC" />
            <span class="num">{num(pc.spells?.save_dc)}</span> ·
            <Help k="spell_attack_bonus" text="attack" />
            <span class="num">{signed(pc.spells?.attack_bonus)}</span>
          </p>
        {/if}
        {#each spellLists as group (group.label)}
          {#if (group.list?.length ?? 0) > 0}
            <p class="prose">
              <span class="label"><Help k={group.help} text={group.label} /></span>
              {#each group.list ?? [] as name, index (`${group.label}:${name}:${index}`)}
                {#if index > 0}, {/if}
                {@const detail = spellTooltip(name, spellDetail(name))}
                <Help text={name} help={detail.help} head={detail.head} />
                {#if group.label === 'Spellbook' && preparedNames.has(name.trim().toLowerCase())}
                  <span class="label prepared">prepared</span>
                {/if}
              {/each}
            </p>
          {/if}
        {/each}
        {#if homebrewSpells.length > 0}
          <p class="prose">
            <span class="label">Homebrew</span>
            {#each homebrewSpells as spell, index (spell.homebrew_id)}
              {#if index > 0}, {/if}
              {@const detail = spellTooltip(spell.name, spellDetail(spell.name), spell.level)}
              <Help text={spell.name} help={detail.help} head={detail.head} />
            {/each}
          </p>
        {/if}
        {#each spellSlots as [level, slot] (level)}
          <div class="slots">
            <span class="label"><Help k="spell_slots" text="Level {level}" /></span>
            {#each { length: slot?.max ?? 0 } as _, i (i)}
              <span class="pip" class:on={i < (slot?.max ?? 0) - (slot?.used ?? 0)}></span>
            {/each}
          </div>
        {/each}
      </div>
    {/if}

    {#if (pc.inventory?.length ?? 0) > 0}
      <div class="block">
        <h4 class="label">Inventory</h4>
        {#if !encumbranceOff && pc.capacity_lb}
          <div class="weight">
            <div class="weight-head">
              <span class="label"><Help k="carrying_capacity" text="Carried" /></span>
              <span class="num">{num(pc.carried_lb)} / {num(pc.capacity_lb)} lb</span>
              {#if pc.encumbered}
                <span class="chip bad"><Help k="encumbered" text="Encumbered — speed 5 ft" /></span>
              {/if}
            </div>
            <div
              class="bar weight-bar"
              style="--fill: {weight.percent}%"
              role="meter"
              aria-valuenow={pc.carried_lb ?? 0}
              aria-valuemin="0"
              aria-valuemax={pc.capacity_lb ?? 0}
              aria-label="Carried weight"
            >
              <span class="fill {weight.tone}"></span>
            </div>
          </div>
        {/if}
        <ul class="inventory">
          {#each inventoryRows as { item, depth, key } (key)}
            <li>
              <span class="name" style="--depth: {depth}">
                {item.name ?? '—'}{item.notes ? ` — ${item.notes}` : ''}
                {#each itemBadges(item) as badge (badge.text)}
                  <span class="chip badge">
                    {#if badge.help}<Help k={badge.help} text={badge.text} />{:else}{badge.text}{/if}
                  </span>
                {/each}
                {#if notProficient(item.name)}
                  <span class="label untrained"><Help k="weapon_proficiency" text="not proficient" label /></span>
                {/if}
              </span>
              <span class="num weight-cell">{itemWeightLabel(item)}</span>
              <span class="num">{item.qty ?? 1}</span>
              <span class="equipped" class:on={item.equipped} title={item.equipped ? 'Equipped' : ''}></span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  {/if}
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  .damage {
    margin: 0;
    font-size: var(--t-13);
  }

  .prepared,
  .untrained {
    color: var(--ink-faint);
  }

  h3 {
    font-family: var(--font-display);
    font-size: var(--t-24);
    letter-spacing: 0.01em;
  }

  h4 {
    margin-bottom: 0.3rem;
  }

  .identity {
    display: flex;
    align-items: flex-start;
    gap: 0.7rem;
  }

  .identity:global(.dropping) {
    outline: 1px dashed var(--accent);
    outline-offset: 3px;
  }

  .identity p {
    margin: 0.1rem 0 0.3rem;
    font-size: var(--t-15);
  }

  .drop-hint {
    margin: 0.1rem 0 0;
    text-transform: none;
    letter-spacing: 0;
  }

  .levelup {
    margin-top: 0.2rem;
    padding: 0 0.3rem;
    color: var(--accent);
    border-color: var(--accent);
  }

  .levelup-wait {
    margin: 0.2rem 0 0;
    text-transform: none;
    letter-spacing: 0;
  }

  /* The one lifted element on the screen. */
  .hp {
    background: var(--surface-raised);
    border: 1px solid var(--rule);
    padding: 0.6rem 0.7rem;
  }

  .hp-head {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    margin-bottom: 0.4rem;
  }

  .hp-value {
    font-size: var(--t-18);
    font-weight: 600;
  }

  .bar {
    position: relative;
    height: 0.85rem;
    border: 1px solid var(--rule);
    background: var(--surface);
    overflow: hidden;
  }

  .fill,
  .temp,
  .ticks {
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

  .ticks {
    left: 0;
    right: 0;
    background: repeating-linear-gradient(
      90deg,
      transparent 0 calc(var(--tick) - 1px),
      var(--rule) calc(var(--tick) - 1px) var(--tick)
    );
  }

  .deaths {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.5rem;
  }

  .last-rest {
    margin: 0.4rem 0 0;
    font-size: var(--t-13);
  }

  .rings {
    display: inline-flex;
    gap: 0.3rem;
  }

  .ring {
    width: 0.7rem;
    height: 0.7rem;
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

  .vitals {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(4.6rem, 1fr));
    gap: 0.4rem;
    margin: 0;
  }

  .vitals .note {
    margin: 0.1rem 0 0;
    font-size: var(--t-12);
  }

  .vitals div {
    border: 1px solid var(--rule);
    padding: 0.25rem 0.4rem;
  }

  .vitals dd {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin: 0;
    font-size: var(--t-18);
  }

  .vitals input,
  .counter input {
    width: 3.4rem;
    font-family: var(--font-mono);
    font-size: var(--t-15);
    color: var(--ink);
    background: var(--surface-raised);
    border: 1px solid var(--accent);
    padding: 0 0.2rem;
  }

  /* A pencil drawn from a square: a slanted body with a point, so no glyph or icon font is needed. */
  .pencil {
    width: 0.65rem;
    height: 0.65rem;
    padding: 0;
    border: none;
    background: var(--ink-faint);
    clip-path: polygon(0% 100%, 22% 62%, 74% 10%, 90% 26%, 38% 78%);
  }

  .pencil:hover {
    background: var(--accent);
  }

  .handset {
    width: 0.4rem;
    height: 0.4rem;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--accent);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  /* The permanent counters: inspiration, exhaustion and whatever is being concentrated on. */
  .counters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem 0.9rem;
  }

  .counter {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .counter .num.warn {
    color: var(--warn);
  }

  /* A five-pointed star drawn from a square: hollow until the DM grants inspiration. */
  .star {
    width: 0.85rem;
    height: 0.85rem;
    background: var(--ink-faint);
    clip-path: polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%);
  }

  .star.on {
    background: var(--accent);
  }

  .abilities {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.45rem;
  }

  .ability {
    display: grid;
    justify-items: center;
    gap: 0.05rem;
    border: 1px solid var(--rule);
    padding: 0.35rem 0.2rem;
  }

  .mod {
    font-size: var(--t-24);
    font-weight: 600;
    line-height: 1.1;
  }

  .score {
    font-size: var(--t-13);
    color: var(--ink-muted);
  }

  .ledgers {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: 0.8rem 1.4rem;
  }

  .ledger,
  .inventory {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .ledger li {
    display: grid;
    grid-template-columns: 1.5rem 1fr auto;
    align-items: baseline;
    gap: 0.3rem;
    font-size: var(--t-13);
    padding: 0.08rem 0;
    border-bottom: 1px solid var(--rule);
  }

  .ledger .name {
    color: var(--ink-muted);
  }

  .ledger .name.trained {
    color: var(--ink);
  }

  .dots {
    display: inline-flex;
    gap: 0.15rem;
  }

  .dots .dot {
    width: 0.35rem;
    height: 0.35rem;
    border-radius: 50%;
    background: var(--accent);
    align-self: center;
  }

  .block p {
    margin: 0.15rem 0;
    font-size: var(--t-15);
  }

  .feature-name {
    font-weight: 500;
  }

  /* A feature the DM applied above the power budget on purpose: marked, never hidden. */
  .over-budget {
    color: var(--warn);
  }

  details {
    padding: 0.15rem 0;
    border-bottom: 1px solid var(--rule);
  }

  .slots {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-top: 0.25rem;
  }

  .slots .label {
    margin-right: 0.3rem;
  }

  .pip {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    border: 1px solid var(--accent);
  }

  .pip.on {
    background: var(--accent);
  }

  .inventory li {
    display: grid;
    grid-template-columns: 1fr auto auto 0.8rem;
    align-items: baseline;
    gap: 0.4rem;
    font-size: var(--t-13);
    padding: 0.08rem 0;
    border-bottom: 1px solid var(--rule);
  }

  .attuned {
    margin: 0;
    font-size: var(--t-13);
  }

  .inventory .name {
    padding-left: calc(var(--depth, 0) * 0.9rem);
  }

  .badge {
    font-size: var(--t-12);
  }

  .weight-cell {
    color: var(--ink-muted);
  }

  .weight {
    display: grid;
    gap: 0.2rem;
    margin-bottom: 0.4rem;
  }

  .weight-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .weight-bar {
    height: 0.4rem;
  }

  .equipped {
    width: 0.45rem;
    height: 0.45rem;
    align-self: center;
    justify-self: center;
  }

  .equipped.on {
    background: var(--accent);
  }
</style>
