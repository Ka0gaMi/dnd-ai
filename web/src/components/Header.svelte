<script lang="ts">
  import Help from './Help.svelte';
  import Now from './Now.svelte';
  import Settings from './Settings.svelte';
  import { deleteCampaign } from '../lib/api';
  import type { CampaignSettings } from '../lib/settings';
  import type { ConnectionStatus } from '../lib/store.svelte';
  import type { Snapshot } from '../lib/types';

  let {
    snapshot,
    status,
    error,
    settings,
    onsettings,
    onswitch,
    onnew,
  }: {
    snapshot: Snapshot | null;
    status: ConnectionStatus;
    error: string | null;
    settings: CampaignSettings;
    onsettings: (settings: CampaignSettings) => void;
    onswitch: () => void;
    onnew: () => void;
  } = $props();

  type Theme = 'system' | 'light' | 'dark';
  const THEMES: Theme[] = ['system', 'light', 'dark'];
  const THEME_KEY = 'dnd-ai.theme';

  let theme = $state<Theme>(storedTheme());
  let showSettings = $state(false);
  let confirming = $state(false);
  let typed = $state('');
  let deleteError = $state<string | null>(null);

  const scene = $derived(snapshot?.current_scene?.title ? snapshot.current_scene : (snapshot?.previous_scene ?? null));

  function storedTheme(): Theme {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  }

  function askDelete(): void {
    confirming = !confirming;
    typed = '';
    deleteError = null;
  }

  async function confirmDelete(campaignId: number): Promise<void> {
    deleteError = null;
    try {
      await deleteCampaign(campaignId);
      confirming = false;
      onswitch();
    } catch (problem) {
      deleteError = problem instanceof Error ? problem.message : String(problem);
    }
  }

  function setTheme(next: Theme): void {
    theme = next;
    localStorage.setItem(THEME_KEY, next);
    if (next === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', next);
  }
</script>

<header>
  <h1>{snapshot?.campaign.name ?? 'DnD AI'}</h1>
  {#if snapshot}
    <span class="chip">{snapshot.campaign.story_shape}</span>
    <span class="chip"><Help k="session_rhythm" text="Session {snapshot.session.number}" /></span>
  {/if}

  <p class="scene">
    {#if scene}
      <span class="scene-title">{scene.title ?? 'Unnamed scene'}</span>
      {#if scene.location_name}<span class="muted"> — {scene.location_name}</span>{/if}
    {:else}
      <span class="empty">No scene yet</span>
    {/if}
  </p>

  {#if error}<span class="chip bad">{error}</span>{/if}

  <div class="right">
    <span class="conn">
      <span class="dot" class:live={status === 'live'}></span>
      {#if status !== 'live'}
        <span class="label">{status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>
      {/if}
    </span>
    <span class="themes" role="group" aria-label="Colour theme">
      {#each THEMES as option (option)}
        <button class="theme" aria-pressed={theme === option} onclick={() => setTheme(option)}>{option}</button>
      {/each}
    </span>
    {#if snapshot}
      <button aria-expanded={showSettings} onclick={() => (showSettings = !showSettings)}>Settings</button>
    {/if}
    <button onclick={onswitch}>Switch</button>
    <button onclick={onnew}>New story</button>
    {#if snapshot}
      <button class="danger" aria-expanded={confirming} onclick={askDelete}>Delete story…</button>
    {/if}
  </div>

  <div class="now-row">
    <Now now={snapshot?.now ?? null} />
  </div>

  {#if showSettings && snapshot}
    <Settings campaignId={snapshot.campaign.id} {settings} onchange={onsettings} />
  {/if}

  {#if confirming && snapshot}
    {@const campaign = snapshot.campaign}
    <form
      class="confirm"
      onsubmit={(event) => {
        event.preventDefault();
        if (typed.trim() === campaign.name) confirmDelete(campaign.id);
      }}
    >
      <span class="muted">Type <strong>{campaign.name}</strong> to delete this story.</span>
      <input type="text" bind:value={typed} aria-label="Campaign name" />
      <button type="submit" class="danger" disabled={typed.trim() !== campaign.name}>Delete</button>
      <button type="button" onclick={askDelete}>Cancel</button>
      {#if deleteError}<span class="chip bad">{deleteError}</span>{/if}
    </form>
  {/if}
</header>

<style>
  header {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 0.9rem;
    padding: 0.55rem 1.15rem;
    background: var(--ground);
    border-bottom: 1px solid var(--accent);
  }

  h1 {
    font-family: var(--font-display);
    font-size: var(--t-18);
    letter-spacing: 0.02em;
    color: var(--accent);
  }

  .scene {
    flex: 1;
    min-width: 12rem;
    margin: 0;
    font-size: var(--t-15);
  }

  .scene-title {
    font-weight: 500;
  }

  /* The in-world clock takes its own line under the campaign name and the scene. */
  .now-row {
    flex-basis: 100%;
  }

  .right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .conn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--ink-faint);
  }

  .dot.live {
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent);
  }

  .themes {
    display: inline-flex;
  }

  .theme {
    font-family: var(--font-mono);
    font-size: var(--t-12);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink-faint);
    padding: 0.1rem 0.4rem;
  }

  .theme + .theme {
    border-left: none;
  }

  .theme[aria-pressed='true'] {
    color: var(--accent);
    background: var(--accent-soft);
  }

  button {
    font-family: var(--font-mono);
    font-size: var(--t-12);
    letter-spacing: 0.06em;
  }

  .danger {
    color: var(--ink-faint);
  }

  .danger:hover {
    color: var(--bad);
    border-color: var(--bad);
  }

  .danger:disabled {
    color: var(--ink-faint);
    border-color: var(--rule);
    cursor: not-allowed;
  }

  .confirm {
    flex-basis: 100%;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--t-13);
  }

  .confirm input {
    font-family: var(--font-body);
    font-size: var(--t-13);
    color: var(--ink);
    background: var(--surface-raised);
    border: 1px solid var(--rule);
    padding: 0.15rem 0.4rem;
  }

  .confirm input:focus {
    border-color: var(--accent);
  }
</style>
