// What each living-world pacing style allows. Pure data: no dice, no state.
export type StorytellerStyle = 'off' | 'calm' | 'steady' | 'chaotic';

export interface StorytellerCaps {
  events_per_day: number;
  quiet_days_after_major: number;
  major_severity: number;
  threat_scale: number;
}

export const STORYTELLER_CAPS: Record<Exclude<StorytellerStyle, 'off'>, StorytellerCaps> = {
  calm: { events_per_day: 1, quiet_days_after_major: 7, major_severity: 4, threat_scale: 0.5 },
  steady: { events_per_day: 2, quiet_days_after_major: 4, major_severity: 4, threat_scale: 1 },
  chaotic: { events_per_day: 4, quiet_days_after_major: 1, major_severity: 5, threat_scale: 1.5 },
};

/** The caps for a style, or null when the world is frozen ('off'). */
export function storytellerCaps(style: StorytellerStyle): StorytellerCaps | null {
  return style === 'off' ? null : STORYTELLER_CAPS[style];
}
