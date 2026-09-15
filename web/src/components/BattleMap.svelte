<script lang="ts">
  import { Group } from 'konva/lib/Group';
  import { Layer } from 'konva/lib/Layer';
  import { Stage } from 'konva/lib/Stage';
  import { Tween } from 'konva/lib/Tween';
  import { Arc } from 'konva/lib/shapes/Arc';
  import { Circle } from 'konva/lib/shapes/Circle';
  import { Line } from 'konva/lib/shapes/Line';
  import { Rect } from 'konva/lib/shapes/Rect';
  import { Text } from 'konva/lib/shapes/Text';
  import { onMount } from 'svelte';
  import { getTactics } from '../lib/api';
  import { reachable, visibleHp } from '../lib/combat.svelte';
  import { LEGEND_ITEMS, featureNotes, terrainWord, tokenTooltip } from '../lib/mapkey';
  import { tooltipPosition, type AnchorRect } from '../lib/tooltip';
  import { TacticsCache } from '../lib/tactics';
  import type { BattleState, Combatant, CombatLogEntry } from '../lib/types';

  let { battle, log, campaignId }: { battle: BattleState; log: CombatLogEntry[]; campaignId: number } = $props();

  const MIN_CELL = 12;
  const MAX_CELL = 34;
  const MOVE_MS = 200;
  /** The attack line is a plain timer, so it clears even when motion is turned off. */
  const ATTACK_MS = 1500;
  /** How long a hover sits still before the cover of that pair is worth a request. */
  const HOVER_MS = 150;
  /** Room on the top and left edges for the coordinate digits the DM's ASCII grid also shows. */
  const GUTTER = 18;
  const AXIS_FONT = 12;

  let host = $state<HTMLDivElement | null>(null);
  let width = $state(0);
  /** Bumped when the theme changes, so the redraw picks up the new token values. */
  let theme = $state(0);
  let tip = $state<{
    anchor: AnchorRect;
    coords: string;
    terrain: string;
    feature: string | null;
    who: string | null;
    targetId: number | null;
    lines: string[];
  } | null>(null);

  let tipEl = $state<HTMLDivElement | null>(null);
  let tipAt = $state({ left: 0, top: 0 });
  let placed = $state(false);

  /** Measured once it is on screen, then flipped and clamped to stay inside the window. */
  $effect(() => {
    if (!tip || !tipEl) {
      placed = false;
      return;
    }
    tipAt = tooltipPosition(
      tip.anchor,
      { width: tipEl.offsetWidth, height: tipEl.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    placed = true;
  });

  let stage: Stage | null = null;
  let axisLayer: Layer | null = null;
  let terrainLayer: Layer | null = null;
  let tokenLayer: Layer | null = null;
  let fxLayer: Layer | null = null;
  const tokens = new Map<number, Group>();
  let drawnAttack = 0;
  /** Attacks from before the window opened are history, not something to flash on screen. */
  let openedAt = 0;
  const cover = new TacticsCache();
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  /** Cell-sized tiles for the difficult stipple and the blocked hatch, rebuilt when the size or theme changes. */
  let patternKey = '';
  let dotTile: HTMLCanvasElement | null = null;
  let hatchTile: HTMLCanvasElement | null = null;

  const cell = $derived(
    Math.max(
      MIN_CELL,
      Math.min(MAX_CELL, Math.floor(((width || 1) - GUTTER) / Math.max(1, battle.map.w))),
    ),
  );
  const active = $derived(battle.combatants.find((c) => c.id === battle.active?.id) ?? null);
  const reachableCells = $derived(
    active && active.team === 'party' ? reachable(battle.map, battle.combatants, active) : new Set<string>(),
  );
  const notes = $derived(featureNotes(battle.map.features));
  const pc = $derived(battle.combatants.find((c) => c.kind === 'pc') ?? null);
  const names = $derived(new Map(battle.combatants.map((c) => [c.id, c.name])));
  const nameOf = (id: number): string => names.get(id) ?? 'someone';
  /** Cover answers only hold while the fight stands still: the newest log entry dates them. */
  const stateVersion = $derived(log[0]?.id ?? 0);

  const reduceMotion = (): boolean =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const token = (name: string): string =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /** Grid lines want the rule colour at 40%: tokens are plain hex, so mix the alpha in here. */
  function fade(colour: string, a: number): string {
    const hex = /^#([0-9a-f]{6})$/i.exec(colour);
    if (!hex) return colour;
    const n = Number.parseInt(hex[1]!, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  function palette() {
    return {
      open: token('--surface'),
      ground: token('--ground'),
      stone: token('--rule'),
      rule: token('--rule'),
      ink: token('--ink'),
      faint: token('--ink-faint'),
      accent: token('--accent'),
      accentSoft: token('--accent-soft'),
      info: token('--info'),
      bad: token('--bad'),
      good: token('--good'),
      warn: token('--warn'),
    };
  }

  function tile(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = cell;
    canvas.height = cell;
    return canvas;
  }

  /** Four dots per cell: difficult ground reads as texture, not as another colour. */
  function dotCanvas(colour: string): HTMLCanvasElement {
    const canvas = tile();
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    ctx.fillStyle = colour;
    const r = Math.max(0.9, cell * 0.06);
    for (const cy of [0.28, 0.72]) {
      for (const cx of [0.28, 0.72]) {
        ctx.beginPath();
        ctx.arc(cx * cell, cy * cell, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return canvas;
  }

  /** Diagonals at thirds of a cell, so the hatch runs unbroken across neighbouring blocked cells. */
  function hatchCanvas(colour: string): HTMLCanvasElement {
    const canvas = tile();
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    for (const step of [1, 2, 3, 4, 5]) {
      const c = (cell * step) / 3;
      ctx.beginPath();
      if (c <= cell) {
        ctx.moveTo(0, c);
        ctx.lineTo(c, 0);
      } else {
        ctx.moveTo(c - cell, cell);
        ctx.lineTo(cell, c - cell);
      }
      ctx.stroke();
    }
    return canvas;
  }

  function syncPatterns(colours: ReturnType<typeof palette>): void {
    const key = `${colours.faint}|${cell}`;
    if (key === patternKey && dotTile && hatchTile) return;
    dotTile = dotCanvas(colours.faint);
    hatchTile = hatchCanvas(colours.faint);
    patternKey = key;
  }

  function patternRect(x: number, y: number, image: HTMLCanvasElement): Rect {
    return new Rect({
      x: x * cell,
      y: y * cell,
      width: cell,
      height: cell,
      fillPatternImage: image as unknown as HTMLImageElement,
      fillPatternRepeat: 'repeat',
      fillPriority: 'pattern',
    });
  }

  /** The coordinate digits: x along the top, y down the left, exactly the numbering the DM reads. */
  function drawAxis(colours: ReturnType<typeof palette>): void {
    const layer = axisLayer;
    if (!layer) return;
    layer.destroyChildren();
    const every = cell < 14 ? 2 : 1;
    const common = { fontSize: AXIS_FONT, fontFamily: 'IBM Plex Mono, monospace', fill: colours.faint };
    for (let x = 0; x < battle.map.w; x += 1) {
      if (x % every !== 0) continue;
      layer.add(
        new Text({
          ...common,
          x: GUTTER + x * cell,
          y: GUTTER - AXIS_FONT - 2,
          width: cell,
          align: 'center',
          text: String(x % 10),
        }),
      );
    }
    for (let y = 0; y < battle.map.h; y += 1) {
      if (y % every !== 0) continue;
      layer.add(
        new Text({
          ...common,
          x: 0,
          y: GUTTER + y * cell + (cell - AXIS_FONT) / 2,
          width: GUTTER - 4,
          align: 'right',
          text: String(y),
        }),
      );
    }
    layer.batchDraw();
  }

  function drawTerrain(colours: ReturnType<typeof palette>): void {
    const layer = terrainLayer;
    if (!layer) return;
    layer.destroyChildren();
    syncPatterns(colours);

    for (let y = 0; y < battle.map.h; y += 1) {
      for (let x = 0; x < battle.map.w; x += 1) {
        const kind = battle.map.rows[y]?.[x] ?? '.';
        // Blocked ground is heavier, never darker: stone fill, hatch, and a faint border around it.
        layer.add(
          new Rect({
            x: x * cell,
            y: y * cell,
            width: cell,
            height: cell,
            fill: kind === '#' ? colours.stone : colours.open,
            stroke: kind === '#' ? colours.faint : undefined,
            strokeWidth: kind === '#' ? 1 : 0,
          }),
        );
        if (kind === '~' && dotTile) layer.add(patternRect(x, y, dotTile));
        if (kind === '#' && hatchTile) layer.add(patternRect(x, y, hatchTile));
      }
    }

    const grid = fade(colours.rule, 0.4);
    for (let x = 0; x <= battle.map.w; x += 1) {
      layer.add(
        new Line({ points: [x * cell, 0, x * cell, battle.map.h * cell], stroke: grid, strokeWidth: 1 }),
      );
    }
    for (let y = 0; y <= battle.map.h; y += 1) {
      layer.add(
        new Line({ points: [0, y * cell, battle.map.w * cell, y * cell], stroke: grid, strokeWidth: 1 }),
      );
    }

    for (const key of reachableCells) {
      const [x, y] = key.split(',').map(Number);
      layer.add(
        new Rect({
          x: (x ?? 0) * cell,
          y: (y ?? 0) * cell,
          width: cell,
          height: cell,
          fill: colours.accentSoft,
        }),
      );
    }
    // One outline around the whole reachable region, so it reads as range rather than as cells.
    for (const key of reachableCells) {
      const [x, y] = key.split(',').map(Number);
      const cx = x ?? 0;
      const cy = y ?? 0;
      const edges: number[][] = [];
      if (!reachableCells.has(`${cx},${cy - 1}`)) edges.push([0, 0, 1, 0]);
      if (!reachableCells.has(`${cx},${cy + 1}`)) edges.push([0, 1, 1, 1]);
      if (!reachableCells.has(`${cx - 1},${cy}`)) edges.push([0, 0, 0, 1]);
      if (!reachableCells.has(`${cx + 1},${cy}`)) edges.push([1, 0, 1, 1]);
      for (const [x1, y1, x2, y2] of edges) {
        layer.add(
          new Line({
            points: [
              (cx + x1!) * cell,
              (cy + y1!) * cell,
              (cx + x2!) * cell,
              (cy + y2!) * cell,
            ],
            stroke: colours.accent,
            strokeWidth: 1.5,
          }),
        );
      }
    }

    // Features are numbered pins only; the words live in the list under the map and in the tooltip.
    battle.map.features.forEach((feature, i) => {
      const r = Math.min(8, Math.max(5, cell * 0.34));
      const px = feature.x * cell + r + 1;
      const py = feature.y * cell + r + 1;
      layer.add(new Circle({ x: px, y: py, radius: r, fill: colours.accent }));
      const size = Math.max(8, r * 1.3);
      layer.add(
        new Text({
          x: px - r,
          y: py - size / 2,
          width: r * 2,
          align: 'center',
          text: String(i + 1),
          fontSize: size,
          fontStyle: '600',
          fontFamily: 'IBM Plex Mono, monospace',
          fill: colours.ground,
        }),
      );
    });
    layer.batchDraw();
  }

  function tokenGroup(id: number): Group {
    const existing = tokens.get(id);
    if (existing) return existing;
    const group = new Group();
    tokenLayer?.add(group);
    tokens.set(id, group);
    return group;
  }

  function syncTokens(colours: ReturnType<typeof palette>): void {
    const shown = new Set<number>();
    for (const combatant of battle.combatants) {
      if (!combatant.visible) continue;
      shown.add(combatant.id);
      const group = tokenGroup(combatant.id);
      const span = combatant.footprint * cell;
      const isActive = combatant.id === battle.active?.id;
      const teamColour =
        combatant.team === 'party' ? colours.info : combatant.team === 'enemy' ? colours.bad : colours.faint;
      const hp = visibleHp(combatant, battle.encounter.visibility);

      group.destroyChildren();
      group.opacity(combatant.alive ? 1 : 0.4);
      group.add(
        combatant.team === 'party'
          ? new Circle({
              x: span / 2,
              y: span / 2,
              radius: span / 2 - 3,
              fill: colours.open,
              stroke: teamColour,
              strokeWidth: 2,
            })
          : new Rect({
              x: 3,
              y: 3,
              width: span - 6,
              height: span - 6,
              fill: colours.open,
              stroke: teamColour,
              strokeWidth: 2,
            }),
      );
      if (hp.bar && combatant.alive) {
        group.add(
          new Arc({
            x: span / 2,
            y: span / 2,
            innerRadius: span / 2 - 2,
            outerRadius: span / 2 - 0.5,
            angle: 360 * hp.fraction,
            rotation: -90,
            fill: hp.fraction >= 0.5 ? colours.good : hp.fraction >= 0.25 ? colours.warn : colours.bad,
          }),
        );
      }
      group.add(
        new Text({
          x: 0,
          y: span / 2 - cell * 0.32,
          width: span,
          align: 'center',
          text: combatant.marker,
          fontSize: Math.max(9, cell * 0.6),
          fontFamily: 'IBM Plex Mono, monospace',
          fill: isActive ? colours.accent : colours.ink,
        }),
      );
      if (isActive) {
        group.add(
          combatant.team === 'party'
            ? new Circle({ x: span / 2, y: span / 2, radius: span / 2 - 0.5, stroke: colours.accent, strokeWidth: 2 })
            : new Rect({
                x: 0.5,
                y: 0.5,
                width: span - 1,
                height: span - 1,
                stroke: colours.accent,
                strokeWidth: 2,
              }),
        );
      }
      if (!combatant.alive) {
        group.add(
          new Line({ points: [3, span - 3, span - 3, 3], stroke: colours.ink, strokeWidth: 2 }),
        );
      }

      const to = { x: combatant.x * cell, y: combatant.y * cell };
      const moved = group.x() !== to.x || group.y() !== to.y;
      if (moved && group.getAttr('placed') && !reduceMotion()) {
        new Tween({ node: group, x: to.x, y: to.y, duration: MOVE_MS / 1000 }).play();
      } else {
        group.position(to);
      }
      group.setAttr('placed', true);
    }
    for (const [id, group] of tokens) {
      if (shown.has(id)) continue;
      group.destroy();
      tokens.delete(id);
    }
    tokenLayer?.batchDraw();
  }

  /** The newest attack in the log, drawn once as a line from actor to target and cleared by a timer. */
  function drawAttack(colours: ReturnType<typeof palette>): void {
    const entry = log.find((e) => e.kind === 'attack');
    if (!entry || entry.id === drawnAttack) return;
    drawnAttack = entry.id;
    // A reload replays the whole log: only an attack made since the window opened is news.
    if (Date.parse(entry.ts) < openedAt) return;
    const actor = battle.combatants.find((c) => c.id === entry.actor_id);
    const target = battle.combatants.find((c) => c.id === entry.target_id);
    if (!actor || !target || !fxLayer) return;
    const centre = (c: typeof actor): number[] => [
      (c.x + c.footprint / 2) * cell,
      (c.y + c.footprint / 2) * cell,
    ];
    const hit = (entry.payload as { hit?: boolean } | null)?.hit === true;
    const line = new Line({
      points: [...centre(actor), ...centre(target)],
      stroke: hit ? colours.accent : colours.faint,
      strokeWidth: 2,
    });
    fxLayer.add(line);
    fxLayer.batchDraw();
    setTimeout(() => {
      line.destroy();
      fxLayer?.batchDraw();
    }, ATTACK_MS);
  }

  const occupant = (cx: number, cy: number): Combatant | null =>
    battle.combatants.find(
      (c) =>
        c.visible &&
        cx >= c.x &&
        cx < c.x + c.footprint &&
        cy >= c.y &&
        cy < c.y + c.footprint,
    ) ?? null;

  const linesFor = (who: Combatant): string[] =>
    tokenTooltip(who, {
      visibility: battle.encounter.visibility,
      pc,
      active,
      nameOf,
      tactics:
        pc && who.team !== 'party' && who.id !== pc.id
          ? (cover.cached(stateVersion, pc.id, who.id) ?? undefined)
          : undefined,
    });

  /** Hovering a foe asks the server what stands between it and the player, once per pair per state. */
  function requestCover(target: Combatant): void {
    clearTimeout(hoverTimer);
    const from = pc;
    if (!from || target.team === 'party' || target.id === from.id) return;
    if (cover.cached(stateVersion, from.id, target.id)) return;
    const version = stateVersion;
    hoverTimer = setTimeout(() => {
      cover.lookup(version, from.id, target.id, (a, b) => getTactics(campaignId, a, b)).then((found) => {
        if (found && tip?.targetId === target.id) tip = { ...tip, lines: linesFor(target) };
      });
    }, HOVER_MS);
  }

  /** Mouse only, as agreed: the same facts are already on the cards and in the log for everyone else. */
  function onMove(event: MouseEvent): void {
    const rect = host?.getBoundingClientRect();
    if (!rect) return;
    const cx = Math.floor((event.clientX - rect.left - GUTTER) / cell);
    const cy = Math.floor((event.clientY - rect.top - GUTTER) / cell);
    if (cx < 0 || cy < 0 || cx >= battle.map.w || cy >= battle.map.h) {
      tip = null;
      clearTimeout(hoverTimer);
      return;
    }
    const featureIndex = battle.map.features.findIndex(
      (f) => cx >= f.x && cx < f.x + f.w && cy >= f.y && cy < f.y + f.h,
    );
    const note = featureIndex >= 0 ? notes[featureIndex] : null;
    const who = occupant(cx, cy);
    // The tip hangs off the cell in viewport coordinates: the column would otherwise clip it.
    const left = rect.left + GUTTER + cx * cell;
    const top = rect.top + GUTTER + cy * cell;
    tip = {
      anchor: { left, right: left + cell, top, bottom: top + cell },
      coords: `${cx},${cy}`,
      terrain: terrainWord(battle.map.rows[cy]?.[cx] ?? '.'),
      feature: note ? `${note.name} — ${note.text}` : null,
      who: who ? who.name : null,
      targetId: who?.id ?? null,
      lines: who ? linesFor(who) : [],
    };
    if (who) requestCover(who);
    else clearTimeout(hoverTimer);
  }

  onMount(() => {
    if (!host) return;
    openedAt = Date.now();
    stage = new Stage({ container: host, width: 1, height: 1 });
    axisLayer = new Layer({ listening: false });
    terrainLayer = new Layer({ listening: false, x: GUTTER, y: GUTTER });
    tokenLayer = new Layer({ listening: false, x: GUTTER, y: GUTTER });
    fxLayer = new Layer({ listening: false, x: GUTTER, y: GUTTER });
    stage.add(axisLayer, terrainLayer, tokenLayer, fxLayer);

    const resize = new ResizeObserver(([entry]) => (width = entry?.contentRect.width ?? 0));
    resize.observe(host);
    const themes = new MutationObserver(() => (theme += 1));
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      resize.disconnect();
      themes.disconnect();
      clearTimeout(hoverTimer);
      tokens.clear();
      stage?.destroy();
      stage = null;
    };
  });

  $effect(() => {
    void theme;
    void battle;
    void log;
    if (!stage || width === 0) return;
    const colours = palette();
    stage.size({ width: GUTTER + cell * battle.map.w, height: GUTTER + cell * battle.map.h });
    drawAxis(colours);
    drawTerrain(colours);
    syncTokens(colours);
    drawAttack(colours);
  });
</script>

<section>
  <h2 class="section-title">Battlefield</h2>
  <div
    class="frame"
    onmousemove={onMove}
    onmouseleave={() => {
      tip = null;
      clearTimeout(hoverTimer);
    }}
    role="presentation"
  >
    <div class="map" bind:this={host}></div>
    {#if tip}
      <div
        class="tip"
        class:placed
        bind:this={tipEl}
        style="left: {tipAt.left}px; top: {tipAt.top}px"
      >
        <span class="label">{tip.coords} · {tip.terrain}</span>
        {#if tip.feature}<span class="muted">{tip.feature}</span>{/if}
        {#if tip.who}
          <span class="who">{tip.who}</span>
          {#each tip.lines as line, i (i)}<span class="muted">{line}</span>{/each}
        {/if}
      </div>
    {/if}
  </div>

  <ul class="key label">
    {#each LEGEND_ITEMS as item (item.key)}
      <li><span class="sw {item.key}" aria-hidden="true"></span>{item.text}</li>
    {/each}
  </ul>

  {#if notes.length > 0}
    <ul class="features">
      {#each notes as note (note.index)}
        <li>
          <span class="pin num" aria-hidden="true">{note.index}</span>
          <span class="fname">{note.name}</span>
          <span class="muted">— {note.text}</span>
        </li>
      {/each}
    </ul>
  {/if}
  <p class="foot label">5 ft per cell · hover a cell for what stands there</p>
</section>

<style>
  .frame {
    position: relative;
  }

  .map {
    width: 100%;
    overflow: hidden;
    border: 1px solid var(--rule);
    background: var(--surface);
  }

  .tip {
    position: fixed;
    z-index: 20;
    /* Hidden for the frame between rendering and being measured, so it never flashes at 0,0. */
    visibility: hidden;
    display: grid;
    gap: 0.1rem;
    max-width: 16rem;
    padding: 0.3rem 0.45rem;
    font-size: var(--t-12);
    background: var(--surface-raised);
    border: 1px solid var(--rule);
    border-left: 3px solid var(--accent);
    pointer-events: none;
  }

  .tip.placed {
    visibility: visible;
  }

  .tip .who {
    font-family: var(--font-mono);
    color: var(--ink);
  }

  .key {
    display: flex;
    flex-wrap: wrap;
    gap: 0.15rem 0.8rem;
    list-style: none;
    margin: 0.4rem 0 0;
    padding: 0;
    text-transform: none;
    letter-spacing: 0;
  }

  .key li {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .sw {
    position: relative;
    flex: none;
    width: 0.8rem;
    height: 0.8rem;
    background-color: var(--surface);
    border: 1px solid var(--rule);
  }

  .key :global(.difficult) {
    background-image: radial-gradient(var(--ink-faint) 0.9px, transparent 1px);
    background-size: 4px 4px;
    background-position: 1px 1px;
  }

  .key :global(.blocked) {
    background-color: var(--rule);
    background-image: repeating-linear-gradient(
      45deg,
      transparent 0 2px,
      var(--ink-faint) 2px 2.5px
    );
    border-color: var(--ink-faint);
  }

  .key :global(.reach) {
    background-color: var(--accent-soft);
    border-color: var(--accent);
  }

  .key :global(.party) {
    border: 2px solid var(--info);
    border-radius: 50%;
  }

  .key :global(.enemy) {
    border: 2px solid var(--bad);
  }

  .key :global(.active) {
    border: 2px solid var(--accent);
    border-radius: 50%;
  }

  .key :global(.down) {
    border: 2px solid var(--ink-faint);
    border-radius: 50%;
    opacity: 0.5;
  }

  .key :global(.attack) {
    background-image: linear-gradient(
      45deg,
      transparent 0 44%,
      var(--accent) 44% 56%,
      transparent 56% 100%
    );
  }

  .key :global(.down)::after {
    content: '';
    position: absolute;
    left: -2px;
    right: -2px;
    top: 50%;
    border-top: 1px solid var(--ink);
    transform: rotate(-45deg);
  }

  .features {
    list-style: none;
    margin: 0.35rem 0 0;
    padding: 0;
    font-size: var(--t-13);
  }

  .features li {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    padding: 0.1rem 0;
  }

  .pin {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.05rem;
    height: 1.05rem;
    font-size: var(--t-12);
    color: var(--ground);
    background: var(--accent);
    border-radius: 50%;
  }

  .fname {
    font-weight: 500;
  }

  .foot {
    margin: 0.35rem 0 0;
    text-transform: none;
    letter-spacing: 0;
  }
</style>
