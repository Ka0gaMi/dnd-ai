// The resume briefing's one token envelope: sections fill tier by tier, must-act first, and a section that does
// not fit keeps its heading, loses lines from its least important end and says how many with a "+N more" line.
import { BRIEFING_ENVELOPE, estimateTokens } from './token-budget.js';

/** Never trimmed: what the DM has to act on, and the frame they narrate in. */
export const MUST_ACT = 0;
/** What is around the party and the story it stands in. */
export const NEAR_PARTY = 1;
/** Counts and background, each trimmed section pointing at the read that shows the rest. */
export const BACKGROUND = 2;

export interface BriefingSection {
  tier: typeof MUST_ACT | typeof NEAR_PARTY | typeof BACKGROUND;
  /** Always shown: the blank separator, the heading and any empty-state line. */
  head: string[];
  /** The lines the allocator may trim, in display order. */
  items?: string[];
  /** The read that shows trimmed items, e.g. `world {op: get}`; left out where none exists. */
  more?: string;
  /** For lists that run oldest first, so the oldest items go first. */
  oldestFirst?: boolean;
  /** Joins the items onto one line with this separator. */
  inline?: string;
  /** A token cap on this section alone. */
  cap?: number;
}

function render(section: BriefingSection, shown: number): string[] {
  const items = section.items ?? [];
  const kept = section.oldestFirst ? items.slice(items.length - shown) : items.slice(0, shown);
  const body = section.inline === undefined ? kept : kept.length > 0 ? [kept.join(section.inline)] : [];
  const cut = items.length - shown;
  const tail = cut > 0 ? [`+${cut} more${section.more ? ` — ${section.more}` : ''}`] : [];
  return [...section.head, ...body, ...tail];
}

/** Tokens a section adds to the joined text, its joining newline included. */
const cost = (section: BriefingSection, shown: number): number => estimateTokens(`${render(section, shown).join('\n')}\n`);

/**
 * Renders the sections in their order within `budget` tokens. Each trimmable section first reserves its heading and
 * "+N more" line, then the tiers fill in turn, one item per section per round, so each keeps its most important items.
 */
export function allocateBriefing(sections: BriefingSection[], budget = BRIEFING_ENVELOPE): string {
  const shown = sections.map((section) => (section.tier === MUST_ACT ? (section.items?.length ?? 0) : 0));
  let room = budget - sections.reduce((sum, section, index) => sum + cost(section, shown[index]!), 0);
  for (const tier of [NEAR_PARTY, BACKGROUND]) {
    let grew = true;
    while (grew) {
      grew = false;
      sections.forEach((section, index) => {
        const count = shown[index]!;
        if (section.tier !== tier || count === (section.items?.length ?? 0)) return;
        const grow = cost(section, count + 1) - cost(section, count);
        const capped = section.cap !== undefined && estimateTokens(render(section, count + 1).join('\n')) > section.cap;
        if (grow > room || capped) return;
        room -= grow;
        shown[index] = count + 1;
        grew = true;
      });
    }
  }
  return sections.flatMap((section, index) => render(section, shown[index]!)).join('\n');
}
