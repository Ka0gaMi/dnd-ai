// Scripted players for the self-playtest: each line answers sensibly whatever the DM just asked.
import { readFileSync } from 'node:fs';
import { addCanonFact, createCampaign, endSession, saveCheckpoint, upsertQuests } from '../../src/core/campaign.js';
import {
  adjustGold,
  awardXp,
  createCharacter,
  createCompanion,
  levelUp,
  levelUpOptions,
  type LevelUpChoices,
} from '../../src/core/character.js';
import { upsertEntity } from '../../src/core/codex.js';
import { XP_THRESHOLDS } from '../../src/core/rules.js';
import { importRegion } from '../../src/core/region.js';
import {
  addAct,
  addPlotThread,
  addRumour,
  openChapter,
  plantClue,
  setStoryOutline,
  type RumourScope,
  type RumourTruth,
} from '../../src/core/story.js';
import { ensureWorld } from '../../src/core/world-seed.js';
import type { Db } from '../../src/db/connection.js';

export interface Scenario {
  /** What a Claude player is told it wants from the session. */
  goal: string;
  /** Longer aims a Claude player pursues in character across the run; the scripted player ignores them. */
  playerBrief?: string;
  /** Turns per game session: each break saves, ends, and resumes in a fresh DM session. */
  sessionEvery?: number;
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

/** A sandbox campaign with a human Fighter PC and, unless `alone`, a cleric companion, all at `level`, standing at `location`; with `home`, on the region map. */
function seedParty(
  db: Db,
  o: { name: string; premise: string; level: number; alone?: boolean; location: string; place: string; placeSummary: string; quest: { title: string; summary: string; steps: string[] }; ending: string; secret: string; home?: { town: string; from: string } },
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
  const companion = o.alone
    ? null
    : createCompanion(db, {
        campaign_id,
        name: 'Sister Elowen',
        source: { class: 'Cleric', species: 'Human', background: 'Acolyte' },
        personality: 'Calm and dry-witted; keeps the party patched up and alive.',
      }).companion;
  levelTo(db, campaign_id, pc.id, o.level);
  if (companion) levelTo(db, campaign_id, companion.id, o.level);
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
  if (o.home) seedRegion(db, campaign_id, o.home.town, o.home.from);
  return campaign_id;
}

type Rumour = [text: string, scope: RumourScope, truth: RumourTruth];

/** Adds codex entries, canon facts, rumours and extra quests on top of a seeded party. */
function seedExtras(
  db: Db,
  campaignId: number,
  x: {
    places?: Array<{ name: string; summary: string; hidden_notes?: string }>;
    npcs?: Array<{ name: string; summary: string; status?: 'alive' | 'dead'; hidden_notes?: string }>;
    factions?: Array<{ name: string; summary: string }>;
    facts?: Array<[subject: string, fact: string]>;
    rumours?: Rumour[];
    quests?: Array<{ title: string; kind: 'side' | 'personal'; summary: string; steps: string[] }>;
  },
): void {
  for (const p of x.places ?? []) upsertEntity(db, { campaign_id: campaignId, kind: 'place', ...p });
  for (const n of x.npcs ?? []) upsertEntity(db, { campaign_id: campaignId, kind: 'npc', ...n });
  for (const f of x.factions ?? []) upsertEntity(db, { campaign_id: campaignId, kind: 'faction', ...f });
  for (const [subject, fact] of x.facts ?? []) addCanonFact(db, { campaign_id: campaignId, subject, fact });
  for (const [text, scope, truth] of x.rumours ?? []) addRumour(db, { campaign_id: campaignId, text, scope, truth });
  if (x.quests) upsertQuests(db, campaignId, x.quests.map((q) => ({ ...q, steps: q.steps.map((text) => ({ text })) })));
}

/** Gives every party member the XP for their next level without taking it, so a level-up is owed. */
function owedLevelUp(db: Db, campaignId: number): void {
  const members = db.prepare('SELECT id, level, xp FROM character WHERE campaign_id = ?').all(campaignId) as Array<{ id: number; level: number; xp: number }>;
  for (const m of members) awardXp(db, { campaign_id: campaignId, character_id: m.id, amount: XP_THRESHOLDS[m.level]! - m.xp });
}

type RealmFixture = { hexes: Record<string, { town?: { name: string; link: string } }>; features: Array<{ name: string }> };

const REALM = JSON.parse(readFileSync(new URL('../../test/fixtures/realm-safe.json', import.meta.url), 'utf8')) as RealmFixture;

/** Imports the fixture region with its settlement `from` renamed to the scenario's home town, then seeds the living world. */
function seedRegion(db: Db, campaignId: number, town: string, from: string): void {
  const realm = structuredClone(REALM);
  const settlement = Object.values(realm.hexes).find((hex) => hex.town?.name === from)!.town!;
  settlement.name = town;
  settlement.link = settlement.link.replace(`name=${encodeURIComponent(from)}`, `name=${encodeURIComponent(town)}`);
  realm.features.find((feature) => feature.name === from)!.name = town;
  importRegion(db, campaignId, realm, { source: 'generated' });
  ensureWorld(db, campaignId);
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
        home: { town: 'Ashford', from: 'Hotfield' },
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
        home: { town: 'Thornhill', from: 'Stormcourtby' },
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
  resume: {
    goal: 'resume the saved campaign: get the DM to recap it, follow up a quest, ask about a faction, look for an NPC you think is alive, then ask for a scene save.',
    seed: (db) => {
      const id = seedParty(db, {
        name: 'The Lamplighter Debt',
        premise: 'Bram the Fighter and Sister Elowen the cleric are four sessions into a debt-and-intrigue campaign in Redham, where a missing ledger could topple the city council.',
        level: 4,
        location: 'Redham',
        place: 'Redham',
        placeSummary: 'A walled river city of tanners, ferrymen and rival guildhalls, run by a nervous council.',
        quest: {
          title: "Recover the Lamplighters' ledger",
          summary: "Find the stolen ledger of the Lamplighters' Guild before the council audit.",
          steps: ['Question the ferrymen at the docks', 'Trace the buyer who paid for the theft', 'Return the ledger to the guild'],
        },
        ending: 'The ledger surfaces, or the council falls to the audit.',
        secret: "Dame Verelda Strand stole the ledger to hide her own forged debts; the guild's treasurer is helping her.",
      });
      importRegion(db, id, REALM, { source: 'generated' });
      ensureWorld(db, id);
      seedExtras(db, id, {
        npcs: [
          { name: 'Magistrate Dorrin Halloway', summary: 'Anxious head of the Redham council; wants the audit quietly passed.' },
          { name: 'Brother Anselm Ruck', summary: 'Gruff river-shrine priest who feeds the poor and hears everything.' },
          { name: 'Pell Wickersham', summary: 'A cheerful fence working the dock market; sells information with the stolen goods.' },
          { name: 'Dame Verelda Strand', summary: 'A gracious noblewoman, patron of the Lamplighters.' },
          { name: 'Tobias Marrowgate', summary: 'The old ferryman who first told the party about the ledger.', status: 'dead' },
        ],
        facts: [
          ['Tobias Marrowgate', 'Tobias Marrowgate drowned when his ferry was cut loose in the night; the party found his body at the Brindle weir.'],
          ['Lamplighters', "The Lamplighters' Guild keeps the debts of half of Redham in one leather ledger."],
          ['Council audit', 'The council audit falls on the first day of the new moon.'],
          ['Redham', 'Redham is walled on three sides and open to the river on the fourth.'],
          ['South gate', 'The south gate closes at dusk except for guild couriers.'],
          ['Bram', 'Bram served as a sergeant before he left the army.'],
          ['Sister Elowen', 'Elowen carries a river-shrine token blessed by Brother Anselm Ruck.'],
          ['Pell Wickersham', 'Pell charges silver for rumours and gold for names.'],
          ['Brindle weir', 'The Brindle weir is a stone barrage two miles upriver from Redham.'],
          ['Dame Verelda Strand', 'Dame Verelda holds the mortgage on the Lamplighters guildhall.'],
          ['Magistrate Dorrin Halloway', 'Halloway has asked the party to keep the ledger out of the council chamber.'],
          ['Dock market', 'The dock market runs from dawn until the second bell.'],
          ['River shrine', 'The river shrine floods each spring and is rebuilt by the parish.'],
          ['Ferrymen', 'The ferrymen strike if any of them is arrested without a hearing.'],
          ['Coin', 'Redham mints its own copper pennies, worth half a standard copper piece.'],
          ['Party lodging', 'The party is lodged at the Slate Heron inn on Tanner Row.'],
          ['Slate Heron', 'The Slate Heron is kept by a retired boatwright and has a good cellar.'],
          ['Guild treasurer', "The Lamplighters' treasurer was seen at the weir the night Tobias died."],
          ['Ledger', 'The ledger is bound in green leather and locked with a brass clasp.'],
          ['Tanner Row', 'Tanner Row smells of lime and oak bark and is avoided by nobles.'],
        ],
        rumours: [
          ['The council has already burned a second copy of the guild accounts.', 'location', 'false'],
          ['Ferrymen say Tobias Marrowgate did not drown by accident.', 'location', 'true'],
          ['A lady of rank has been buying up river-warehouse debts.', 'region', 'true'],
          ['The river shrine bell rings by itself before floods.', 'location', 'twisted'],
          ['The Lamplighters plan to leave Redham for a rival city.', 'region', 'false'],
          ['Pell Wickersham knows who paid for the theft.', 'location', 'true'],
          ['A tax collector vanished on the north road last month.', 'region', 'true'],
          ['There is a vault under the guildhall that no one has opened in a century.', 'location', 'twisted'],
          ['Wolves have been seen at the weir at night.', 'location', 'false'],
          ['Grain prices will double by midwinter.', 'world', 'twisted'],
          ['A travelling preacher is stirring up the ferrymen.', 'region', 'true'],
          ['The magistrate sleeps with a sword beside his bed.', 'location', 'true'],
        ],
        quests: [
          { title: "Find who cut Tobias Marrowgate's ferry loose", kind: 'side', summary: 'Learn who killed the old ferryman and why.', steps: ['Examine the Brindle weir', 'Question the ferrymen'] },
          { title: "Settle the ferrymen's strike threat", kind: 'side', summary: 'Keep the river crews working until the audit passes.', steps: ["Meet the ferrymen's speaker", 'Offer them a fair hearing'] },
          { title: 'Feed the river shrine poor', kind: 'personal', summary: 'Help Brother Anselm Ruck stock the shrine larder before winter.', steps: ['Collect grain pledges', 'Deliver them to the shrine'] },
          { title: "Pell's stolen goods favour", kind: 'side', summary: 'Pell wants a crate recovered from a rival fence in return for a name.', steps: ['Find the rival fence', 'Bring the crate back'] },
          { title: 'Dine with the Halloway family', kind: 'side', summary: 'The magistrate has invited the party to dine and discuss the audit.', steps: ['Accept the invitation'] },
        ],
      });
      saveCheckpoint(db, {
        campaign_id: id,
        scene_title: 'The weir at night',
        scene_location: 'Redham',
        scene_summary: 'The party examined the Brindle weir, found Tobias Marrowgate drowned, and returned to the Slate Heron inn.',
      });
      endSession(db, { campaign_id: id });
      return id;
    },
    lines: [
      "Let's continue our campaign. Please load the saved game and remind us where we left off.",
      'What is going on in the world right now? Any news or rumours we should know about?',
      "Bram wants to press on with the hunt for the Lamplighters' ledger. What is the next step and where do we go?",
      'Bram asks around about the most powerful faction in the region: who are they and what do they want?',
      'Bram goes to find Tobias Marrowgate the ferryman to ask him what he saw at the weir.',
      'Bram looks for Brother Anselm Rook, the river priest, to ask for a blessing.',
      "Let's stop here for today. Please save a scene checkpoint so we can pick it up next time.",
    ],
  },
  town: {
    goal: 'arrive in the town, talk to two of its people, ask for rumours, take a quest, buy something, have the DM remember a deal, then rest at the inn and save.',
    seed: (db) => {
      const id = seedParty(db, {
        name: 'The Hollow Market',
        premise: 'Bram the Fighter and Sister Elowen the cleric arrive in Quillmere, a market town on a marsh causeway, looking for work and lodging.',
        level: 3,
        location: 'Quillmere market square',
        place: 'Quillmere',
        placeSummary: 'A marsh-edge market town of reed-roofed stalls, a causeway gate, and a tight-lipped watch.',
        quest: { title: 'Settle in at Quillmere', summary: 'Find lodging, learn the town, and find paying work.', steps: ['Find a place to sleep', 'Find paying work'] },
        ending: 'The party earns a place in Quillmere, or leaves it behind.',
        secret: "The Eelwrights' Compact is smuggling through the marsh and the watch captain is paid to look away.",
        home: { town: 'Quillmere', from: 'Redham' },
      });
      seedExtras(db, id, {
        npcs: [
          { name: 'Odalys Brannoch', summary: 'Warm, shrewd innkeeper of the Reed Lantern; knows every traveller.' },
          { name: 'Corvin Thackeray', summary: 'Burly smith who sells plain weapons and hard bargains.' },
          { name: 'Hesper Dunmow', summary: 'Weary watch captain who keeps the causeway gate.' },
          { name: 'Ildric Vane', summary: "Quillmere reeve and the town's quest giver; always short of capable hands." },
          { name: 'Tamsin Orrel', summary: 'Soft-spoken marsh herbalist.' },
        ],
        factions: [{ name: "The Eelwrights' Compact", summary: 'A guild of eel-trappers who control the marsh paths.' }],
        rumours: [
          ['Lights have been seen on the marsh after midnight.', 'location', 'true'],
          ['The reeve is paying silver to anyone who clears the Sallow Hollow.', 'location', 'true'],
          ['The watch captain takes bribes from the eel-trappers.', 'location', 'twisted'],
          ['A drowned bell rings under the mere at dusk.', 'location', 'false'],
          ['Traders say the causeway toll will double this autumn.', 'region', 'true'],
        ],
      });
      return id;
    },
    lines: [
      "Let's continue - we've just arrived in Quillmere's market square. Bram looks around. What do we see?",
      'Bram walks up to the innkeeper and asks about a room and what the town is like.',
      'Bram asks the watch captain what trouble the town has had lately.',
      'Bram asks anyone nearby for rumours and local gossip.',
      'Bram goes to the reeve and asks if there is paying work. He takes the job if it is fair.',
      'Bram buys a sturdy rope and a lantern from a stall or the smith.',
      'Bram strikes a deal with the innkeeper: a cheap room for a week in exchange for guarding the inn one night. Please remember this deal.',
      'Bram and Elowen take a room at the inn and rest the night.',
      "Let's stop here for today. Please save the game so we can pick it up next time.",
    ],
  },
  journey: {
    goal: 'travel from Greywater Crossing to Harrowgate, taking a short rest and a long rest on the way, deal with one small encounter, take your level-up, then end the session.',
    seed: (db) => {
      const id = seedParty(db, {
        name: 'The Winter Road',
        premise: "Bram the Fighter and Sister Elowen the cleric must reach Harrowgate before the first snow to deliver a physician's letter.",
        level: 3,
        location: 'Greywater Crossing, a ferry hamlet',
        place: 'Greywater Crossing',
        placeSummary: 'A ferry hamlet on a grey river; the road to Harrowgate starts at its east gate.',
        quest: {
          title: "Carry the physician's letter to Harrowgate",
          summary: 'Deliver the sealed letter to the physician in Harrowgate before the first snow.',
          steps: ['Cross the Whitlow Moor', 'Reach Harrowgate'],
        },
        ending: 'The letter arrives in time, or the snow closes the pass.',
        secret: 'A small pack of starved wolves haunts the Whitlow Moor and attacks a camp at night.',
        home: { town: 'Greywater Crossing', from: 'Southern Landing' },
      });
      upsertEntity(db, { campaign_id: id, kind: 'place', name: 'Harrowgate', summary: 'A hill town of grey stone, two days east across the Whitlow Moor.' });
      owedLevelUp(db, id);
      return id;
    },
    lines: [
      "Let's continue - we're at Greywater Crossing with the physician's letter and want to set out for Harrowgate.",
      'Bram leads the way east across the Whitlow Moor at a steady pace.',
      'Bram and Elowen are tired and take a short rest on the moor.',
      'Bram carries on towards Harrowgate and makes camp when night falls.',
      'If anything attacks the camp, Bram draws his sword and fights the nearest enemy; otherwise he keeps watch.',
      'Bram keeps fighting the nearest enemy still standing, if there is a fight.',
      'Bram and Elowen take a long rest at the camp.',
      'The party reaches Harrowgate. Bram has earned enough experience to level up; he takes his level-up now.',
      "Let's stop here for today. Please end the session so we can pick it up next time.",
    ],
  },
  act: {
    goal: 'play the first act of a new adventure: investigate the vanishings in Tallowmere, recruit a companion, buy gear, fight what comes, rest, level up, and save whenever a session ends.',
    playerBrief:
      'This is a long game, a whole first act over several sessions. Investigate the disappearances by talking to people and searching each place for clues; ' +
      "recruit Wren Hollis as a companion; spend your gold on useful gear at Hobb's Sundries; fight when a fight comes and take short or long rests when you are hurt; " +
      'take your level-up when the DM offers it. Play Bram in character, make your own choices, and do not rush: follow each lead before moving on.',
    sessionEvery: 35,
    seed: (db) => {
      const id = seedParty(db, {
        name: 'The Tallowmere Vanishings',
        premise: 'Bram, a young Fighter fresh out of the militia, has come to Tallowmere, a candle-making town on a reed lake called the Mere, where three townsfolk have vanished in a fortnight.',
        level: 1,
        alone: true,
        location: 'Tallowmere, the common room of the Wick and Whistle',
        place: 'Tallowmere',
        placeSummary: 'A lakeside town of chandlers and reed-cutters on the shore of the Mere; its guildhall, inn and market face the water.',
        quest: {
          title: 'Find the missing of Tallowmere',
          summary: 'Learn what happened to the three townsfolk who vanished and bring them home.',
          steps: ['Hear the reeve out', 'Find where the missing were taken', 'Unmask whoever is behind it', 'Bring the missing home'],
        },
        ending: 'The missing come home and the culprit answers for it, or Tallowmere loses more of its own.',
        secret: [
          "Culprit: Guildmaster Osgar Penhallow owes a ruinous debt to Sela Graveney's smugglers and pays it in people. He gives lone townsfolk charity candles laced with a sleeping draught; the smugglers carry the sleepers from the old wax-works jetty to Gull Island, to be sold as labour across the Mere.",
          'The missing (Col Hollis, Edda Mewes, Tobin Fisk) are alive, chained in the cellar of the burned beacon tower on Gull Island.',
          "Clues, one per place: the Wick and Whistle (the drugged candle), the old wax-works (drag marks and the apron), the Chandlers' Guildhall (the ledger), the reed beds (the lantern signals).",
          'Likely fights: 3 Giant Rats in the wax-works cellar; 2 Wolves on the lake road (optional); 3 Bandits and a Tough in the reed beds, sent by Penhallow once the party asks questions at the guildhall; Bandit Captain Sela Graveney, 2 Bandits and a Mastiff on Gull Island.',
          "XP: each fight gives its creatures' SRD XP, shared by the party; each side quest is worth 50 XP to every party member, finding Col 100 and the main quest 300, enough for level 2 mid-act and level 3 by its end.",
        ].join('\n'),
        home: { town: 'Tallowmere', from: 'Redham' },
      });
      seedExtras(db, id, {
        places: [
          { name: 'The Wick and Whistle', summary: "Tallowmere's lakeside inn: a smoky common room, cheap rooms upstairs, and the best eel pie on the Mere.", hidden_notes: "Edda Mewes's rented room upstairs is untouched; Marta has kept it for her." },
          { name: "Hobb's Sundries", summary: "A cramped general store by the market cross. In stock at SRD prices: Potion of Healing, Shield, Chain Shirt, Healer's Kit, Light Crossbow and Bolts, Antitoxin, Holy Water, Hooded Lantern, Rope and Rations." },
          { name: "The Chandlers' Guildhall", summary: 'A grand timbered hall on the waterfront where the candle-makers keep their books and hand out charity candles to the poor.', hidden_notes: "Penhallow's private ledger is in the locked desk of his upstairs office (DC 13 to pick, DC 15 to force)." },
          { name: 'The old wax-works', summary: 'A boarded-up rendering house on the north shore, abandoned since a fire; locals say it is overrun with rats.', hidden_notes: '3 Giant Rats nest in the cellar. The smugglers load their boats at the rotten jetty behind it.' },
          { name: 'The lake road', summary: "The muddy road round the Mere's west shore to the next village; carters complain of wolves.", hidden_notes: "2 Wolves hunt along it. Ansel Hobb's overturned cart lies a mile out, its crates of lamp oil intact." },
          { name: 'The reed beds', summary: 'Miles of tall reeds and narrow channels along the eastern shore, worked by reed-cutters in flat boats.', hidden_notes: "Once the party asks questions at the guildhall, Penhallow's hired ambush waits here: 3 Bandits and a Tough." },
          { name: 'Gull Island', summary: 'A rocky island in the middle of the Mere, shunned since its old beacon tower burned.', hidden_notes: "Sela Graveney's smugglers camp in the ruined beacon tower: a Bandit Captain, 2 Bandits and a Mastiff. The three missing are chained in its cellar." },
        ],
        npcs: [
          { name: 'Marta Quarle', summary: 'Warm, gossipy keeper of the Wick and Whistle; knows every regular and misses the ones who are gone.' },
          { name: 'Ansel Hobb', summary: "Fussy, honest keeper of Hobb's Sundries; haggles for sport but never cheats a customer." },
          { name: 'Reeve Adelind Strake', summary: "Tallowmere's tired reeve; she pays 25 gp for news of the missing and 10 gp to clear the wax-works rats." },
          {
            name: 'Wren Hollis',
            summary: 'A sharp-eyed reed-lake poacher whose brother Col is one of the missing; she drinks alone at the Wick and Whistle.',
            hidden_notes: 'Companion candidate: she joins if Bram promises to look for Col and treats her as an equal. Recruit her with create_companion as a Human Ranger with the Criminal background; she knows the reed beds and can row to Gull Island.',
          },
          {
            name: 'Osgar Penhallow',
            summary: "Guildmaster of the Chandlers' Guild: generous, pious, and Tallowmere's chief benefactor.",
            hidden_notes: 'The culprit. Accused without proof he is all wounded dignity and sends the reed-bed ambush; shown his own ledger, he breaks down and begs for mercy.',
          },
          {
            name: 'Dunstan Crabbe',
            summary: 'A surly ferryman with a bad temper and a worse name; half the town blames him for the vanishings.',
            hidden_notes: 'Innocent. He has seen boats cross to Gull Island at night but fears the smugglers; kindness and a DC 12 Persuasion check get it out of him.',
          },
        ],
        facts: [
          ['The missing', 'Three townsfolk have vanished in a fortnight: Col Hollis, a reed-cutter; Edda Mewes, a washerwoman; and Tobin Fisk, a lamplighter.'],
          ['Gull Island', 'Nobody has lived on Gull Island since its beacon tower burned twenty years ago.'],
          ['Tallowmere', "Tallowmere's candles are sold in every market around the Mere."],
        ],
        rumours: [
          ['Dunstan Crabbe the ferryman was heard arguing with Col Hollis the day Col vanished.', 'location', 'twisted'],
          ['Lights move on Gull Island on moonless nights.', 'location', 'true'],
          ['The Mere takes one soul every winter, and this year it is hungry early.', 'location', 'false'],
          ['The guildmaster has been borrowing money from strangers across the lake.', 'location', 'true'],
          ['Wolves have been taking sheep along the lake road.', 'region', 'true'],
        ],
        quests: [
          { title: 'Clear the wax-works rats', kind: 'side', summary: 'The reeve pays 10 gp to clear the rats nesting in the old wax-works before they reach the granary.', steps: ['Clear the wax-works cellar', 'Report to the reeve'] },
          { title: "Recover Ansel Hobb's cart", kind: 'side', summary: "Wolves scattered Ansel Hobb's supply cart on the lake road; he offers a discount for its cargo.", steps: ['Find the cart on the lake road', 'Bring the cargo back to Hobb'] },
          { title: 'Bring Col Hollis home', kind: 'side', summary: "Wren Hollis's brother Col is one of the missing; she wants him home alive.", steps: ["Win Wren Hollis's trust", 'Find Col'] },
        ],
      });
      const thread = addPlotThread(db, { campaign_id: id, title: 'The Tallowmere vanishings', summary: 'Three townsfolk gone in a fortnight, each last seen walking home alone at night.' });
      for (const text of [
        "The Wick and Whistle: each of the missing took home a free charity candle from the Chandlers' Guild; the half-burned stub in Edda Mewes's room smells of poppy and leaves a blue soot.",
        'The old wax-works: fresh drag marks run from the cellar to a rotten jetty, and a guild apron stitched with the Penhallow household mark hangs on a nail.',
        "The Chandlers' Guildhall: Penhallow's private ledger records payments 'to the island ferry' on each night someone vanished.",
        'The reed beds: an old reed-cutter has seen a lantern flashed from the guildhall roof and answered from Gull Island on moonless nights.',
      ]) {
        plantClue(db, { campaign_id: id, thread_id: thread.id, text, hidden: true });
      }
      adjustGold(db, { campaign_id: id, delta: 60, reason: 'the last of his militia pay' });
      return id;
    },
    lines: [
      "Let's begin - Bram has just arrived in Tallowmere and walks into the Wick and Whistle. He looks around the common room. What does he see?",
      'Bram orders a drink and asks the innkeeper about the people who have gone missing.',
      'Bram goes to find the reeve, asks what she knows and what the job pays, and takes it if it is fair.',
      "Bram visits Hobb's Sundries to see what is for sale and buys a Potion of Healing if he can afford it.",
      'Bram looks for Wren Hollis, the poacher whose brother is missing, and asks her to help him find Col. He offers her an equal share.',
      'Bram and Wren head to the old wax-works on the north shore and search it carefully.',
      'Bram draws his weapon and attacks the nearest enemy.',
      'Bram keeps fighting, attacking the closest enemy still standing; if the fight is over, he searches the cellar.',
      'Bram follows whatever trail they found and asks Wren what she makes of it.',
      "Bram goes to the Chandlers' Guildhall and politely asks the guildmaster about the missing townsfolk.",
      'Bram and Wren take a short rest to patch themselves up.',
      'Bram follows the next lead, keeping his eyes open for trouble.',
      'If they are attacked, Bram fights the nearest enemy; otherwise he presses on carefully.',
      'Bram keeps fighting the nearest enemy still standing; if it is over, he checks on Wren.',
      'Back at the inn, Bram and Wren take a long rest. If Bram has earned a level, he takes his level-up.',
      "Let's stop here for today. Please save the game and end the session so we can pick it up next time.",
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
