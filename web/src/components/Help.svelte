<script lang="ts">
  import { askGlossary } from '../lib/glossary.svelte';
  import { helpFor, type Help } from '../lib/rulesHelp';
  import { tooltipPosition } from '../lib/tooltip';

  let {
    k = '',
    help = null,
    text = '',
    label = false,
    lead = null,
    head = '',
  }: {
    /** The rulesHelp key; ignored when `help` is passed ready-made. */
    k?: string;
    help?: Help | null;
    /** The words on screen; the tooltip hangs off them. */
    text?: string;
    /** Wears the small-caps label style, as most of these labels do. */
    label?: boolean;
    /** A line above the title - the DM's reason for recommending this option. */
    lead?: string | null;
    /** A line of stats under the title: "Level 1 · Evocation · 1 action · 120 ft · Instantaneous". */
    head?: string;
  } = $props();

  const id = $props.id();
  const entry = $derived(help ?? helpFor(k));

  let wrap = $state<HTMLElement | null>(null);
  let trigger = $state<HTMLButtonElement | null>(null);
  let tip = $state<HTMLElement | null>(null);
  let open = $state(false);
  let placed = $state(false);
  let at = $state({ left: 0, top: 0 });

  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function show(): void {
    clearTimeout(hideTimer);
    open = true;
  }

  function hide(): void {
    clearTimeout(hideTimer);
    open = false;
    placed = false;
  }

  /** A moment's grace so the pointer can cross the gap into the tip and press "More in glossary". */
  function hideSoon(): void {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 150);
  }

  /** The tip is fixed to the viewport, so a scrolling column neither clips nor drags it. */
  $effect(() => {
    if (!open || !trigger || !tip) return;
    at = tooltipPosition(
      trigger.getBoundingClientRect(),
      { width: tip.offsetWidth, height: tip.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    placed = true;
  });

  /** Any scroll moves the words the tip points at; the tip goes rather than float somewhere wrong. */
  $effect(() => {
    if (!open) return;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  });
</script>

{#if entry}
  <span
    class="wrap"
    class:label
    bind:this={wrap}
    onfocusin={show}
    onfocusout={(event) => {
      if (!wrap?.contains(event.relatedTarget as Node | null)) hide();
    }}
  >
    <button
      type="button"
      class="help"
      aria-describedby={id}
      bind:this={trigger}
      onpointerenter={show}
      onpointerleave={hideSoon}
    >
      {text}
    </button>
    {#if open}
      <span
        class="tip"
        class:placed
        {id}
        role="tooltip"
        bind:this={tip}
        onpointerenter={show}
        onpointerleave={hideSoon}
        style="left: {at.left}px; top: {at.top}px"
      >
        {#if lead}<span class="lead">{lead}</span>{/if}
        <span class="tip-title">{entry.title}</span>
        {#if head}<span class="head">{head}</span>{/if}
        {#if entry.text}<span class="muted">{entry.text}</span>{/if}
        {#if entry.glossaryTerm}
          <button
            type="button"
            class="more label"
            onclick={() => {
              askGlossary(entry.glossaryTerm ?? '');
              hide();
            }}
          >
            More in glossary
          </button>
        {/if}
      </span>
    {/if}
  </span>
{:else}
  <span class:label>{text}</span>
{/if}

<style>
  .wrap {
    position: relative;
  }

  .help {
    font: inherit;
    color: inherit;
    text-align: inherit;
    background: none;
    border: none;
    border-bottom: 1px dotted var(--ink-faint);
    padding: 0;
    cursor: help;
  }

  .help:hover {
    color: inherit;
    border-color: var(--accent);
  }

  .tip {
    display: grid;
    position: fixed;
    z-index: 20;
    /* Hidden for the frame between rendering and being measured, so it never flashes at 0,0. */
    visibility: hidden;
    width: max-content;
    max-width: 17rem;
    gap: 0.15rem;
    padding: 0.35rem 0.45rem;
    font-family: var(--font-body);
    font-size: var(--t-12);
    font-weight: 400;
    text-transform: none;
    text-decoration: none;
    letter-spacing: 0;
    line-height: 1.45;
    white-space: normal;
    color: var(--ink);
    background: var(--surface-raised);
    border: 1px solid var(--rule);
    border-left: 3px solid var(--accent);
  }

  .tip.placed {
    visibility: visible;
  }

  .tip-title {
    font-family: var(--font-mono);
    font-size: var(--t-12);
    color: var(--accent);
  }

  .lead {
    color: var(--accent);
    font-style: italic;
  }

  .head {
    font-family: var(--font-mono);
    font-size: var(--t-12);
    color: var(--ink-muted);
  }

  .more {
    justify-self: start;
    border: none;
    padding: 0.1rem 0;
    color: var(--ink-muted);
    text-transform: none;
    letter-spacing: 0.04em;
    text-decoration: underline;
  }
</style>
