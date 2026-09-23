<script lang="ts">
  import { floorLayouts, type FloorLayout, type Segment } from '../lib/floorplan';

  let {
    name,
    kind,
    plan,
  }: {
    name: string;
    kind: string;
    plan: unknown;
  } = $props();

  const layouts = $derived(floorLayouts(plan));
  let current = $state(0);
  const floor = $derived(layouts[current] as FloorLayout | undefined);
  const occupied = $derived(new Set((floor?.cells ?? []).map((cell) => `${cell.x},${cell.y}`)));

  /** A door leaf is drawn short and thick, centred on its doorway gap. */
  function doorLeaf(door: Segment): Segment {
    const cx = (door.x1 + door.x2) / 2;
    const cy = (door.y1 + door.y2) / 2;
    const dx = door.x2 - door.x1;
    const dy = door.y2 - door.y1;
    const length = Math.hypot(dx, dy) || 1;
    const half = 0.3;
    return {
      x1: cx - (dx / length) * half,
      y1: cy - (dy / length) * half,
      x2: cx + (dx / length) * half,
      y2: cy + (dy / length) * half,
    };
  }

  /** The triangle points at the side of the edge with no cell, i.e. out of the building. */
  function entrancePoints(segment: Segment, cells: Set<string>): string {
    const mx = (segment.x1 + segment.x2) / 2;
    const my = (segment.y1 + segment.y2) / 2;
    const vertical = segment.x1 === segment.x2;
    const along = 0.22;
    const out = 0.34;
    let outX = 0;
    let outY = 0;
    if (vertical) {
      outX = cells.has(`${segment.x1 - 1},${Math.floor(my)}`) ? 1 : -1;
    } else {
      outY = cells.has(`${Math.floor(mx)},${segment.y1 - 1}`) ? 1 : -1;
    }
    const alongX = vertical ? 0 : along;
    const alongY = vertical ? along : 0;
    const base1 = `${mx + alongX},${my + alongY}`;
    const base2 = `${mx - alongX},${my - alongY}`;
    return `${base1} ${base2} ${mx + outX * out},${my + outY * out}`;
  }
</script>

{#if layouts.length > 1}
  <div class="segmented floors" role="group" aria-label="Floor">
    {#each layouts as layout, index (layout.level)}
      <button type="button" aria-pressed={current === index} onclick={() => (current = index)}>
        {layout.label}
      </button>
    {/each}
  </div>
{/if}

<figure class="building-plan">
  {#if floor}
    {@const entrance = floor.entrance}
    <svg viewBox={floor.viewBox} role="img" aria-label={`Floor plan of ${name}, ${floor.label}`}>
      {#each floor.cells as cell (cell.x + ',' + cell.y)}
        <rect class="cell" class:alt={cell.room % 2 === 1} class:solid={cell.solid} x={cell.x} y={cell.y} width="1" height="1" />
      {/each}

      {#each floor.walls as wall, index (index)}
        <line class="wall" x1={wall.x1} y1={wall.y1} x2={wall.x2} y2={wall.y2} />
      {/each}

      {#each floor.windows as window, index (index)}
        <line class="window" x1={window.x1} y1={window.y1} x2={window.x2} y2={window.y2} />
      {/each}

      {#each floor.doors as door, index (index)}
        {#if !door.open}
          {@const leaf = doorLeaf(door)}
          <line class="door" x1={leaf.x1} y1={leaf.y1} x2={leaf.x2} y2={leaf.y2} />
        {/if}
      {/each}

      {#if entrance}
        <polygon class="entrance" points={entrancePoints(entrance, occupied)} />
      {/if}

      {#each floor.stairs as stair, index (index)}
        <g class="stair">
          <rect x={stair.x + 0.15} y={stair.y + 0.15} width="0.7" height="0.7" />
          <line x1={stair.x + 0.15} y1={stair.y + 0.35} x2={stair.x + 0.85} y2={stair.y + 0.35} />
          <line x1={stair.x + 0.15} y1={stair.y + 0.5} x2={stair.x + 0.85} y2={stair.y + 0.5} />
          <line x1={stair.x + 0.15} y1={stair.y + 0.65} x2={stair.x + 0.85} y2={stair.y + 0.65} />
          <text class="arrow" x={stair.x + 0.5} y={stair.y + 0.52} font-size="0.42">
            {stair.up ? '↑' : '↓'}
          </text>
        </g>
      {/each}

      {#each floor.rooms as room, index (index)}
        {#if room.name}
          <text class="room" x={room.x} y={room.y} font-size="0.32">{room.name}</text>
        {/if}
      {/each}
    </svg>
  {/if}
  <figcaption class="muted">{name} ({kind}) — floor plan from Watabou's Dwellings</figcaption>
</figure>

<style>
  .building-plan {
    --plan-window: color-mix(in srgb, #4a78a8 65%, var(--ink));
    margin: 0;
    display: grid;
    gap: 0.35rem;
  }

  .floors {
    justify-self: start;
    margin-bottom: 0.4rem;
  }

  .building-plan svg {
    display: block;
    width: 100%;
    height: auto;
    max-height: 60vh;
  }

  .building-plan figcaption {
    font-size: var(--t-13);
  }

  .cell {
    fill: var(--surface-raised);
  }

  .cell.alt {
    fill: color-mix(in srgb, var(--accent) 7%, var(--surface-raised));
  }

  .cell.solid {
    fill: var(--ink-faint);
  }

  .wall {
    stroke: var(--ink);
    stroke-width: 0.12;
    stroke-linecap: square;
  }

  .door {
    stroke: var(--accent);
    stroke-width: 0.16;
    stroke-linecap: square;
  }

  .window {
    stroke: var(--plan-window);
    stroke-width: 0.06;
    stroke-linecap: square;
  }

  .entrance {
    fill: var(--accent);
  }

  .stair rect {
    fill: none;
    stroke: var(--ink-faint);
    stroke-width: 0.05;
  }

  .stair line {
    stroke: var(--ink-faint);
    stroke-width: 0.04;
  }

  .arrow {
    fill: var(--ink);
    font-size: 0.42px;
    text-anchor: middle;
    dominant-baseline: central;
    paint-order: stroke;
    stroke: var(--surface-raised);
    stroke-width: 0.06;
  }

  .room {
    fill: var(--ink);
    text-anchor: middle;
    dominant-baseline: central;
    paint-order: stroke;
    stroke: var(--surface-raised);
    stroke-width: 0.06;
  }
</style>
