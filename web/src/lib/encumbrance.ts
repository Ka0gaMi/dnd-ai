// Pure helpers for the carried-weight bar: colour, percentage and item weight labels.
import type { InventoryItem } from './types';

export type LoadTone = 'good' | 'warn' | 'bad';

export interface LoadBar {
  /** Width for the bar's fill, clamped to 100 even when over capacity. */
  percent: number;
  tone: LoadTone;
}

/** Under 80% of capacity is good, 80-100% is a warning, over capacity is bad. */
export function loadBar(carriedLb: number, capacityLb: number): LoadBar {
  const raw = capacityLb > 0 ? (carriedLb / capacityLb) * 100 : 0;
  const tone: LoadTone = raw > 100 ? 'bad' : raw >= 80 ? 'warn' : 'good';
  return { percent: Math.max(0, Math.min(100, raw)), tone };
}

/** The item's weight for its inventory row, or "—" when the DM never gave it one. */
export function itemWeightLabel(item: InventoryItem): string {
  if (item.weight_lb === undefined || item.notes?.toLowerCase().includes('weight unknown')) return '—';
  return `${item.weight_lb} lb`;
}
