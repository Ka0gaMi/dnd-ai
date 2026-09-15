<script lang="ts">
  import BattleMap from './BattleMap.svelte';
  import CombatantCard from './CombatantCard.svelte';
  import FightLog from './FightLog.svelte';
  import Help from './Help.svelte';
  import InitiativeBar from './InitiativeBar.svelte';
  import { undoCombat } from '../lib/api';
  import { actionHelpKey } from '../lib/rulesHelp';
  import { conditionEffects, splitHint, surprisedIds, type Totals } from '../lib/combat.svelte';
  import type { BattleState, Combatant, CombatLogEntry } from '../lib/types';

  let {
    battle,
    log,
    totals,
    campaignId,
    portraitOf = () => null,
  }: {
    battle: BattleState;
    log: CombatLogEntry[];
    totals: Map<number, Totals>;
    campaignId: number;
    portraitOf?: (combatant: Combatant) => string | null;
  } = $props();

  const party = $derived(battle.combatants.filter((c) => c.team === 'party'));
  const foes = $derived(battle.combatants.filter((c) => c.team !== 'party'));
  const active = $derived(battle.combatants.find((c) => c.id === battle.active?.id) ?? null);
  const effects = $derived(conditionEffects(log));
  const surprised = $derived(surprisedIds(log));
  const names = $derived(new Map(battle.combatants.map((c) => [c.id, c.name])));
  const nameOf = (id: number): string => names.get(id) ?? 'someone';

  let confirmUndo = $state(false);
  let undoNote = $state<string | null>(null);

  /** One click asks, the second takes the last combat call back; the event redraws the fight. */
  async function undo(): Promise<void> {
    try {
      const done = await undoCombat(campaignId);
      undoNote = `Took back: ${done.undone}.`;
    } catch (failure) {
      undoNote = failure instanceof Error ? failure.message : String(failure);
    }
    confirmUndo = false;
  }
</script>

<div class="head">
  <button type="button" class="label" aria-expanded={confirmUndo} onclick={() => (confirmUndo = !confirmUndo)}>
    Undo last action
  </button>
  {#if confirmUndo}
    <button type="button" class="label go" onclick={undo}>Take it back</button>
  {/if}
  {#if undoNote}<span class="muted note">{undoNote}</span>{/if}
</div>

<InitiativeBar
  combatants={battle.combatants}
  activeId={battle.active?.id ?? null}
  round={battle.round}
  {surprised}
  {portraitOf}
/>

<BattleMap {battle} {log} {campaignId} />

<section>
  <h2 class="section-title">Your side</h2>
  <div class="cards">
    {#each party as combatant (combatant.id)}
      <CombatantCard
        {combatant}
        visibility={battle.encounter.visibility}
        active={combatant.id === battle.active?.id}
        {campaignId}
        portrait={portraitOf(combatant)}
        {effects}
        {nameOf}
      />
    {/each}
  </div>
</section>

<section>
  <h2 class="section-title">Enemies</h2>
  {#if foes.length === 0}
    <p class="empty">No one left standing against you.</p>
  {:else}
    <div class="cards">
      {#each foes as combatant (combatant.id)}
        <CombatantCard
          {combatant}
          visibility={battle.encounter.visibility}
          active={combatant.id === battle.active?.id}
          {campaignId}
          portrait={portraitOf(combatant)}
          {effects}
          {nameOf}
        />
      {/each}
    </div>
  {/if}
</section>

<section>
  <h2 class="section-title">What can I do</h2>
  {#if active && active.team === 'party' && battle.legal_actions.length > 0}
    <ul class="actions">
      {#each battle.legal_actions as action (action.id)}
        {@const said = splitHint(action.hint)}
        <li>
          <span class="what"><Help k={actionHelpKey(action.id)} text={action.label} /></span>
          <span class="muted">
            {said.hint}
            {#if said.caveat}
              <span class="caveat"><Help k="weapon_proficiency" text={said.caveat} /></span>
            {/if}
          </span>
        </li>
      {/each}
    </ul>
    <p class="label ask">Tell the DM in chat which one you take.</p>
  {:else if battle.active}
    <p class="empty">Waiting for {battle.active.name}…</p>
  {:else}
    <p class="empty">No one is up.</p>
  {/if}
</section>

<FightLog {log} combatants={battle.combatants} {totals} />

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }

  .head button {
    text-transform: none;
    letter-spacing: 0.04em;
  }

  .head .go {
    color: var(--accent);
    border-color: var(--accent);
  }

  .note {
    font-size: var(--t-13);
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: 0.5rem;
  }

  .actions {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .actions li {
    display: grid;
    grid-template-columns: minmax(6rem, auto) 1fr;
    gap: 0.5rem;
    align-items: baseline;
    font-size: var(--t-13);
    padding: 0.15rem 0;
    border-bottom: 1px solid var(--rule);
  }

  .what {
    font-weight: 500;
  }

  /* "Not proficient: no proficiency bonus." sits quieter than the rest of the hint. */
  .caveat {
    color: var(--ink-faint);
  }

  .ask {
    margin: 0.4rem 0 0;
    text-transform: none;
    letter-spacing: 0;
  }
</style>
