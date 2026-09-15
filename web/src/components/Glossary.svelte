<script lang="ts">
  import { tick } from 'svelte';
  import { clearGlossaryRequest, glossaryRequest } from '../lib/glossary.svelte';
  import { canFilterByChapter, inChapter } from '../lib/story';
  import type { GlossaryEntry } from '../lib/types';

  const OPEN_KEY = 'dndai.glossary.open';
  const TAB_KEY = 'dndai.glossary.tab';

  type Tab = GlossaryEntry['source'];
  const TAB_NAMES: Record<Tab, string> = { campaign: 'Campaign', srd: 'Rules' };

  let {
    entries,
    chapterId = null,
    onrequest = () => undefined,
  }: {
    entries: GlossaryEntry[];
    /** The open chapter, for the "this chapter" filter; null hides the toggle. */
    chapterId?: number | null;
    /** A tooltip or "/" asked for the glossary: the caller brings its tab forward. */
    onrequest?: () => void;
  } = $props();

  let thisChapter = $state(false);
  let query = $state('');
  let input: HTMLInputElement | undefined = $state();
  let open = $state(remembered());
  let chosen = $state<Tab | null>(rememberedTab());

  const campaignTerms = $derived(entries.filter((entry) => entry.source === 'campaign'));
  const ruleTerms = $derived(entries.filter((entry) => entry.source === 'srd'));
  /** The story's own terms lead, but only once there are any: the SRD list arrives full. */
  const tab = $derived(chosen ?? (campaignTerms.length > 0 ? 'campaign' : 'srd'));
  const other = $derived<Tab>(tab === 'campaign' ? 'srd' : 'campaign');
  const tabs = $derived<{ id: Tab; count: number }[]>([
    { id: 'campaign', count: campaignTerms.length },
    { id: 'srd', count: ruleTerms.length },
  ]);
  const matches = $derived(filter(tab === 'campaign' ? campaignTerms : ruleTerms));
  const otherMatches = $derived(filter(tab === 'campaign' ? ruleTerms : campaignTerms).length);

  const tagged = $derived(canFilterByChapter(entries, chapterId));

  function filter(list: GlossaryEntry[]): GlossaryEntry[] {
    return inChapter(list, chapterId, thisChapter).filter((entry) =>
      entry.term.toLowerCase().includes(query.trim().toLowerCase()),
    );
  }

  /** The SRD tags some entry names ("Attack [Action]"); the tag is meta, not part of the term. */
  const displayTerm = (term: string): string => term.replace(/ \[[^\]]+\]$/, '');

  function terms(count: number): string {
    return `${count} ${count === 1 ? 'term' : 'terms'}`;
  }

  /** Open unless the player last closed it (and on the server, where there is no storage). */
  function remembered(): boolean {
    return typeof localStorage === 'undefined' || localStorage.getItem(OPEN_KEY) !== 'false';
  }

  /** Null until the player picks a tab, so the default can follow the entries as they load. */
  function rememberedTab(): Tab | null {
    if (typeof localStorage === 'undefined') return null;
    const saved = localStorage.getItem(TAB_KEY);
    return saved === 'campaign' || saved === 'srd' ? saved : null;
  }

  function setTab(value: Tab): void {
    chosen = value;
    localStorage.setItem(TAB_KEY, value);
  }

  function setOpen(value: boolean): void {
    open = value;
    localStorage.setItem(OPEN_KEY, String(value));
  }

  /** A "More in glossary" link in a help tooltip: open the Rules tab on that term. */
  $effect(() => {
    const term = glossaryRequest.term;
    if (!term) return;
    clearGlossaryRequest();
    onrequest();
    if (!open) setOpen(true);
    setTab('srd');
    query = term;
    tick().then(() => input?.focus());
  });

  /** "/" focuses the search box — expanding the panel first — as long as the player is not already typing. */
  async function onkeydown(event: KeyboardEvent): Promise<void> {
    if (event.key !== '/' || event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    onrequest();
    if (!open) setOpen(true);
    await tick();
    input?.focus();
  }
</script>

<svelte:window {onkeydown} />

<section>
  <h2 class="section-title">
    <button type="button" class="toggle" aria-expanded={open} onclick={() => setOpen(!open)}>
      <span class="chevron" class:open aria-hidden="true"></span>
      Glossary
      <span class="label count">{entries.length} {entries.length === 1 ? 'term' : 'terms'}</span>
    </button>
  </h2>
  {#if open}
    <div class="tabs" role="group" aria-label="Glossary source">
      {#each tabs as option (option.id)}
        <button type="button" class="tab label" aria-pressed={tab === option.id} onclick={() => setTab(option.id)}>
          {TAB_NAMES[option.id]}
          <span class="tab-count">{terms(option.count)}</span>
        </button>
      {/each}
    </div>
    {#if tagged}
      <button type="button" class="label filter" aria-pressed={thisChapter} onclick={() => (thisChapter = !thisChapter)}>
        This chapter
      </button>
    {/if}
    <input type="search" placeholder="Search terms  /" bind:value={query} bind:this={input} aria-label="Search glossary" />
    {#if matches.length === 0}
      <p class="empty">No matching terms.</p>
      {#if otherMatches > 0}
        <button type="button" class="elsewhere label" onclick={() => setTab(other)}>
          {otherMatches} {otherMatches === 1 ? 'match' : 'matches'} in {TAB_NAMES[other]}
        </button>
      {/if}
    {:else}
      <ul>
        {#each matches as entry (`${entry.source}:${entry.term}`)}
          <li>
            <details>
              <summary>
                <span class="term">{displayTerm(entry.term)}</span>
              </summary>
              <p class="prose muted">{entry.definition}</p>
            </details>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .toggle {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    width: 100%;
    border: none;
    padding: 0;
    text-align: left;
  }

  /* Same CSS chevron as the collapsibles in the character sheet. */
  .chevron {
    flex: none;
    width: 0;
    height: 0;
    border-left: 5px solid var(--ink-faint);
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .count {
    margin-left: auto;
  }

  .tabs {
    display: flex;
    gap: 1rem;
    margin: 0.5rem 0 0.6rem;
  }

  .tab {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35rem;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 0.1rem 0 0.15rem;
  }

  .tab[aria-pressed='true'] {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .tab-count {
    color: var(--ink-faint);
  }

  .filter {
    display: block;
    margin-bottom: 0.35rem;
    border: none;
    padding: 0;
  }

  .filter[aria-pressed='true'] {
    color: var(--accent);
  }

  .elsewhere {
    border: none;
    padding: 0;
    color: var(--ink-muted);
  }

  ul {
    list-style: none;
    margin: 0.6rem 0 0;
    padding: 0;
    max-height: 50dvh;
    overflow-y: auto;
  }

  li {
    border-bottom: 1px solid var(--rule);
    padding: 0.15rem 0;
  }

  .term {
    font-size: var(--t-15);
  }

  p {
    margin: 0.25rem 0 0.4rem 0.95rem;
    font-size: var(--t-13);
  }

  @media (prefers-reduced-motion: no-preference) {
    .chevron {
      transition: transform 0.15s ease-out;
    }
  }
</style>
