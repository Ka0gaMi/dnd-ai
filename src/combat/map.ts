// The battle grid: 5 ft cells, '.' open, '~' difficult, '#' blocked, plus labelled features.
export type Terrain = 'forest' | 'cave' | 'road' | 'ruins' | 'interior';
export type MapSize = 'small' | 'medium' | 'large';
export type Cell = '.' | '~' | '#';

export interface MapFeature {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: string;
  label: string;
}

export interface BattleMap {
  w: number;
  h: number;
  rows: string[];
  features: MapFeature[];
}

export interface MapOptions {
  terrain: Terrain;
  size?: MapSize;
  features?: string[];
}

const DIMENSIONS: Record<MapSize, { w: number; h: number }> = {
  small: { w: 14, h: 10 },
  medium: { w: 20, h: 14 },
  large: { w: 28, h: 20 },
};

/** How much of the map each terrain covers in blocked and difficult clumps, and its default features. */
const PROFILES: Record<Terrain, { blocked: number; difficult: number; walled: boolean; features: string[] }> = {
  forest: { blocked: 0.07, difficult: 0.14, walled: false, features: ['thicket'] },
  cave: { blocked: 0.1, difficult: 0.08, walled: true, features: ['pillars'] },
  road: { blocked: 0.03, difficult: 0.08, walled: false, features: ['road'] },
  ruins: { blocked: 0.08, difficult: 0.1, walled: false, features: ['rubble', 'pillars'] },
  interior: { blocked: 0.05, difficult: 0.03, walled: true, features: ['pillars'] },
};

/** The two columns on each edge stay open so both sides always have somewhere to deploy. */
export const DEPLOY_COLUMNS = 2;

/** Deterministic PRNG (mulberry32) so one seed always yields one map. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function cellAt(map: BattleMap, x: number, y: number): Cell {
  if (x < 0 || y < 0 || x >= map.w || y >= map.h) return '#';
  return (map.rows[y]?.[x] ?? '#') as Cell;
}

export const isBlocked = (map: BattleMap, x: number, y: number): boolean => cellAt(map, x, y) === '#';
export const isDifficult = (map: BattleMap, x: number, y: number): boolean => cellAt(map, x, y) === '~';

/** Seeded, deterministic: open ground with clumps of cover, then the named features drawn on top. */
export function generateBattleMap(seed: number, options: MapOptions): BattleMap {
  const { w, h } = DIMENSIONS[options.size ?? 'medium'];
  const profile = PROFILES[options.terrain];
  const rng = seededRandom(seed + options.terrain.length * 977 + w * 31 + h);
  const grid: Cell[][] = Array.from({ length: h }, () => Array.from({ length: w }, () => '.' as Cell));

  const set = (x: number, y: number, cell: Cell): void => {
    if (x >= 0 && y >= 0 && x < w && y < h) grid[y]![x] = cell;
  };

  if (profile.walled) {
    for (let x = 0; x < w; x += 1) {
      set(x, 0, '#');
      set(x, h - 1, '#');
    }
    for (let y = 0; y < h; y += 1) {
      set(0, y, '#');
      set(w - 1, y, '#');
    }
  }

  const clump = (cell: Cell, target: number): void => {
    let placed = 0;
    let guard = 0;
    while (placed < target && guard++ < target * 40) {
      const cx = Math.floor(rng() * w);
      const cy = Math.floor(rng() * h);
      const radius = 1 + Math.floor(rng() * 2);
      for (let y = cy - radius; y <= cy + radius; y += 1) {
        for (let x = cx - radius; x <= cx + radius; x += 1) {
          if (rng() < 0.45) continue;
          if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
          if (grid[y]![x] !== '.') continue;
          grid[y]![x] = cell;
          placed += 1;
        }
      }
    }
  };

  clump('#', Math.round(w * h * profile.blocked));
  clump('~', Math.round(w * h * profile.difficult));

  const features: MapFeature[] = [];
  for (const name of options.features ?? profile.features) {
    const feature = drawFeature(name, { w, h }, rng, set);
    if (feature) features.push(feature);
  }

  // Keep the deployment strips and the walled map's inner ring clear enough to stand in.
  for (let y = profile.walled ? 1 : 0; y < (profile.walled ? h - 1 : h); y += 1) {
    for (let d = 0; d < DEPLOY_COLUMNS; d += 1) {
      set(profile.walled ? 1 + d : d, y, '.');
      set(profile.walled ? w - 2 - d : w - 1 - d, y, '.');
    }
  }

  return { w, h, rows: grid.map((row) => row.join('')), features };
}

/** Each named feature paints its cells and returns its bounding box for the UI to label. */
function drawFeature(
  name: string,
  size: { w: number; h: number },
  rng: () => number,
  set: (x: number, y: number, cell: Cell) => void,
): MapFeature | null {
  const kind = name.trim().toLowerCase();
  const { w, h } = size;
  const label = kind.charAt(0).toUpperCase() + kind.slice(1);
  const mid = Math.floor(h / 2);

  if (kind === 'river') {
    const x = Math.floor(w / 2) + (rng() < 0.5 ? -1 : 1);
    for (let y = 0; y < h; y += 1) {
      set(x, y, '~');
      set(x + 1, y, '~');
    }
    return { x, y: 0, w: 2, h, kind, label: 'River (difficult terrain)' };
  }
  if (kind === 'road') {
    for (let x = 0; x < w; x += 1) {
      set(x, mid, '.');
      set(x, mid + 1, '.');
    }
    return { x: 0, y: mid, w, h: 2, kind, label: 'Road (open ground)' };
  }
  if (kind === 'pillars') {
    const step = 4;
    for (let y = 2; y < h - 2; y += step) {
      for (let x = 4; x < w - 4; x += step) set(x, y, '#');
    }
    return { x: 4, y: 2, w: w - 8, h: h - 4, kind, label: 'Pillars (full cover)' };
  }
  if (kind === 'fire' || kind === 'rubble' || kind === 'thicket') {
    const x = 3 + Math.floor(rng() * Math.max(1, w - 8));
    const y = 1 + Math.floor(rng() * Math.max(1, h - 4));
    for (let dy = 0; dy < 2; dy += 1) for (let dx = 0; dx < 3; dx += 1) set(x + dx, y + dy, '~');
    const labels: Record<string, string> = {
      fire: 'Burning ground (difficult terrain)',
      rubble: 'Rubble (difficult terrain)',
      thicket: 'Thicket (difficult terrain)',
    };
    return { x, y, w: 3, h: 2, kind, label: labels[kind]! };
  }
  if (kind === 'wall') {
    const y = 2 + Math.floor(rng() * Math.max(1, h - 4));
    const x = Math.floor(w / 3);
    for (let dx = 0; dx < Math.floor(w / 3); dx += 1) set(x + dx, y, '#');
    return { x, y, w: Math.floor(w / 3), h: 1, kind, label: 'Wall (blocks movement and sight)' };
  }
  // Anything else the DM names becomes a labelled patch of difficult ground.
  const x = 2 + Math.floor(rng() * Math.max(1, w - 6));
  const y = 1 + Math.floor(rng() * Math.max(1, h - 3));
  for (let dy = 0; dy < 2; dy += 1) for (let dx = 0; dx < 2; dx += 1) set(x + dx, y + dy, '~');
  return { x, y, w: 2, h: 2, kind, label: `${label} (difficult terrain)` };
}
