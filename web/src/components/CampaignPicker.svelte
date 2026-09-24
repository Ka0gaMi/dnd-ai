<script lang="ts">
  import { deleteCampaign, restoreCampaign } from '../lib/api';
  import { helpFor } from '../lib/rulesHelp';
  import { dmTodoLine } from '../lib/wizard';
  import type { CampaignListItem } from '../lib/types';

  let {
    campaigns,
    onpick,
    onrefresh,
    onnew,
  }: {
    campaigns: CampaignListItem[];
    onpick: (id: number) => void;
    onrefresh: () => Promise<void>;
    onnew: () => void;
  } = $props();

  const SNIPPET = 160;

  /** What the story is about, as far as anyone knows yet. */
  function premiseLine(campaign: CampaignListItem): string | null {
    const premise = campaign.premise?.trim();
    if (!premise) return null;
    return premise.length > SNIPPET ? `${premise.slice(0, SNIPPET)}…` : premise;
  }

  let confirming = $state<number | null>(null);
  let error = $state<string | null>(null);
  let showDeleted = $state(false);

  const RHYTHM_KEY = 'dndai.picker.rhythm_dismissed';
  const rhythmText = helpFor('session_rhythm')?.text ?? '';

  /** Dismissed unless the player last hid it (and on the server, where there is no storage). */
  function rhythmDismissed(): boolean {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem(RHYTHM_KEY) === 'true';
    } catch {
      return false;
    }
  }

  let rhythmHidden = $state(rhythmDismissed());

  function setRhythmHidden(value: boolean): void {
    rhythmHidden = value;
    try {
      localStorage.setItem(RHYTHM_KEY, String(value));
    } catch {
      /* private mode or storage disabled: the choice just won't persist */
    }
  }

  const live = $derived(campaigns.filter((campaign) => !campaign.deleted_at));
  const deleted = $derived(campaigns.filter((campaign) => campaign.deleted_at));

  function ask(id: number): void {
    confirming = confirming === id ? null : id;
    error = null;
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    error = null;
    try {
      await action();
      confirming = null;
      await onrefresh();
    } catch (problem) {
      error = problem instanceof Error ? problem.message : String(problem);
    }
  }
</script>

<main>
  <h1>DnD AI</h1>
  <div class="head">
    <h2 class="section-title">Choose a campaign</h2>
    <button class="new" onclick={onnew}>New story</button>
  </div>
  {#if live.length === 0}
    <p class="empty prose">No campaigns yet. Start one with "New story", or ask the DM in chat.</p>
    <p class="watching">Watching for new stories…</p>
  {:else}
    <ul>
      {#each live as campaign (campaign.id)}
        <li>
          <div class="card">
            <button class="open" onclick={() => onpick(campaign.id)}>
              <span class="name">{campaign.name}</span>
              <span class="meta">
                <span class="chip">{campaign.story_shape}</span>
                {#if campaign.setting_name}<span class="chip">{campaign.setting_name}</span>{/if}
                {#if campaign.pc}
                  <span class="num pc">{campaign.pc.name} · level {campaign.pc.level} {campaign.pc.class ?? ''}</span>
                {:else}
                  <span class="empty">no character yet</span>
                {/if}
              </span>
              {#if premiseLine(campaign)}
                <span class="prose muted premise">{premiseLine(campaign)}</span>
              {/if}
              {#if dmTodoLine(campaign)}
                <span class="prose empty premise">{dmTodoLine(campaign)}</span>
              {/if}
              {#if campaign.last_recap_snippet}
                <span class="prose muted recap">{campaign.last_recap_snippet}</span>
              {/if}
            </button>
            <button class="label danger" aria-expanded={confirming === campaign.id} onclick={() => ask(campaign.id)}>
              Delete
            </button>
          </div>
          {#if confirming === campaign.id}
            <div class="confirm">
              <p class="prose muted">Delete forever? This cannot be undone.</p>
              <button type="button" class="label danger" onclick={() => run(() => deleteCampaign(campaign.id))}>
                Delete
              </button>
              <button type="button" class="label" onclick={() => ask(campaign.id)}>Cancel</button>
              {#if error}<span class="chip bad">{error}</span>{/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <p class="rhythm">
    <span class="label">Play rhythm</span>
    <button
      type="button"
      class="label rhythm-toggle"
      onclick={() => setRhythmHidden(!rhythmHidden)}
      aria-label={rhythmHidden ? 'Show the play rhythm reminder' : 'Dismiss the play rhythm reminder'}
    >
      {rhythmHidden ? '?' : '×'}
    </button>
    {#if !rhythmHidden}<span class="prose muted rhythm-text">{rhythmText}</span>{/if}
  </p>

  {#if deleted.length > 0}
    <div class="deleted">
      <button class="label" onclick={() => (showDeleted = !showDeleted)}>
        {showDeleted ? 'Hide deleted' : `Show deleted (${deleted.length})`}
      </button>
      {#if showDeleted}
        <ul>
          {#each deleted as campaign (campaign.id)}
            <li class="gone">
              <span class="muted">{campaign.name}</span>
              <button class="label" onclick={() => run(() => restoreCampaign(campaign.id))}>Restore</button>
            </li>
          {/each}
        </ul>
        {#if error && confirming === null}<p class="chip bad">{error}</p>{/if}
      {/if}
    </div>
  {/if}
</main>

<style>
  main {
    max-width: 46rem;
    padding: 3.5rem 2rem 2rem clamp(1.5rem, 6vw, 5rem);
  }

  h1 {
    font-family: var(--font-display);
    font-size: var(--t-36);
    color: var(--accent);
    margin-bottom: 1.6rem;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    border-bottom: 1px solid var(--rule);
  }

  .card {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .open {
    display: grid;
    gap: 0.2rem;
    flex: 1;
    min-width: 0;
    text-align: left;
    border: none;
    padding: 0.8rem 0.2rem;
  }

  .open:hover {
    color: inherit;
    background: var(--accent-soft);
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
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.2rem 0.8rem;
  }

  .confirm p {
    flex-basis: 100%;
    margin: 0;
    font-size: var(--t-13);
  }

  .deleted {
    margin-top: 1.5rem;
  }

  .deleted > button {
    border: none;
    padding: 0.2rem 0;
    color: var(--ink-muted);
  }

  .gone {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.4rem 0.2rem;
  }

  .name {
    font-family: var(--font-display);
    font-size: var(--t-18);
    color: var(--accent);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .pc {
    font-size: var(--t-13);
    color: var(--ink-muted);
  }

  .recap {
    font-size: var(--t-13);
  }

  .premise {
    font-size: var(--t-13);
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }

  .head .section-title {
    flex: 1;
  }

  .new {
    color: var(--accent);
    border-color: var(--accent);
  }

  .watching {
    font-size: var(--t-13);
    color: var(--ink-faint);
  }

  .rhythm {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    margin-top: 1.5rem;
  }

  .rhythm-toggle {
    border: none;
    padding: 0;
  }

  .rhythm-text {
    font-size: var(--t-13);
    flex-basis: 100%;
  }
</style>
