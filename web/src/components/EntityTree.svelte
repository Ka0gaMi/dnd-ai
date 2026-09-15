<script lang="ts">
  import { layoutTree } from '../lib/codex';
  import type { TreeNode } from '../lib/types';

  let {
    tree,
    onpick,
  }: {
    tree: TreeNode;
    onpick: (id: number) => void;
  } = $props();

  const layout = $derived(layoutTree(tree));
</script>

<div class="tree">
  <p class="root"><span class="name">{layout.root.name}</span><span class="label kind">{layout.root.kind}</span></p>
  {#if layout.groups.length === 0}
    <p class="empty">No family or faction ties recorded.</p>
  {:else}
    {#each layout.groups as group (group.band + group.label)}
      <div class="band" class:boxed={group.band === 'factions'}>
        <span class="label">{group.label}</span>
        <ul>
          {#each group.entries as entry (entry.id)}
            <li style="--depth: {entry.depth}">
              <button type="button" class="name" onclick={() => onpick(entry.id)}>{entry.name}</button>
              <span class="label role">{entry.role}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  {/if}
</div>

<style>
  .tree {
    display: grid;
    gap: 0.35rem;
  }

  .root {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }

  .root .name {
    font-family: var(--font-display);
    color: var(--accent);
  }

  .kind {
    color: var(--ink-faint);
  }

  /* Factions stand apart from the blood ties: one boxed group, no lines drawn. */
  .band.boxed {
    border: 1px solid var(--rule);
    padding: 0.25rem 0.45rem;
  }

  ul {
    list-style: none;
    margin: 0.1rem 0 0;
    padding: 0;
  }

  li {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    padding: 0.05rem 0;
    /* Each step away from the entity indents once, with a rule for the step it hangs off. */
    margin-left: calc(var(--depth) * 0.9rem);
    border-left: 1px solid var(--rule);
    padding-left: 0.4rem;
  }

  button.name {
    border: none;
    padding: 0;
    font-size: var(--t-13);
  }

  .role {
    color: var(--ink-faint);
  }
</style>
