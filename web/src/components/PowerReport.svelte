<script lang="ts">
  import Help from './Help.svelte';
  import { budgetShare, powerChip, type PowerReport } from '../lib/progression';

  let {
    report,
    open = false,
  }: {
    report: PowerReport;
    /** The dialog shows the whole sum; a suggestion keeps it behind its own "Why". */
    open?: boolean;
  } = $props();

  const chip = $derived(powerChip(report.verdict));
  const share = $derived(budgetShare(report));
  const over = $derived(report.verdict === 'over_budget');
</script>

<div class="report">
  <div class="head">
    <Help k="power_budget" text="Power budget" label />
    <span class="num used">{report.budget_used} of {report.budget_allowed}</span>
    <span class="chip {chip.tone}">{chip.label}</span>
  </div>
  <div class="track" role="presentation">
    <span class="fill" class:over style="width: {share}%"></span>
  </div>
  {#if over}
    <p class="over-text">
      This is stronger than a feat, so it will outshine the rules the rest of the game runs on.
    </p>
  {/if}
  <details {open}>
    <summary class="label">Why</summary>
    <ul>
      {#each report.items as item, index (index)}
        <li>
          <span class="part">{item.part}</span>
          <span class="num cost">{item.cost}</span>
          <span class="muted rule">{item.rule}</span>
        </li>
      {/each}
      {#if report.items.length === 0}
        <li class="empty">Nothing with numbers behind it.</li>
      {/if}
    </ul>
  </details>
</div>

<style>
  .report {
    display: grid;
    gap: 0.3rem;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem;
  }

  .used {
    font-size: var(--t-13);
  }

  .track {
    height: 0.4rem;
    background: var(--surface);
    border: 1px solid var(--rule);
  }

  .fill {
    display: block;
    height: 100%;
    background: var(--good);
  }

  .fill.over {
    background: var(--warn);
  }

  .over-text {
    margin: 0;
    font-size: var(--t-13);
    color: var(--warn);
  }

  ul {
    list-style: none;
    margin: 0.2rem 0 0;
    padding: 0;
  }

  li {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0 0.5rem;
    padding: 0.15rem 0;
    border-bottom: 1px solid var(--rule);
    font-size: var(--t-13);
  }

  .cost {
    color: var(--ink-muted);
  }

  .rule {
    grid-column: 1 / -1;
    font-size: var(--t-12);
  }
</style>
