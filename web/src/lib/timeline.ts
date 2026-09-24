/** One living-world event the party has heard about, dated by the campaign clock. */
export interface TimelineEntry {
  id: number;
  day: number;
  days_ago: number;
  text: string;
}

/** The entity's timeline, oldest first; empty when the party has heard nothing. */
export async function getTimeline(campaignId: number, entityId: number): Promise<TimelineEntry[]> {
  const path = `/api/campaigns/${campaignId}/entities/${entityId}/timeline`;
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return ((await res.json()) as { timeline: TimelineEntry[] }).timeline;
}

/** Reads a day count back as words for the timeline's muted stamp. */
export function agoLabel(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? 'about a month ago' : `about ${months} months ago`;
}
