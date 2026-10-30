// Scripted players for the self-playtest: each line answers sensibly whatever the DM just asked.

export interface Scenario {
  /** What a Claude player is told it wants from the session. */
  goal: string;
  /** The scripted player's messages, one per turn. */
  lines: string[];
}

export const SCENARIOS: Record<string, Scenario> = {
  'first-session': {
    goal: 'start a brand-new story, make a simple character, look around, get into one fight, rest, then save and stop.',
    lines: [
      "Hi! I'm new to D&D. I'd like to start a brand-new story, please.",
      "Something classic: a small town with a mystery and a bit of danger, not too grim. I have no lines or veils, and anything you haven't asked about, you choose.",
      "Let's make a simple character: a human fighter called Bram, standard array, and pick sensible options for anything else. If you need more from me, go with what you think suits a beginner.",
      "That sounds good to me, go ahead with it.",
      'Bram looks around. What does he see and who is nearby?',
      'Bram walks over to whoever seems to know what is going on and asks what the trouble is.',
      "Bram heads off to look into the trouble himself, keeping his eyes open.",
      'Bram draws his sword and attacks the nearest enemy.',
      'Bram keeps fighting, attacking the closest enemy that is still standing.',
      'If the fight is still going, Bram attacks again; if it is over, he checks the bodies and the area.',
      'Bram takes a short rest to catch his breath and patch himself up.',
      "Let's stop here for today. Please save the game so we can pick it up next time.",
    ],
  },
};

/** Yields the scenario's lines, at most `max` of them. */
export function* scriptedTurns(name: string, max: number): Generator<string> {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`Unknown scenario "${name}"; known: ${Object.keys(SCENARIOS).join(', ')}`);
  yield* scenario.lines.slice(0, max);
}
