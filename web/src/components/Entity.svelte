<script lang="ts">
  import EntityTree from './EntityTree.svelte';
  import Help from './Help.svelte';
  import Portrait from './Portrait.svelte';
  import TownMap from './TownMap.svelte';
  import { getEntity, getEntityTree, getTownMap } from '../lib/api';
  import type { TownMapAnswer } from '../lib/api';
  import { groupRelations } from '../lib/codex';
  import { relationHelpKey } from '../lib/rulesHelp';
  import type { EntityView, TreeNode, VoiceCard } from '../lib/types';

  let {
    campaignId,
    entityId,
    version,
    showSecrets,
    onpick,
    onback,
  }: {
    campaignId: number;
    entityId: number;
    /** The spoiler setting; the server sends the DM's notes only with it on, and this keeps them off too. */
    showSecrets: boolean;
    /** Bumped by the store when an event could have changed the codex. */
    version: number;
    onpick: (id: number) => void;
    onback: () => void;
  } = $props();

  const VOICE_ROWS: Array<{ key: keyof VoiceCard; label: string }> = [
    { key: 'speech_pattern', label: 'Speaks' },
    { key: 'catchphrase', label: 'Says' },
    { key: 'goal', label: 'Wants' },
    { key: 'fear', label: 'Fears' },
    { key: 'attitude', label: 'Attitude' },
  ];

  let entity = $state<EntityView | null>(null);
  let tree = $state<TreeNode | null>(null);
  let townMap = $state<TownMapAnswer | null>(null);
  let problem = $state<string | null>(null);

  const relations = $derived(groupRelations(entity?.relations ?? []));
  const voice = $derived(VOICE_ROWS.filter((row) => (entity?.voice?.[row.key] ?? '').trim() !== ''));
  const monogram = $derived((entity?.name ?? '?').trim().slice(0, 1).toUpperCase());

  $effect(() => {
    const id = entityId;
    void version;
    townMap = null;
    getEntity(campaignId, id)
      .then((view) => {
        entity = view;
        problem = null;
      })
      .catch((failure) => (problem = failure instanceof Error ? failure.message : String(failure)));
    getEntityTree(campaignId, id)
      .then((answer) => (tree = answer.tree))
      .catch(() => (tree = null));
    getTownMap(campaignId, id)
      .then((answer) => (townMap = answer))
      .catch(() => (townMap = null));
  });
</script>

<article>
  <button type="button" class="label back" onclick={onback}>Back to the codex</button>
  {#if problem}
    <p class="chip bad">{problem}</p>
  {:else if entity}
    <header>
      <Portrait path={entity.portrait_path} {monogram} size={72} alt="" name={entity.name} />
      <div class="titles">
        <h3 class="name">{entity.name}</h3>
        <div class="chips">
          <span class="chip">{entity.kind}</span>
          <span class="chip" class:bad={entity.status === 'dead'}>{entity.status}</span>
        </div>
      </div>
    </header>

    {#if entity.summary}<p class="prose">{entity.summary}</p>{/if}

    {#if entity.notes}
      <h4 class="label">Notes</h4>
      <p class="prose muted">{entity.notes}</p>
    {/if}

    {#if entity.hidden_notes && showSecrets}
      <h4 class="label">The DM's notes <span class="chip warn">[secret]</span></h4>
      <p class="prose secret">{entity.hidden_notes}</p>
    {/if}

    {#if voice.length > 0}
      <h4 class="label"><Help k="codex.voice_card" text="Voice card" label /></h4>
      <dl class="voice">
        {#each voice as row (row.key)}
          <dt class="label">{row.label}</dt>
          <dd>{entity.voice?.[row.key]}</dd>
        {/each}
      </dl>
    {/if}

    {#if townMap && entity.kind === 'place'}
      <section>
        <h4 class="label">Map</h4>
        <TownMap name={townMap.name} kind={townMap.kind} geojson={townMap.geojson} />
      </section>
    {/if}

    {#if relations.length > 0}
      <h4 class="label">Ties</h4>
      {#each relations as group (group.as)}
        <div class="relations">
          <Help k={relationHelpKey(group.as)} text={group.label} label />
          <ul>
            {#each group.relations as relation (relation.id)}
              <li>
                <button type="button" class="name-link" onclick={() => onpick(relation.entity.id)}>
                  {relation.entity.name}
                </button>
                <span class="label kind">{relation.entity.kind}</span>
                {#if relation.notes}<span class="muted"> — {relation.notes}</span>{/if}
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    {/if}

    {#if tree}
      <h4 class="label">Tree</h4>
      <EntityTree {tree} {onpick} />
    {/if}
  {:else}
    <p class="empty">Opening the entry…</p>
  {/if}
</article>

<style>
  article {
    display: grid;
    gap: 0.3rem;
    justify-items: start;
  }

  .back {
    border: none;
    padding: 0.1rem 0;
  }

  header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .name {
    font-family: var(--font-display);
    font-size: var(--t-18);
    color: var(--accent);
  }

  .chips {
    display: flex;
    gap: 0.35rem;
    margin-top: 0.2rem;
  }

  h4 {
    margin: 0.5rem 0 0;
  }

  p {
    margin: 0.1rem 0;
    white-space: pre-wrap;
  }

  .secret {
    border-left: 3px solid var(--warn);
    padding-left: 0.45rem;
    color: var(--ink-muted);
  }

  /* The voice card: a small index card, ruled once and laid out in two columns. */
  .voice {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.15rem 0.6rem;
    width: 100%;
    max-width: 45ch;
    margin: 0.2rem 0;
    padding: 0.35rem 0.5rem;
    background: var(--surface-raised);
    border: 1px solid var(--rule);
    border-left: 3px solid var(--accent);
  }

  dd {
    margin: 0;
    font-size: var(--t-13);
  }

  .relations {
    display: grid;
    gap: 0.1rem;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    font-size: var(--t-13);
  }

  .name-link {
    border: none;
    padding: 0;
    font-size: var(--t-13);
  }

  .kind {
    color: var(--ink-faint);
  }
</style>
