<script lang="ts">
  import { regionLayout, type PlayerRegionMap } from '../lib/regionmap';

  let { map }: { map: PlayerRegionMap | null } = $props();

  const layout = $derived(map && map.hexes.length > 0 ? regionLayout(map) : null);
  const box = $derived(layout ? layout.viewBox.split(' ').map(Number) : [0, 0, 0, 0]);

  const KNOWN_TERRAIN = new Set([
    'water',
    'plains',
    'forest-light',
    'forest-dark',
    'swamp',
    'rocks',
    'mountain',
    'desert',
  ]);

  /** Unknown terrain falls back to the plains look so no hex renders unfilled. */
  const terrainClass = (terrain: string): string => `terrain-${KNOWN_TERRAIN.has(terrain) ? terrain : 'plains'}`;

  /** Village, town and city dots; an unset size reads as a town. */
  const settlementRadius = (size: string | null): number => (size === 'village' ? 2.2 : size === 'city' ? 4 : 3);
</script>

{#if !map}
  <p class="muted">No region map yet. The player adds one in Settings, Region.</p>
{:else if !layout}
  <p class="muted">The party has not seen any of {map.name} yet.</p>
{:else}
  <figure class="region-map">
    <svg viewBox={layout.viewBox} role="img" aria-label={`Map of ${map.name}`}>
      <rect class="fog" x={box[0]} y={box[1]} width={box[2]} height={box[3]} />

      {#each layout.hexes as hex (hex.id)}
        <polygon class="hex {terrainClass(hex.terrain)}" points={hex.points} />
      {/each}

      {#each layout.routes as route, index (index)}
        <polyline class="route {route.kind}" points={route.points} />
      {/each}

      {#each layout.countyBorders as border, index (index)}
        <line class="county-border" x1={border.x1} y1={border.y1} x2={border.x2} y2={border.y2} />
      {/each}
      {#each layout.duchyBorders as border, index (index)}
        <line class="duchy-border" x1={border.x1} y1={border.y1} x2={border.x2} y2={border.y2} />
      {/each}
      {#each layout.realmBorders as border, index (index)}
        <line class="realm-border" x1={border.x1} y1={border.y1} x2={border.x2} y2={border.y2} />
      {/each}

      {#each layout.labels as label, index (index)}
        <text
          class="region-label {label.kind}"
          x={label.x}
          y={label.y}
          font-size={label.kind === 'county' ? 4.5 : label.kind === 'duchy' ? 6 : 7.5}
        >
          {label.text}
        </text>
      {/each}

      {#each layout.places as place, index (index)}
        {#if place.kind === 'settlement'}
          {@const radius = settlementRadius(place.size)}
          <circle class="settlement" cx={place.x} cy={place.y} r={radius} />
          {#if place.port}
            <path
              class="port-anchor"
              transform={`translate(${place.x - radius - 2.5}, ${place.y})`}
              d="M0,-3.2 a1.1,1.1 0 1,0 0,2.2 a1.1,1.1 0 1,0 0,-2.2 M0,-1 V2.6 M-1.7,-0.5 H1.7 M-2.3,0.7 L0,2.6 L2.3,0.7"
            />
          {/if}
          <text class="place-label" x={place.x + radius + 1.5} y={place.y + 2} font-size="6">{place.name}</text>
        {:else if place.kind === 'danger'}
          <g class="danger">
            <line x1={place.x - 2} y1={place.y - 2} x2={place.x + 2} y2={place.y + 2} />
            <line x1={place.x - 2} y1={place.y + 2} x2={place.x + 2} y2={place.y - 2} />
          </g>
          <text class="place-label" x={place.x + 3.5} y={place.y + 2} font-size="6">{place.name}</text>
        {:else}
          <text class="place-label area" x={place.x} y={place.y} font-size="6">{place.name}</text>
        {/if}
      {/each}

      {#if layout.party}
        <g class="party">
          <circle class="party-ring" cx={layout.party.x} cy={layout.party.y} r="5" />
          <circle class="party-dot" cx={layout.party.x} cy={layout.party.y} r="1.5" />
        </g>
      {/if}
    </svg>
    <figcaption class="muted">{map.name} — what the party knows; the rest is fog.</figcaption>
  </figure>
{/if}

<style>
  .region-map {
    margin: 0;
    display: grid;
    gap: 0.35rem;
  }

  .region-map svg {
    display: block;
    width: 100%;
    height: auto;
    max-height: 70vh;
  }

  .region-map figcaption {
    font-size: var(--t-13);
  }

  .fog {
    fill: color-mix(in srgb, var(--ink) 12%, var(--surface));
  }

  .hex {
    stroke: color-mix(in srgb, var(--ink-faint) 60%, transparent);
    stroke-width: 0.12;
  }

  .terrain-water {
    fill: color-mix(in srgb, #4a78a8 45%, var(--surface-raised));
  }

  .terrain-plains {
    fill: color-mix(in srgb, #9caf7a 28%, var(--surface-raised));
  }

  .terrain-forest-light {
    fill: color-mix(in srgb, #6fa37a 32%, var(--surface-raised));
  }

  .terrain-forest-dark {
    fill: color-mix(in srgb, #4f7a5a 45%, var(--surface-raised));
  }

  .terrain-swamp {
    fill: color-mix(in srgb, #7a8452 38%, var(--surface-raised));
  }

  .terrain-rocks {
    fill: color-mix(in srgb, #8a8578 38%, var(--surface-raised));
  }

  .terrain-mountain {
    fill: color-mix(in srgb, #7d7466 55%, var(--surface-raised));
  }

  .terrain-desert {
    fill: color-mix(in srgb, #c9a44c 30%, var(--surface-raised));
  }

  .route {
    fill: none;
    stroke-width: 0.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .route.road {
    stroke: color-mix(in srgb, #8a6a3a 75%, var(--ink));
    stroke-dasharray: 2 1.5;
  }

  .route.searoute {
    stroke: color-mix(in srgb, #4a78a8 75%, var(--ink));
    stroke-dasharray: 0.5 1.8;
  }

  .county-border {
    stroke: var(--ink-muted);
    stroke-width: 0.3;
    stroke-dasharray: 1.6 1.4;
  }

  .duchy-border {
    stroke: var(--ink-muted);
    stroke-width: 0.45;
    stroke-dasharray: 2 1 0.4 1;
  }

  .realm-border {
    stroke: var(--ink);
    stroke-width: 0.7;
  }

  .settlement {
    fill: var(--ink);
  }

  .port-anchor {
    fill: none;
    stroke: var(--ink);
    stroke-width: 0.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .danger line {
    stroke: var(--accent);
    stroke-width: 0.9;
    stroke-linecap: round;
  }

  .place-label {
    fill: var(--ink);
    paint-order: stroke;
    stroke: var(--surface-raised);
    stroke-width: 0.9;
    stroke-linejoin: round;
  }

  .place-label.area {
    font-style: italic;
    text-anchor: middle;
    dominant-baseline: central;
  }

  .region-label {
    text-anchor: middle;
    dominant-baseline: central;
    paint-order: stroke;
    stroke: var(--surface-raised);
    stroke-width: 0.9;
    stroke-linejoin: round;
  }

  .region-label.county {
    fill: var(--ink-muted);
    font-variant: small-caps;
    letter-spacing: 0.04em;
  }

  .region-label.duchy {
    fill: var(--ink);
    font-variant: small-caps;
    letter-spacing: 0.08em;
  }

  .region-label.realm {
    fill: var(--ink);
    letter-spacing: 0.12em;
  }

  .party-ring {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.2;
  }

  .party-dot {
    fill: var(--accent);
  }
</style>
