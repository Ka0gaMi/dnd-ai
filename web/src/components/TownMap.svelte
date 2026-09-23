<script lang="ts">
  import { townLayers } from '../lib/townmap';

  let {
    name,
    kind,
    geojson,
  }: {
    name: string;
    kind: 'city' | 'village';
    geojson: unknown;
  } = $props();

  const layers = $derived(townLayers(geojson));
  const box = $derived(layers.viewBox.split(' ').map(Number));
  const labelSize = $derived(box[2] * 0.03);
</script>

<figure class="town-map">
  <svg viewBox={layers.viewBox} role="img" aria-label={`Map of ${name}`}>
    <rect class="background" x={box[0]} y={box[1]} width={box[2]} height={box[3]} />

    {#each layers.water as path}
      <path class="water" d={path} fill-rule="evenodd" />
    {/each}
    {#each layers.fields as path}
      <path class="fields" d={path} fill-rule="evenodd" />
    {/each}
    {#each layers.greens as path}
      <path class="greens" d={path} fill-rule="evenodd" />
    {/each}
    {#each layers.squares as path}
      <path class="squares" d={path} fill-rule="evenodd" />
    {/each}

    {#each layers.rivers as stroke}
      <path class="rivers" d={stroke.d} stroke-width={stroke.width} />
    {/each}
    {#each layers.roads as stroke}
      <path class="roads" d={stroke.d} stroke-width={stroke.width} />
    {/each}
    {#each layers.planks as stroke}
      <path class="planks" d={stroke.d} stroke-width={stroke.width} />
    {/each}

    {#each layers.buildings as path}
      <path class="buildings" d={path} fill-rule="evenodd" />
    {/each}
    {#each layers.walls as stroke}
      <path class="walls" d={stroke.d} stroke-width={stroke.width} />
    {/each}

    {#each layers.trees as tree}
      <circle class="trees" cx={tree.x} cy={tree.y} r="2.5" />
    {/each}

    {#each layers.districts as district, index (index)}
      <text class="district" x={district.x} y={district.y} font-size={labelSize} stroke-width={labelSize * 0.28}>
        {district.name}
      </text>
    {/each}
  </svg>
  <figcaption class="muted">{name} — drawn from Watabou's {kind} generator</figcaption>
</figure>

<style>
  .town-map {
    --map-water: color-mix(in srgb, #4a78a8 45%, var(--surface-raised));
    --map-green: color-mix(in srgb, #6fa37a 22%, var(--surface-raised));
    --map-tree: color-mix(in srgb, #6fa37a 45%, var(--surface-raised));
    margin: 0;
    display: grid;
    gap: 0.35rem;
  }

  .town-map svg {
    display: block;
    width: 100%;
    height: auto;
    max-height: 60vh;
  }

  .town-map figcaption {
    font-size: var(--t-13);
  }

  .background {
    fill: var(--surface-raised);
  }

  .water {
    fill: var(--map-water);
  }

  .fields,
  .greens {
    fill: var(--map-green);
  }

  .squares {
    fill: color-mix(in srgb, var(--ink) 10%, var(--surface-raised));
  }

  .rivers {
    fill: none;
    stroke: var(--map-water);
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .roads {
    fill: none;
    stroke: var(--ink-faint);
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .planks {
    fill: none;
    stroke: var(--ink-muted);
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .buildings {
    fill: var(--ink-muted);
    fill-opacity: 0.7;
  }

  .walls {
    fill: none;
    stroke: var(--ink);
  }

  .trees {
    fill: var(--map-tree);
  }

  .district {
    fill: var(--ink);
    text-anchor: middle;
    paint-order: stroke;
    stroke: var(--surface-raised);
    stroke-linejoin: round;
  }
</style>
