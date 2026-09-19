<script module lang="ts">
  import type { Scene } from '../lib/types';

  /** The clamp the scene text carries until the player asks for more. */
  export const SCENE_CLAMP = 4;

  export interface SceneText {
    title: string | null;
    location: string | null;
    /** The one text shown: the scene summary when it has one, else the recap. */
    text: string | null;
    /** The recap when it differs from the summary, shown beneath it once expanded. */
    more: string | null;
  }

  /** One text only: the summary wins over the recap, and an identical recap is never shown again. */
  export function sceneText(scene: Scene | null, recap: string | null): SceneText {
    const summary = scene?.summary?.trim() || null;
    const text = summary ?? (recap?.trim() || null);
    const more = summary && recap && recap.trim() !== summary ? recap : null;
    return {
      title: scene?.title ?? null,
      location: scene?.location_name ?? null,
      text,
      more,
    };
  }
</script>

<script lang="ts">
  let {
    scene = null,
    recap = null,
    expanded = $bindable(false),
  }: {
    scene: Scene | null;
    recap: string | null;
    /** Bindable so tests can render the expanded state; "more" flips it. */
    expanded?: boolean;
  } = $props();

  const shown = $derived(sceneText(scene, recap));
</script>

<div class="last-scene">
  {#if shown.title || shown.location}
    <p class="prose">
      <span class="scene">{shown.title ?? 'Unnamed scene'}</span>
      {#if shown.location}<span class="muted"> — {shown.location}</span>{/if}
    </p>
  {/if}
  {#if shown.text}
    <p class="prose scene-text" class:clamp={!expanded}>{shown.text}</p>
    {#if expanded && shown.more}
      <p class="label">Recap</p>
      <p class="prose scene-text muted">{shown.more}</p>
    {/if}
    <button type="button" class="label more" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
      {expanded ? 'less' : 'more'}
    </button>
  {:else}
    <p class="empty">Scene in progress.</p>
  {/if}
</div>

<style>
  .scene {
    font-weight: 500;
  }

  .scene-text.clamp {
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .more {
    border: none;
    padding: 0.1rem 0;
  }
</style>
