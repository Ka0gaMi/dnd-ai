<script lang="ts">
  import { open } from '../lib/lightbox.svelte';

  let {
    path = null,
    monogram = '',
    size = 24,
    round = false,
    alt = '',
    name = '',
  }: {
    path?: string | null;
    monogram?: string;
    size?: number;
    round?: boolean;
    alt?: string;
    /** Character or creature name: the lightbox caption and the button's accessible name. */
    name?: string;
  } = $props();
</script>

{#if path}
  <button type="button" class="portrait-button" aria-label="Open portrait of {name}" onclick={() => open(path, name)}>
    <img class="portrait" class:round src={path} {alt} style="--size: {size}px" />
  </button>
{:else}
  <span class="portrait monogram num" class:round style="--size: {size}px" aria-hidden="true">{monogram}</span>
{/if}

<style>
  .portrait-button {
    all: unset;
    display: inline-flex;
    cursor: pointer;
  }

  .portrait-button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .portrait {
    flex: none;
    width: var(--size);
    height: var(--size);
    border: 1px solid var(--rule);
    object-fit: cover;
  }

  .portrait.round {
    border-radius: 50%;
  }

  .monogram {
    display: grid;
    place-items: center;
    font-size: calc(var(--size) * 0.5);
    color: var(--ink-muted);
  }
</style>
