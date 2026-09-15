<script module lang="ts">
  /** The panel opens on the newest few closed chapters; the rest stay one click away, not deleted. */
  export const RECENT_CHAPTERS = 3;

  /** The timeline arrives newest first: the default keeps the latest few, "show all" keeps everything. */
  export function recentChapterSlice<T>(newestFirst: T[], showAll: boolean, limit = RECENT_CHAPTERS): T[] {
    return showAll ? newestFirst : newestFirst.slice(0, limit);
  }

  /** What the earlier-chapters control reads, or null when the cap already shows the whole timeline. */
  export function earlierChapterLabel(total: number, showAll: boolean, limit = RECENT_CHAPTERS): string | null {
    const earlier = total - limit;
    if (earlier <= 0) return null;
    return showAll ? 'Show fewer chapters' : `Show ${earlier} earlier chapters`;
  }
</script>

<script lang="ts">
  import Heard from './Heard.svelte';
  import Help from './Help.svelte';
  import Journal from './Journal.svelte';
  import Threads from './Threads.svelte';
  import { getPresets, rewindCampaign } from '../lib/api';
  import { EMPTY_PRESETS, dialWords, findPreset, type PresetFile } from '../lib/presets';
  import { canFilterByChapter, groupFacts, inChapter } from '../lib/story';
  import { dmTodoLine } from '../lib/wizard';
  import type { Snapshot } from '../lib/types';

  let {
    snapshot,
    showSecrets = false,
    onrewound = () => undefined,
  }: {
    snapshot: Snapshot | null;
    /** The spoiler setting: without it the DM's hidden threads and clues never render. */
    showSecrets?: boolean;
    /** The story moved back: the caller asks for a fresh snapshot. */
    onrewound?: () => void;
  } = $props();

  const CONFIRM_WORD = 'REWIND';

  let confirming = $state(false);
  let typed = $state('');
  let toast = $state<string | null>(null);
  let problem = $state<string | null>(null);

  function askRewind(): void {
    confirming = !confirming;
    typed = '';
    problem = null;
  }

  async function rewind(campaignId: number): Promise<void> {
    try {
      const done = await rewindCampaign(campaignId);
      confirming = false;
      problem = null;
      toast = `Back to the last checkpoint: ${done.reverted_events} events undone, ${done.cancelled_rolls} rolls cancelled.`;
      onrewound();
    } catch (failure) {
      problem = failure instanceof Error ? failure.message : String(failure);
    }
  }

  let presets = $state<PresetFile>(EMPTY_PRESETS);
  let showTone = $state(false);

  $effect(() => {
    getPresets()
      .then((file) => (presets = file))
      .catch(() => undefined);
  });

  const preset = $derived(findPreset(presets, snapshot?.campaign.setting_preset ?? null));
  const settingName = $derived(snapshot?.campaign.setting_name ?? preset?.name ?? null);
  const dials = $derived(dialWords(presets.tone_dials, snapshot?.campaign.tone_dials));

  const events = $derived([...(snapshot?.recent_events ?? [])].reverse());
  const arc = $derived(snapshot?.story ?? null);
  const chapterId = $derived(arc?.chapter?.id ?? null);
  /** Closed chapters read newest first; the snapshot sends them oldest first. */
  const timeline = $derived([...(arc?.recaps ?? [])].reverse());
  let allChapters = $state(false);
  const chapters = $derived(recentChapterSlice(timeline, allChapters));
  /** Counted from the cap, not the current slice: expanding must leave a way back. */
  const earlierLabel = $derived(earlierChapterLabel(timeline.length, allChapters));
  const allFacts = $derived(snapshot?.canon_facts ?? []);
  const factsTagged = $derived(canFilterByChapter(allFacts, chapterId));
  const time = (ts: string): string => ts.slice(11, 16);

  let showTimeline = $state(false);
  let thisChapter = $state(false);

  const facts = $derived(groupFacts(inChapter(allFacts, chapterId, thisChapter)));

  /** "DM will: name the story, write the premise" - the wizard may leave every field empty. */
  const dmWorkLine = $derived(
    snapshot
      ? dmTodoLine({
          needs_ai_fill: snapshot.campaign.needs_ai_fill,
          needs_fill: snapshot.campaign.needs_fill,
          character_draft: snapshot.character_draft ?? null,
          pc: snapshot.pc ?? null,
        })
      : null,
  );

  let shown = $state(new Set<string>());

  function toggle(subject: string): void {
    const next = new Set(shown);
    if (!next.delete(subject)) next.add(subject);
    shown = next;
  }
</script>

<section>
  <h2 class="section-title">Story</h2>
  {#if snapshot}
    {@const campaignId = snapshot.campaign.id}
    {#if settingName}
      <p class="setting prose">
        <span class="setting-name">{settingName}</span>{#if preset}<span class="muted"> — {preset.pitch}</span>{/if}
      </p>
    {/if}
    {#if dmWorkLine}
      <p class="banner muted">{dmWorkLine} on first play.</p>
    {/if}
    {#if arc && (arc.act || arc.chapter)}
      <div class="arc">
        {#if arc.act}
          <p class="prose">
            <Help k="story.act" text="Act {arc.act.number}" label />
            <span class="arc-title">{arc.act.title}</span>
            {#if arc.act.goal}<span class="muted"> — {arc.act.goal}</span>{/if}
          </p>
        {/if}
        {#if arc.chapter}
          <p class="prose">
            <Help k="story.chapter" text="Chapter {arc.chapter.number}" label />
            <span class="arc-title">{arc.chapter.title}</span>
            {#if arc.chapter.goal}<span class="muted"> — {arc.chapter.goal}</span>{/if}
          </p>
        {/if}
        <div class="progress">
          <span class="pips" aria-hidden="true">
            {#each timeline as recap (recap.number)}
              <span class="pip closed"></span>
            {/each}
            {#if arc.chapter}<span class="pip"></span>{/if}
          </span>
          <span class="label">
            {timeline.length}
            {timeline.length === 1 ? 'chapter' : 'chapters'} closed{#if arc.act}
              · act {arc.act.number}{/if}
          </span>
        </div>
        {#if timeline.length > 0}
          <button type="button" class="label timeline-toggle" aria-expanded={showTimeline} onclick={() => (showTimeline = !showTimeline)}>
            {showTimeline ? 'Hide chapters' : `Chapters so far (${timeline.length})`}
          </button>
          {#if showTimeline}
            <ol class="timeline">
              {#each chapters as recap (recap.number)}
                <li>
                  <span class="label num">Ch. {recap.number}</span>
                  <span class="arc-title">{recap.title}</span>
                  <p class="prose muted">{recap.summary ?? '—'}</p>
                </li>
              {/each}
            </ol>
            {#if earlierLabel}
              <button
                type="button"
                class="label timeline-toggle"
                aria-expanded={allChapters}
                onclick={() => (allChapters = !allChapters)}
              >
                {earlierLabel}
              </button>
            {/if}
          {/if}
        {/if}
      </div>
    {/if}
    {#if dials.length > 0}
      <div class="tone">
        <button type="button" class="label" aria-expanded={showTone} onclick={() => (showTone = !showTone)}>
          {showTone ? 'Hide tone' : `Tone (${dials.length})`}
        </button>
        {#if showTone}
          <span class="chips">
            {#each dials as dial (dial.id)}
              <span class="chip">{dial.name}: {dial.word}</span>
            {/each}
          </span>
        {/if}
      </div>
    {/if}
    <div class="rewind">
      <button type="button" class="label" aria-expanded={confirming} onclick={askRewind}>
        Rewind to last checkpoint…
      </button>
      {#if confirming}
        <form
          onsubmit={(event) => {
            event.preventDefault();
            if (typed.trim() === CONFIRM_WORD) rewind(campaignId);
          }}
        >
          <span class="muted">Type <strong>{CONFIRM_WORD}</strong> to undo everything since the checkpoint.</span>
          <input type="text" aria-label="Type REWIND to confirm" bind:value={typed} />
          <button type="submit" disabled={typed.trim() !== CONFIRM_WORD}>Rewind</button>
          <button type="button" onclick={askRewind}>Cancel</button>
        </form>
      {/if}
      {#if problem}<span class="chip bad">{problem}</span>{/if}
      {#if toast}<p class="muted toast">{toast}</p>{/if}
    </div>

    <h3 class="label">Recap</h3>
    <p class="prose" class:empty={!snapshot.last_recap}>{snapshot.last_recap ?? 'No checkpoint yet — the DM saves one at the end of each scene.'}</p>

    <h3 class="label">Previous scene</h3>
    {#if snapshot.previous_scene}
      <p class="prose">
        <span class="scene">{snapshot.previous_scene.title ?? 'Unnamed scene'}</span>
        {#if snapshot.previous_scene.location_name}
          <span class="muted"> — {snapshot.previous_scene.location_name}</span>
        {/if}
      </p>
      <p class="prose muted">{snapshot.previous_scene.summary ?? '—'}</p>
    {:else}
      <p class="empty">Scene in progress.</p>
    {/if}

    <div class="head">
      <h3 class="label">Canon facts</h3>
      {#if factsTagged}
        <button type="button" class="label filter" aria-pressed={thisChapter} onclick={() => (thisChapter = !thisChapter)}>
          This chapter
        </button>
      {/if}
    </div>
    {#if facts.length === 0}
      <p class="empty">{thisChapter ? 'Nothing written to canon this chapter.' : 'Nothing written to canon yet.'}</p>
    {:else}
      <ul class="facts">
        {#each facts as group (group.latest.id)}
          <li class="prose">
            <span class="label subject">{group.subject}</span>
            {group.latest.fact}
            {#if group.earlier.length > 0}
              <button
                type="button"
                class="label earlier"
                aria-expanded={shown.has(group.subject)}
                onclick={() => toggle(group.subject)}
              >
                {shown.has(group.subject) ? 'Hide earlier' : `+${group.earlier.length} earlier`}
              </button>
              {#if shown.has(group.subject)}
                <ul class="older">
                  {#each group.earlier as fact (fact.id)}
                    <li>{fact.fact}</li>
                  {/each}
                </ul>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <!-- Threads, rumours and the journal all arrive with the story package: an older server has none. -->
    {#if arc}
      <Threads threads={arc.threads} clues={arc.clues} {showSecrets} />

      <Heard {campaignId} rumours={snapshot.rumours ?? []} />

      <Journal {campaignId} entries={snapshot.journal ?? []} chapter={arc.chapter} recaps={arc.recaps} />
    {/if}

    <h3 class="label">Recent events</h3>
    <ul class="events">
      {#each events as event (event.id)}
        <li><span class="num time">{time(event.ts)}</span><span class="prose">{event.text}</span></li>
      {/each}
    </ul>
  {:else}
    <p class="empty">Waiting for the campaign snapshot…</p>
  {/if}
</section>

<style>
  .arc {
    display: grid;
    gap: 0.2rem;
    justify-items: start;
    margin-bottom: 0.5rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--rule);
  }

  .arc p {
    margin: 0;
    font-size: var(--t-15);
  }

  .arc-title {
    font-family: var(--font-display);
    color: var(--accent);
  }

  .progress {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  /* One pip per closed chapter, the open one hollow: the whole arc at a glance. */
  .pips {
    display: inline-flex;
    gap: 0.2rem;
  }

  .pip {
    width: 0.4rem;
    height: 0.4rem;
    border: 1px solid var(--accent);
  }

  .pip.closed {
    background: var(--accent);
  }

  .timeline-toggle {
    border: none;
    padding: 0.1rem 0;
  }

  .timeline {
    list-style: none;
    margin: 0.1rem 0 0.2rem;
    padding: 0;
  }

  .timeline li {
    padding: 0.15rem 0;
    border-bottom: 1px solid var(--rule);
    font-size: var(--t-13);
  }

  .timeline p {
    margin: 0.1rem 0 0;
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
  }

  .filter {
    border: none;
    padding: 0.1rem 0;
  }

  .filter[aria-pressed='true'] {
    color: var(--accent);
  }

  h3 {
    margin: 0.8rem 0 0.2rem;
  }

  h3:first-of-type {
    margin-top: 0;
  }

  p {
    margin: 0.15rem 0;
    white-space: pre-wrap;
  }

  .scene {
    font-weight: 500;
  }

  .setting {
    margin: 0 0 0.2rem;
    font-size: var(--t-13);
  }

  .setting-name {
    font-family: var(--font-display);
    color: var(--accent);
  }

  .banner {
    max-width: 65ch;
    margin: 0 0 0.3rem;
    padding: 0.25rem 0.45rem;
    font-size: var(--t-13);
    background: var(--surface-raised);
    border-left: 3px solid var(--rule);
  }

  .tone {
    display: grid;
    gap: 0.25rem;
    justify-items: start;
    margin-bottom: 0.4rem;
  }

  .tone button {
    border: none;
    padding: 0.1rem 0;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .chips .chip {
    white-space: normal;
  }

  .rewind {
    display: grid;
    gap: 0.3rem;
    justify-items: start;
    margin-bottom: 0.5rem;
  }

  .rewind button {
    text-transform: none;
    letter-spacing: 0.04em;
  }

  .rewind form {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--t-13);
  }

  .rewind input {
    font-family: var(--font-mono);
    font-size: var(--t-13);
    color: var(--ink);
    background: var(--surface-raised);
    border: 1px solid var(--rule);
    padding: 0.1rem 0.35rem;
  }

  .toast {
    font-size: var(--t-13);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .facts li {
    padding: 0.15rem 0;
    border-bottom: 1px solid var(--rule);
    font-size: var(--t-15);
  }

  .subject {
    display: block;
    color: var(--ink-muted);
  }

  .earlier {
    display: block;
    border: none;
    padding: 0.1rem 0;
    color: var(--ink-muted);
  }

  .older {
    margin: 0.1rem 0 0.2rem;
  }

  .older li {
    color: var(--ink-muted);
  }

  .events li {
    display: grid;
    grid-template-columns: 3rem 1fr;
    gap: 0.5rem;
    padding: 0.12rem 0;
    font-size: var(--t-13);
    color: var(--ink-muted);
  }

  .time {
    font-size: var(--t-12);
    color: var(--ink-faint);
  }
</style>
