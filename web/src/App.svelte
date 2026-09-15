<script lang="ts">
  import Battle from './components/Battle.svelte';
  import CampaignPicker from './components/CampaignPicker.svelte';
  import CharacterSheet from './components/CharacterSheet.svelte';
  import Codex from './components/Codex.svelte';
  import Companions from './components/Companions.svelte';
  import DecisionDialog from './components/DecisionDialog.svelte';
  import DiceLog from './components/DiceLog.svelte';
  import EncounterSummary from './components/EncounterSummary.svelte';
  import Glossary from './components/Glossary.svelte';
  import Header from './components/Header.svelte';
  import LevelUp from './components/LevelUp.svelte';
  import Library from './components/Library.svelte';
  import Lightbox from './components/Lightbox.svelte';
  import NewStory from './components/NewStory.svelte';
  import Objectives from './components/Objectives.svelte';
  import PlayProfile from './components/PlayProfile.svelte';
  import RollPrompt from './components/RollPrompt.svelte';
  import Story from './components/Story.svelte';
  import { getCampaigns, getGlossary, getPortraitStatus, getRolls } from './lib/api';
  import { connectLive } from './lib/connection';
  import { autoPickId, watchCampaigns } from './lib/picker';
  import {
    creatureName,
    creaturePortrait,
    portraitFor,
    portraitVersion,
    wantCreaturePortrait,
  } from './lib/portraits.svelte';
  import { GameStore } from './lib/store.svelte';
  import type { CampaignListItem, Combatant, GlossaryEntry } from './lib/types';

  const STORAGE_KEY = 'dnd-ai.campaign';
  const RIGHT_KEY = 'dnd-ai.right-tab';
  const TABS = [
    { id: 'battle', label: 'Battle' },
    { id: 'story', label: 'Story' },
  ] as const;
  /** The dice ledger keeps the top of the column; only these two share the strip beneath it. */
  const RIGHT_TABS = [
    { id: 'glossary', label: 'Glossary' },
    { id: 'codex', label: 'Codex' },
  ] as const;

  type RightTab = (typeof RIGHT_TABS)[number]['id'];

  const store = new GameStore();
  let campaignId = $state<number | null>(initialCampaignId());
  let campaigns = $state<CampaignListItem[]>([]);
  let glossary = $state<GlossaryEntry[]>([]);
  let tab = $state<'battle' | 'story'>('battle');
  let rightTab = $state<RightTab>(rememberedRightTab());
  let wizard = $state(false);
  let portraitsEnabled = $state(true);

  const battle = $derived(store.combat.state);
  const inCombat = $derived(battle?.encounter.status === 'active');
  /** The open chapter tags the rows the "this chapter" filters work on. */
  const chapterId = $derived(store.snapshot?.story?.chapter?.id ?? null);

  /** The server's own portrait wins; a party member's sheet or a monster's creature name fills the rest. */
  function portraitOf(combatant: Combatant): string | null {
    return portraitFor(combatant, (c) => {
      if (c.character_id === null) return creaturePortrait(creatureName(c.name));
      const pc = store.snapshot?.pc;
      if (pc?.id === c.character_id) return pc.portrait_path ?? null;
      return store.snapshot?.companions?.find((m) => m.id === c.character_id)?.portrait_path ?? null;
    });
  }

  function refreshRolls(): void {
    if (campaignId === null) return;
    getRolls(campaignId)
      .then((rows) => store.setRolls(rows))
      .catch(() => undefined);
  }
  /** The sheet shows what the PC's combatant is concentrating on while a fight is running. */
  const concentration = $derived(
    battle?.combatants.find((c) => c.kind === 'pc')?.concentration?.name ?? null,
  );

  /** "m" swaps the middle column and "c" opens the codex; "/" is the glossary's own, and it asks. */
  function onkeydown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === 'm' && inCombat) tab = tab === 'battle' ? 'story' : 'battle';
    if (event.key === 'c') setRightTab('codex');
  }

  function rememberedRightTab(): RightTab {
    const saved = localStorage.getItem(RIGHT_KEY);
    return RIGHT_TABS.some((option) => option.id === saved) ? (saved as RightTab) : 'glossary';
  }

  function setRightTab(next: RightTab): void {
    rightTab = next;
    localStorage.setItem(RIGHT_KEY, next);
  }

  /** ?campaign=<id> wins over the remembered choice; neither means "show the picker". */
  function initialCampaignId(): number | null {
    const fromQuery = Number(new URLSearchParams(location.search).get('campaign'));
    if (Number.isInteger(fromQuery) && fromQuery > 0) return fromQuery;
    const remembered = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isInteger(remembered) && remembered > 0 ? remembered : null;
  }

  /** After a delete or restore, so the list does not wait for the next poll. */
  async function refreshCampaigns(): Promise<void> {
    campaigns = await getCampaigns(true);
  }

  function pick(id: number): void {
    campaignId = id;
  }

  function unpick(): void {
    campaignId = null;
    store.snapshot = null;
    store.rolls = [];
    store.combat.clearEncounter();
    store.prompts.clear();
    store.decisions.clear();
  }

  $effect(() => {
    const id = campaignId;
    if (id === null) {
      localStorage.removeItem(STORAGE_KEY);
      // While the wizard is up it owns the screen: no polling, no auto-pick behind it.
      if (wizard) return;
      return watchCampaigns((list) => {
        const auto = autoPickId(campaigns, list);
        campaigns = list;
        if (auto !== null) campaignId = auto;
      });
    }
    localStorage.setItem(STORAGE_KEY, String(id));
    getGlossary(id)
      .then((list) => (glossary = list))
      .catch(() => (glossary = []));
    return connectLive(store, id);
  });

  $effect(() => {
    document.title = store.snapshot?.campaign.name ?? 'DnD AI';
  });

  $effect(() => {
    getPortraitStatus()
      .then((status) => (portraitsEnabled = status.enabled))
      .catch(() => (portraitsEnabled = false));
  });

  /** A monster without its own portrait_path asks for its creature portrait once, and again after an upload. */
  $effect(() => {
    const id = campaignId;
    void portraitVersion();
    if (id === null) return;
    for (const combatant of battle?.combatants ?? []) {
      if (combatant.character_id === null && combatant.portrait_path === null) {
        wantCreaturePortrait(id, creatureName(combatant.name));
      }
    }
  });
</script>

<svelte:window {onkeydown} />

{#if wizard}
  <NewStory
    onclose={() => (wizard = false)}
    onopen={(id) => {
      wizard = false;
      pick(id);
    }}
  />
{:else if campaignId === null}
  <CampaignPicker {campaigns} onpick={pick} onrefresh={refreshCampaigns} onnew={() => (wizard = true)} />
{:else}
  <div class="screen">
    <Header
      snapshot={store.snapshot}
      status={store.status}
      error={store.error}
      settings={store.settings}
      onsettings={(settings) => {
        const spoilers = store.settings.show_secrets;
        store.setSettings(settings);
        // Secrets change what the snapshot carries: ask for a fresh one.
        if (settings.show_secrets !== spoilers) store.resubscribe?.();
      }}
      onswitch={unpick}
      onnew={() => (wizard = true)}
    />
    <main class="triptych">
      <div class="column">
        <CharacterSheet
          pc={store.snapshot?.pc ?? null}
          draft={store.snapshot?.character_draft ?? null}
          {concentration}
          cheat={store.settings.cheat_mode}
          portraitsOff={!portraitsEnabled}
          encumbranceOff={store.settings.encumbrance === 'off'}
          xpMode={store.settings.xp_mode}
        />
        <Companions companions={store.snapshot?.companions ?? []} />
        <PlayProfile
          {campaignId}
          characterId={store.snapshot?.pc?.id ?? null}
          version={store.progressionVersion}
        />
        <Library {campaignId} version={store.progressionVersion} />
      </div>
      <div class="column">
        <RollPrompt
          prompt={store.prompts}
          cheat={store.settings.cheat_mode}
          inspiration={store.snapshot?.pc?.inspiration === 1}
          timeoutS={store.settings.roll_timeout_s}
          onresolved={refreshRolls}
        />
        <DecisionDialog
          decisions={store.decisions}
          timeoutS={store.settings.roll_timeout_s}
          onresolved={() => store.resubscribe?.()}
        />
        {#if inCombat && battle}
          <div class="tabs" role="group" aria-label="Middle column">
            {#each TABS as option (option.id)}
              <button
                type="button"
                class="tab label"
                aria-pressed={tab === option.id}
                onclick={() => (tab = option.id)}
              >
                {option.label}
              </button>
            {/each}
            <span class="label hint">m</span>
          </div>
          {#if tab === 'battle'}
            <Battle
              {battle}
              log={store.combat.log}
              totals={store.combat.totals}
              {campaignId}
              {portraitOf}
            />
          {:else}
            <Objectives quests={store.snapshot?.open_quests ?? []} {chapterId} />
            <Story
              snapshot={store.snapshot}
              showSecrets={store.settings.show_secrets}
              onrewound={() => store.resubscribe?.()}
            />
          {/if}
        {:else}
          {#if store.combat.lastEnd}
            <EncounterSummary end={store.combat.lastEnd} />
          {/if}
          <Objectives quests={store.snapshot?.open_quests ?? []} {chapterId} />
          <Story
            snapshot={store.snapshot}
            showSecrets={store.settings.show_secrets}
            onrewound={() => store.resubscribe?.()}
          />
        {/if}
      </div>
      <div class="column">
        <DiceLog rolls={store.rolls} cheat={store.settings.cheat_mode} />
        <div class="tabs" role="group" aria-label="Right column">
          {#each RIGHT_TABS as option (option.id)}
            <button
              type="button"
              class="tab label"
              aria-pressed={rightTab === option.id}
              onclick={() => setRightTab(option.id)}
            >
              {option.label}
            </button>
          {/each}
          <span class="label hint">c</span>
        </div>
        <!-- Both stay mounted: the glossary keeps listening for "/" and the codex keeps its place. -->
        <div class="pane" hidden={rightTab !== 'glossary'}>
          <Glossary entries={glossary} {chapterId} onrequest={() => setRightTab('glossary')} />
        </div>
        <div class="pane" hidden={rightTab !== 'codex'}>
          <Codex {campaignId} version={store.codexVersion} showSecrets={store.settings.show_secrets} />
        </div>
      </div>
    </main>
  </div>
{/if}

<LevelUp
  characterId={store.snapshot?.pc?.id ?? null}
  version={store.progressionVersion}
  onapplied={() => store.resubscribe?.()}
/>
<Lightbox />

<style>
  .tabs {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    border-bottom: 1px solid var(--rule);
    padding-bottom: 0.35rem;
  }

  .tab {
    border: none;
    padding: 0.1rem 0.3rem;
    color: var(--ink-faint);
  }

  .tab[aria-pressed='true'] {
    color: var(--accent);
    border-bottom: 2px solid var(--accent);
  }

  .hint {
    margin-left: auto;
    border: 1px solid var(--rule);
    padding: 0 0.3rem;
  }

  .pane[hidden] {
    display: none;
  }

  .screen {
    display: grid;
    grid-template-rows: auto 1fr;
    min-height: 100dvh;
  }

  .triptych {
    display: grid;
    grid-template-columns: 1fr;
    min-height: 0;
    background: var(--surface);
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    min-width: 0;
    padding: 1rem 1.15rem 2.5rem;
  }

  /* Two columns: the sheet keeps its own column, the other two stack beside it. */
  @media (min-width: 800px) {
    .triptych {
      grid-template-columns: minmax(320px, 1fr) minmax(380px, 1.6fr);
      align-items: start;
    }

    .column:nth-child(1) {
      grid-row: span 2;
    }

    .column + .column {
      border-left: 1px solid var(--rule);
    }
  }

  /* The DM screen proper: three columns, each its own scroll container. */
  @media (min-width: 1200px) {
    .screen {
      height: 100dvh;
    }

    .triptych {
      grid-template-columns: minmax(320px, 1fr) minmax(380px, 1.3fr) minmax(300px, 1fr);
      /* One row the height of the screen, columns stretched into it: without this the
         two-column `align-items: start` leaves each column at content height, so nothing scrolls. */
      grid-template-rows: minmax(0, 1fr);
      align-items: stretch;
      overflow: hidden;
    }

    .column {
      min-height: 0;
      overflow-y: auto;
    }

    .column:nth-child(1) {
      grid-row: auto;
    }
  }
</style>
