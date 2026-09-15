// Cover, sight and range between two combatants: one request per pair, thrown away as the fight moves.
export interface Tactics {
  distance_ft: number;
  line_of_sight: boolean;
  cover: 'none' | 'half' | 'three-quarters' | 'total';
  in_reach: boolean;
  in_range: { normal: boolean; long: boolean } | null;
  path_cost_ft: number | null;
}

const COVER_WORDS: Record<string, string> = {
  none: 'no cover',
  half: 'half cover',
  'three-quarters': 'three-quarters cover',
  total: 'total cover',
};

function rangeWord(tactics: Tactics): string {
  if (tactics.in_reach) return 'in reach';
  if (!tactics.in_range) return 'no weapon to measure';
  if (tactics.in_range.normal) return 'in range';
  return tactics.in_range.long ? 'at long range (disadvantage)' : 'out of range';
}

/** The tooltip line: "45 ft · line of sight · half cover · in range". */
export function tacticsLine(tactics: Tactics): string {
  return [
    `${tactics.distance_ft} ft`,
    tactics.line_of_sight ? 'line of sight' : 'no line of sight',
    COVER_WORDS[tactics.cover] ?? tactics.cover,
    rangeWord(tactics),
  ].join(' · ');
}

const pairKey = (from: number, to: number): string => `${from}>${to}`;

/** Answers per pair, kept only while the fight state they were measured in still stands. */
export class TacticsCache {
  private version = -1;
  private entries = new Map<string, Tactics>();
  private inflight = new Map<string, Promise<Tactics | null>>();

  cached(version: number, from: number, to: number): Tactics | null {
    this.checkVersion(version);
    return this.entries.get(pairKey(from, to)) ?? null;
  }

  /** Asks `load` at most once per pair per fight state; a failed lookup simply answers null. */
  async lookup(
    version: number,
    from: number,
    to: number,
    load: (from: number, to: number) => Promise<Tactics>,
  ): Promise<Tactics | null> {
    this.checkVersion(version);
    const key = pairKey(from, to);
    const known = this.entries.get(key);
    if (known) return known;
    const running = this.inflight.get(key);
    if (running) return running;
    const request = load(from, to)
      .then((tactics) => {
        if (this.version === version) this.entries.set(key, tactics);
        return tactics;
      })
      .catch(() => null)
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }

  private checkVersion(version: number): void {
    if (version === this.version) return;
    this.version = version;
    this.entries.clear();
  }
}
