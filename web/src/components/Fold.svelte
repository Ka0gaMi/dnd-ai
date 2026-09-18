<script module lang="ts">
  /** What the window remembers about one fold: open, and the count it last saw. */
  export interface FoldRecord {
    open: boolean;
    seen: number;
  }

  export type FoldStore = Pick<Storage, 'getItem' | 'setItem'>;

  export function foldKey(campaignId: number, block: string): string {
    return `story-fold:${campaignId}:${block}`;
  }

  /** Nothing stored yet: Canon facts and Recent events start closed, the Journal only once written in. */
  export function foldDefaults(block: string, count: number): FoldRecord {
    return { open: block === 'journal' && count > 0, seen: count };
  }

  export function readFold(store: FoldStore | null, key: string | null): FoldRecord | null {
    if (!store || !key) return null;
    try {
      const raw = store.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<FoldRecord>;
      if (typeof parsed.open !== 'boolean' || typeof parsed.seen !== 'number') return null;
      return { open: parsed.open, seen: parsed.seen };
    } catch {
      return null;
    }
  }

  export function writeFold(store: FoldStore | null, key: string | null, record: FoldRecord): void {
    if (!store || !key) return;
    try {
      store.setItem(key, JSON.stringify(record));
    } catch {
      // Storage can be blocked or full; the fold still toggles for this page.
    }
  }

  /** A closed fold that grew since the window last looked shows its dot. */
  export function hasNewItems(record: FoldRecord, count: number): boolean {
    return !record.open && count > record.seen;
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    label,
    count,
    campaignId = null,
    block = null,
    filter,
    store = (typeof localStorage === 'undefined' ? null : localStorage) as FoldStore | null,
    children,
  }: {
    label: string;
    count: number;
    campaignId: number | null;
    block: string | null;
    /** Rendered at the right edge of the header row, e.g. the canon "This chapter" filter. */
    filter?: Snippet;
    /** Overridable so tests can hand in their own storage. */
    store?: FoldStore | null;
    children: Snippet;
  } = $props();

  // svelte-ignore state_referenced_locally
  const initialKey = campaignId !== null && block ? foldKey(campaignId, block) : null;
  // svelte-ignore state_referenced_locally
  let state = $state(readFold(store, initialKey) ?? foldDefaults(block ?? '', count));

  const key = $derived(campaignId !== null && block ? foldKey(campaignId, block) : null);
  const dot = $derived(hasNewItems(state, count));

  // A campaign switch reads its own stored state; the first key is already applied above.
  $effect(() => {
    if (key === initialKey) return;
    state = readFold(store, key) ?? foldDefaults(block ?? '', count);
  });

  function toggle(): void {
    state = { open: !state.open, seen: count };
    writeFold(store, key, state);
  }
</script>

<div class="fold">
  <div class="fold-head">
    <button type="button" class="label fold-toggle" aria-expanded={state.open} onclick={toggle}>
      <span class="chevron" aria-hidden="true">{state.open ? '▾' : '▸'}</span>
      {label}
      <span class="fold-count">({count})</span>
      {#if dot}<span class="fold-dot" aria-hidden="true"></span>{/if}
    </button>
    {#if filter}{@render filter()}{/if}
  </div>
  {#if state.open}
    <div class="fold-body">{@render children()}</div>
  {/if}
</div>

<style>
  .fold-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.6rem;
    margin: 0.8rem 0 0.2rem;
  }

  .fold-toggle {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3rem;
    border: none;
    padding: 0.1rem 0;
  }

  .chevron {
    width: 0.8rem;
    color: var(--ink-muted);
  }

  .fold-dot {
    width: 0.4rem;
    height: 0.4rem;
    border-radius: 50%;
    background: var(--accent);
  }
</style>
