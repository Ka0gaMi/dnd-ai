// Scripted players for the self-playtest: each line answers sensibly whatever the DM just asked.
import { createCampaign, upsertQuests } from '../../src/core/campaign.js';
import { awardXp, createCharacter, createCompanion, levelUp, levelUpOptions, type LevelUpChoices } from '../../src/core/character.js';
import { upsertEntity } from '../../src/core/codex.js';
import { XP_THRESHOLDS } from '../../src/core/rules.js';
import { addAct, openChapter, setStoryOutline } from '../../src/core/story.js';
import type { Db } from '../../src/db/connection.js';

export interface Scenario {
  /** What a Claude player is told it wants from the session. */
  goal: string;
  /** The scripted player's messages, one per turn. */
  lines: string[];
  /** Builds a campaign in the run's database before the DM's first turn and returns its id; absent means the DM starts from nothing. */
  seed?: (db: Db) => number;
}

type Options = Partial<{
  subclass_choice: Array<{ name: string }>;
  ability_score_improvement: unknown;
  feature_choices: Array<{ feature: string; choose: number; from: string[] }>;
  spellcasting: { cantrips_to_add: number; spells_to_add: number; cantrip_options: string[]; spell_options: Record<string, string[]> };
}>;

/** Raises a character to `level` through the real XP and level-up path, taking the first legal pick wherever a choice is owed. */
function levelTo(db: Db, campaignId: number, characterId: number, level: number): void {
  const xp = () => (db.prepare('SELECT xp, level FROM character WHERE id = ?').get(characterId) as { xp: number; level: number });
  const owed = XP_THRESHOLDS[level - 1]! - xp().xp;
  if (owed > 0) awardXp(db, { campaign_id: campaignId, character_id: characterId, amount: owed });
  while (xp().level < level) {
    const options = levelUpOptions(db, campaignId, characterId) as Options;
    const choices: LevelUpChoices = { hp: 'average' };
    if (options.subclass_choice) choices.subclass = options.subclass_choice[0]!.name;
    if (options.ability_score_improvement) choices.ability_increases = { str: 1, con: 1 };
    if (options.feature_choices) {
      choices.feature_options = Object.fromEntries(options.feature_choices.map((spec) => [spec.feature, spec.from.slice(0, spec.choose)]));
    }
    const cast = options.spellcasting;
    if (cast?.cantrips_to_add) choices.cantrips = cast.cantrip_options.slice(0, cast.cantrips_to_add);
    if (cast?.spells_to_add) {
      const pool = Object.values(cast.spell_options).flat();
      choices.spells = pool.slice(0, cast.spells_to_add);
    }
    levelUp(db, { campaign_id: campaignId, character_id: characterId, choices });
  }
}

/** A sandbox campaign with a human Fighter PC and a cleric companion, both at `level`, standing at `location`. */
function seedParty(
  db: Db,
  o: { name: string; premise: string; level: number; location: string; place: string; placeSummary: string; quest: { title: string; summary: string; steps: string[] }; ending: string; secret: string },
): number {
  const { campaign_id } = createCampaign(db, { name: o.name, story_shape: 'sandbox', premise: o.premise });
  const pc = createCharacter(db, {
    campaign_id,
    name: 'Bram',
    species: 'Human',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception', 'insight'],
  }).character!;
  const { companion } = createCompanion(db, {
    campaign_id,
    name: 'Sister Elowen',
    source: { class: 'Cleric', species: 'Human', background: 'Acolyte' },
    personality: 'Calm and dry-witted; keeps the party patched up and alive.',
  });
  levelTo(db, campaign_id, pc.id, o.level);
  levelTo(db, campaign_id, companion!.id, o.level);
  setStoryOutline(db, { campaign_id, premise: o.premise, ending: o.ending, secret_notes: o.secret });
  addAct(db, { campaign_id, title: 'Act 1', goal: o.quest.summary });
  openChapter(db, { campaign_id, title: o.quest.title, goal: o.quest.summary });
  upsertEntity(db, { campaign_id, kind: 'place', name: o.place, summary: o.placeSummary });
  upsertQuests(db, campaign_id, [
    { title: o.quest.title, kind: 'main', summary: o.quest.summary, steps: o.quest.steps.map((text) => ({ text })) },
  ]);
  const session = db.prepare('SELECT current_session_id AS id FROM campaign WHERE id = ?').get(campaign_id) as { id: number };
  const scene = db
    .prepare('INSERT INTO scene (session_id, campaign_id, location_name, started_at) VALUES (?, ?, ?, ?)')
    .run(session.id, campaign_id, o.location, new Date().toISOString());
  db.prepare('UPDATE campaign SET current_scene_id = ? WHERE id = ?').run(Number(scene.lastInsertRowid), campaign_id);
  return campaign_id;
}

export const SCENARIOS: Record<string, Scenario> = {
  ambush: {
    goal: 'continue the story already under way; fight whatever attacks you to the end, then take a short rest and ask the DM to save.',
    seed: (db) =>
      seedParty(db, {
        name: 'The Millbrook Road',
        premise: 'Bram the Fighter and Sister Elowen the cleric carry a sealed tithe of silver from Millbrook to the abbey at Ashford, along a forest road that has gone dangerous.',
        level: 3,
        location: 'The Ashford road, a forest road at dusk',
        place: 'The Ashford road',
        placeSummary: 'A rutted forest road through old oak woods, a day from Millbrook; travellers have gone missing near its narrow cutting.',
        quest: {
          title: 'Deliver the tithe to Ashford Abbey',
          summary: 'Carry the sealed tithe of silver safely to the abbot before the new moon.',
          steps: ['Get through the forest road', 'Reach Ashford Abbey'],
        },
        ending: 'The tithe arrives, or the road claims it.',
        secret: 'A bandit crew led by a deserter waits in the cutting; wolves have been driven out of the deep wood and hunt near the road.',
      }),
    lines: [
      "Let's continue - we're on the forest road to Ashford at dusk with the tithe. Bram keeps a hand on his sword and watches the treeline.",
      'Bram stays alert and moves on slowly along the road with Sister Elowen beside him.',
      'Bram draws his sword and attacks the nearest enemy.',
      'Bram keeps fighting, attacking the closest enemy that is still standing.',
      'Bram attacks again; if the fight is over, he checks that Elowen is alright.',
      'If anyone is still fighting, Bram strikes the nearest one; otherwise he searches the fallen and the road.',
      'Bram asks Elowen to tend the worst wounds, and they take a short rest to catch their breath.',
      "Let's stop here for today. Please save the game so we can pick it up next time.",
    ],
  },
  dungeon: {
    goal: 'continue the story already under way; explore the ruin, get past the locked door and the trap, fight the creature in its lair, take a long rest and ask the DM to save.',
    seed: (db) =>
      seedParty(db, {
        name: 'The Sunken Chapel',
        premise: 'Bram the Fighter and Sister Elowen the cleric are exploring a collapsed hillside chapel to recover a stolen reliquary.',
        level: 5,
        location: 'The ruined chapel above Thornhill, entrance hall',
        place: 'The Sunken Chapel',
        placeSummary: 'A half-collapsed stone chapel: a barred oak door to the crypt stairs, a pressure-plate corridor, and a lair beyond.',
        quest: {
          title: 'Recover the stolen reliquary',
          summary: 'Find the reliquary taken from Thornhill and bring it back.',
          steps: ['Get through the locked crypt door', 'Cross the trapped corridor', 'Deal with whatever nests in the crypt'],
        },
        ending: 'The reliquary is home, or lost in the dark.',
        secret: 'The crypt door is locked (DC 15 to pick or force); the corridor beyond has a hidden pressure plate (DC 14 to spot); a monster lair holds the reliquary.',
      }),
    lines: [
      "Let's continue - we're in the entrance hall of the Sunken Chapel. Bram looks around carefully. What do we see?",
      'Bram goes to the locked door to the crypt stairs and tries to open it, picking the lock or forcing it as the DM sees fit.',
      'Bram moves on down the corridor beyond, checking the floor for traps as he goes.',
      'Bram carries on carefully towards the lair at the end.',
      'Bram draws his sword and attacks the nearest enemy.',
      'Bram keeps fighting, attacking the closest enemy that is still standing.',
      'Bram attacks again; if the fight is over, he checks on Elowen and searches the lair.',
      'Bram and Elowen settle in the cleared crypt and take a long rest.',
      "Let's stop here for today. Please save the game so we can pick it up next time.",
    ],
  },
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
