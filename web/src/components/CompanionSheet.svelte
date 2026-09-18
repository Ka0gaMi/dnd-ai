<script lang="ts">
  import CharacterSheet from './CharacterSheet.svelte';
  import {
    closeCompanionSheet,
    companionSheet,
    loadCompanionSheet,
    syncCompanionSheet,
  } from '../lib/companionSheet.svelte';
  import type { XpMode } from '../lib/settings';
  import type { Snapshot } from '../lib/types';

  let {
    snapshot = null,
    portraitsOff = false,
    encumbranceOff = false,
    xpMode = 'xp',
  }: {
    /** Replaced by the connection whenever a character's hp or inventory could have moved. */
    snapshot?: Snapshot | null;
    portraitsOff?: boolean;
    encumbranceOff?: boolean;
    xpMode?: XpMode;
  } = $props();

  let dialogEl = $state<HTMLDialogElement | undefined>();

  /** Native <dialog> owns open/close and focus return; this just mirrors the store's intent. */
  $effect(() => {
    if (!dialogEl) return;
    if (companionSheet.id !== null && !dialogEl.open) dialogEl.showModal();
    else if (companionSheet.id === null && dialogEl.open) dialogEl.close();
  });

  /** A new companion refetches; a fresh snapshot refetches again while one is open. */
  $effect(() => {
    if (companionSheet.id !== null) void loadCompanionSheet();
  });

  $effect(() => {
    void syncCompanionSheet(snapshot);
  });

  /** A click that lands on the dialog element itself (not its content) is a click on the backdrop. */
  function onBackdropClick(event: MouseEvent): void {
    if (event.target === dialogEl) dialogEl?.close();
  }
</script>

<dialog
  bind:this={dialogEl}
  class="sheet"
  aria-label={companionSheet.sheet?.name ?? 'Companion sheet'}
  onclose={closeCompanionSheet}
  onclick={onBackdropClick}
>
  {#if companionSheet.id !== null}
    <header>
      <h2 class="name">{companionSheet.sheet?.name ?? 'Companion'}</h2>
      <button type="button" onclick={() => dialogEl?.close()}>Close</button>
    </header>
    {#if companionSheet.error}
      <p class="muted problem">{companionSheet.error}</p>
    {:else if companionSheet.sheet}
      <div class="body">
        <CharacterSheet
          pc={companionSheet.sheet}
          cheat={false}
          levelUp={false}
          {portraitsOff}
          {encumbranceOff}
          {xpMode}
        />
      </div>
    {:else}
      <p class="muted">Loading…</p>
    {/if}
  {/if}
</dialog>

<style>
  /* display lives on [open] alone: the UA's dialog:not([open]) { display: none } must win while closed. */
  .sheet {
    max-width: min(48rem, 92vw);
    max-height: 90vh;
    padding: 1rem;
    background: var(--surface);
    border: 1px solid var(--rule);
    color: var(--ink);
  }

  .sheet[open] {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .sheet::backdrop {
    background: var(--ground);
    opacity: 0.85;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    border-bottom: 1px solid var(--rule);
    padding-bottom: 0.5rem;
  }

  .name {
    font-family: var(--font-display);
    font-size: var(--t-18);
  }

  /* The sheet is taller than the dialog: it scrolls, the header and Close stay put. */
  .body {
    min-height: 0;
    overflow-y: auto;
  }

  .problem {
    margin: 0;
  }
</style>
