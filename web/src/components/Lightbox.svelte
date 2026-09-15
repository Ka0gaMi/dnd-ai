<script lang="ts">
  import { close, lightbox } from '../lib/lightbox.svelte';

  let dialogEl = $state<HTMLDialogElement | undefined>();

  /** Native <dialog> owns open/close and focus return; this just mirrors the store's intent. */
  $effect(() => {
    if (!dialogEl) return;
    if (lightbox.src !== null && !dialogEl.open) dialogEl.showModal();
    else if (lightbox.src === null && dialogEl.open) dialogEl.close();
  });

  /** A click that lands on the dialog element itself (not its content) is a click on the backdrop. */
  function onBackdropClick(event: MouseEvent): void {
    if (event.target === dialogEl) dialogEl?.close();
  }
</script>

<dialog bind:this={dialogEl} class="lightbox" aria-label={lightbox.caption ?? 'Portrait'} onclose={close} onclick={onBackdropClick}>
  {#if lightbox.src}
    <img src={lightbox.src} alt="" />
    {#if lightbox.caption}<p class="caption">{lightbox.caption}</p>{/if}
    <button type="button" onclick={() => dialogEl?.close()}>Close</button>
  {/if}
</dialog>

<style>
  /* display lives on [open] alone: the UA's dialog:not([open]) { display: none } must win while closed. */
  .lightbox {
    max-width: 90vw;
    max-height: 90vh;
    padding: 1rem;
    background: var(--surface);
    border: 1px solid var(--rule);
  }

  .lightbox[open] {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
  }

  .lightbox::backdrop {
    background: var(--ground);
    opacity: 0.85;
  }

  .lightbox img {
    flex: 1;
    min-height: 0;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  .caption {
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--t-18);
    text-align: center;
  }

  @media (prefers-reduced-motion: no-preference) {
    .lightbox {
      opacity: 1;
      transition: opacity 150ms ease-out;
    }

    @starting-style {
      .lightbox[open] {
        opacity: 0;
      }
    }
  }
</style>
