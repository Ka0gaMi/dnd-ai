// Pure helpers for the inventory list: row keys, nesting, magic badges and the purse line.
import type { Coins, InventoryItem } from './types';

/** Two items called "Dagger" keyed alike blank the whole list, so the id comes first and the index last. */
export const itemKey = (item: InventoryItem, index: number): string => item.id ?? `${item.name ?? ''}-${index}`;

export interface FlatItem {
  item: InventoryItem;
  /** 0 for a carried item, 1 for what is inside a container, and so on. */
  depth: number;
  key: string;
}

/** The inventory as one list, a container followed by what it holds. */
export function flatItems(items: InventoryItem[] | null | undefined, depth = 0, prefix = ''): FlatItem[] {
  return (items ?? []).flatMap((item, index) => {
    const key = `${prefix}${itemKey(item, index)}`;
    return [{ item, depth, key }, ...flatItems(item.container?.contents, depth + 1, `${key}/`)];
  });
}

export interface ItemBadge {
  text: string;
  /** The rulesHelp key the badge hangs a tooltip off, where there is one. */
  help?: string;
}

const words = (value: string): string => value.replace(/_/g, ' ');

/** The compact badges after an item's name; a masked item carries no magic block and gets none. */
export function itemBadges(item: InventoryItem): ItemBadge[] {
  const badges: ItemBadge[] = [];
  const magic = item.magic;
  if (magic) {
    if (magic.rarity) badges.push({ text: words(magic.rarity) });
    if (magic.bonus) badges.push({ text: `+${magic.bonus}` });
    if (magic.attuned) badges.push({ text: 'attuned', help: 'attunement' });
    else if (magic.attunement) badges.push({ text: 'needs attunement', help: 'attunement' });
    if (magic.charges) {
      const { current = 0, max = 0, recharge } = magic.charges;
      badges.push({ text: `${current}/${max}${recharge ? ` · ${words(recharge)}` : ''}`, help: 'magic_charges' });
    }
  }
  const container = item.container;
  if (container) {
    badges.push({ text: `holds ${container.contents?.length ?? 0} items` });
    if (container.weightless_contents) badges.push({ text: 'weightless' });
  }
  return badges;
}

/** Largest coin first; a denomination at zero is left out, electrum included. */
const COIN_ORDER: Array<keyof Coins> = ['pp', 'gp', 'ep', 'sp', 'cp'];

/** "12 pp · 40 gp · 3 sp · 7 cp": the purse under its gold total, or null when there is nothing to add. */
export function purseLine(coins: Coins | null | undefined): string | null {
  if (!coins) return null;
  const parts = COIN_ORDER.filter((coin) => (coins[coin] ?? 0) !== 0).map((coin) => `${coins[coin]} ${coin}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}
