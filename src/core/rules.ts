// Pure SRD 5.2.1 arithmetic: no database, no SRD files.

export type Ability = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
export type AbilityScores = Record<Ability, number>;

export const ABILITIES: Ability[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

/** The thirteen SRD damage types, for the features that ask a player to choose one. */
export const DAMAGE_TYPES = [
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic',
  'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder',
];

export const SKILL_ABILITY: Record<string, Ability> = {
  acrobatics: 'dex',
  animal_handling: 'wis',
  arcana: 'int',
  athletics: 'str',
  deception: 'cha',
  history: 'int',
  insight: 'wis',
  intimidation: 'cha',
  investigation: 'int',
  medicine: 'wis',
  nature: 'int',
  perception: 'wis',
  performance: 'cha',
  persuasion: 'cha',
  religion: 'int',
  sleight_of_hand: 'dex',
  stealth: 'dex',
  survival: 'wis',
};

export const SKILL_KEYS = Object.keys(SKILL_ABILITY);

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
export const POINT_BUY_BUDGET = 27;
const POINT_BUY_COST: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };

/** XP needed for each level, SRD 5.2.1 "Character Advancement". Index 0 is level 1. */
export const XP_THRESHOLDS = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000,
  265000, 305000, 355000,
];

/** The ceiling an ability score meets: 20 for improvements and feats, 30 for an Epic Boon. */
export const ABILITY_MAX = 20;
export const EPIC_ABILITY_MAX = 30;

export const abilityMod = (score: number): number => Math.floor((score - 10) / 2);

export const proficiencyBonus = (level: number): number => 2 + Math.floor((level - 1) / 4);

export function levelForXp(xp: number): number {
  let level = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i += 1) if (xp >= XP_THRESHOLDS[i]!) level = i + 1;
  return level;
}

export function pointBuyCost(scores: AbilityScores): number {
  let total = 0;
  for (const ability of ABILITIES) {
    const cost = POINT_BUY_COST[scores[ability]];
    if (cost === undefined) throw new Error(`Point buy needs every score between 8 and 15; ${ability} is ${scores[ability]}.`);
    total += cost;
  }
  return total;
}

/** Throws with a message the DM can read out when the assignment breaks the chosen method. */
export function validateAbilities(method: 'standard_array' | 'point_buy' | 'manual', scores: AbilityScores): void {
  const values = ABILITIES.map((a) => scores[a]);
  if (method === 'standard_array') {
    const sorted = [...values].sort((a, b) => b - a);
    if (sorted.join(',') !== STANDARD_ARRAY.join(',')) {
      throw new Error(
        `The standard array must use each of 15, 14, 13, 12, 10, 8 exactly once. Got ${values.join(', ')} (str, dex, con, int, wis, cha).`,
      );
    }
    return;
  }
  if (method === 'point_buy') {
    const cost = pointBuyCost(scores);
    if (cost > POINT_BUY_BUDGET) {
      throw new Error(`Point buy allows ${POINT_BUY_BUDGET} points; this assignment costs ${cost}.`);
    }
    return;
  }
  for (const ability of ABILITIES) {
    const score = scores[ability];
    if (!Number.isInteger(score) || score < 3 || score > 18) {
      throw new Error(`Manual scores must be whole numbers from 3 to 18; ${ability} is ${score}.`);
    }
  }
}

export interface ArmorPiece {
  base: number;
  dex_bonus: boolean;
  max_bonus?: number;
}

/** 10 + DEX unarmoured; otherwise the armour's formula, plus 2 for a shield. */
export function armorClass(dexMod: number, armor: ArmorPiece | null, shield: boolean, unarmoredBonus = 0): number {
  const shieldBonus = shield ? 2 : 0;
  if (!armor) return 10 + dexMod + unarmoredBonus + shieldBonus;
  const dex = armor.dex_bonus ? (armor.max_bonus === undefined ? dexMod : Math.min(dexMod, armor.max_bonus)) : 0;
  return armor.base + dex + shieldBonus;
}

/** 2024 carrying capacity: STR score x 15 lb, and 5 ft of movement once the pack is heavier than that. */
export const CARRY_PER_STR = 15;
export const ENCUMBERED_SPEED = 5;

export interface Load {
  carried_lb: number;
  capacity_lb: number;
  over: boolean;
}

interface WeighedItem {
  qty?: number;
  weight_lb?: number;
  container?: { weightless_contents?: boolean; contents?: WeighedItem[] };
}

/** What a pile of items weighs, a container's contents included unless the container carries them free. */
export function itemsWeight(items: unknown): number {
  const list = Array.isArray(items) ? (items as WeighedItem[]) : [];
  return list.reduce((sum, item) => {
    const inside = item.container?.weightless_contents ? 0 : itemsWeight(item.container?.contents);
    return sum + (item.weight_lb ?? 0) * (item.qty ?? 1) + inside;
  }, 0);
}

/** What the character is carrying against what they can carry; an item without a weight counts as 0. */
export function carriedLoad(inventory: unknown, strScore: number): Load {
  const carried = Math.round(itemsWeight(inventory) * 100) / 100;
  const capacity = strScore * CARRY_PER_STR;
  return { carried_lb: carried, capacity_lb: capacity, over: carried > capacity };
}

// --- coins -------------------------------------------------------------------

export type Coin = 'cp' | 'sp' | 'ep' | 'gp' | 'pp';
/** Smallest first: every coin routine walks the purse in this order. */
export const COINS: Coin[] = ['cp', 'sp', 'ep', 'gp', 'pp'];
/** 2024 rates: 10 cp = 1 sp, 5 sp = 1 ep, 2 ep = 1 gp, 10 gp = 1 pp, all in copper. */
export const COIN_CP: Record<Coin, number> = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 };

export type Coins = Record<Coin, number>;

/** Change is never handed out in electrum: the 2024 rules keep the coin but nobody mints it. */
const CHANGE_COINS: Coin[] = ['cp', 'sp', 'gp', 'pp'];

export const emptyCoins = (): Coins => ({ cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 });

export const coinsCp = (coins: Coins): number => COINS.reduce((sum, coin) => sum + coins[coin] * COIN_CP[coin], 0);

/** The purse as the gold column has always held it: its whole value in gp, rounded down. */
export const coinsGp = (coins: Coins): number => Math.floor(coinsCp(coins) / COIN_CP.gp);

/** Copper split into the fewest coins, largest first. */
export function coinsFromCp(total: number): Coins {
  const out = emptyCoins();
  let left = total;
  for (const coin of [...CHANGE_COINS].reverse()) {
    out[coin] = Math.floor(left / COIN_CP[coin]);
    left -= out[coin] * COIN_CP[coin];
  }
  return out;
}

export const addCoins = (purse: Coins, delta: Partial<Coins>): Coins => {
  const out = { ...purse };
  for (const coin of COINS) out[coin] += delta[coin] ?? 0;
  return out;
};

/**
 * Makes change for a purse a denomination has gone short in: breaks bigger coins down a step at a time,
 * and pools the smaller ones when nothing bigger is left. Null when the purse is simply short of value.
 */
export function settleCoins(purse: Coins): Coins | null {
  const out = { ...purse };
  if (coinsCp(out) < 0) return null;
  for (;;) {
    const short = COINS.find((coin) => out[coin] < 0);
    if (!short) return out;
    const bigger = COINS.slice(COINS.indexOf(short) + 1).find((coin) => out[coin] > 0);
    if (bigger) {
      out[bigger] -= 1;
      out[short] += COIN_CP[bigger] / COIN_CP[short];
      continue;
    }
    const smaller = COINS.slice(0, COINS.indexOf(short));
    let pooled = 0;
    for (const coin of smaller) {
      pooled += out[coin] * COIN_CP[coin];
      out[coin] = 0;
    }
    const owed = -out[short] * COIN_CP[short];
    if (pooled < owed) return null;
    out[short] = 0;
    let left = pooled - owed;
    for (const coin of [...CHANGE_COINS].reverse()) {
      if (COIN_CP[coin] >= COIN_CP[short]) continue;
      out[coin] = Math.floor(left / COIN_CP[coin]);
      left -= out[coin] * COIN_CP[coin];
    }
  }
}

/** The purse in words, largest coin first, e.g. "2 gp, 5 sp"; "nothing" for an empty one. */
export function coinsText(coins: Coins): string {
  const parts = [...COINS].reverse().filter((coin) => coins[coin] !== 0).map((coin) => `${coins[coin]} ${coin}`);
  return parts.length ? parts.join(', ') : 'nothing';
}
