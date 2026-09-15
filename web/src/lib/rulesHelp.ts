// Plain-words help for every number on screen: what it is, in a sentence or two, for a first game.
export interface Help {
  title: string;
  text: string;
  /** The glossary entry that says more; the terms match the bundled SRD rows. */
  glossaryTerm?: string;
}

const ORDER_OF_COMBAT = 'The Order of Combat';
const VISION = 'Vision and Light';

const HELP: Record<string, Help> = {
  // --- abilities ---------------------------------------------------------
  'ability.str': {
    title: 'Strength',
    text: 'Raw muscle: lifting, shoving, breaking things and most melee attacks. Forcing a stuck door is a Strength check.',
    glossaryTerm: 'Strength (ability)',
  },
  'ability.dex': {
    title: 'Dexterity',
    text: 'Nimbleness and balance: sneaking, aiming a bow, keeping your footing. Picking a lock is a Dexterity check.',
    glossaryTerm: 'Dexterity (ability)',
  },
  'ability.con': {
    title: 'Constitution',
    text: 'Stamina and toughness. It sets your hit points and shrugs off poison and cold; you never roll it to act.',
    glossaryTerm: 'Constitution (ability)',
  },
  'ability.int': {
    title: 'Intelligence',
    text: 'Learning and reasoning: what you know and what you can work out. Recalling who built a ruin is an Intelligence check.',
    glossaryTerm: 'Intelligence (ability)',
  },
  'ability.wis': {
    title: 'Wisdom',
    text: 'Awareness and good sense: noticing things and reading people. Spotting a hidden goblin is a Wisdom check.',
    glossaryTerm: 'Wisdom (ability)',
  },
  'ability.cha': {
    title: 'Charisma',
    text: 'Force of personality: charm, bluff and command. Talking a guard round is a Charisma check.',
    glossaryTerm: 'Charisma (ability)',
  },
  ability_score: {
    title: 'Ability score',
    text: 'The raw number, usually 8 to 20. On its own it does nothing: the modifier above it is what you add to rolls.',
    glossaryTerm: 'Ability Scores',
  },
  ability_modifier: {
    title: 'Ability modifier',
    text: 'The number you actually add to a roll. A score of 10 or 11 gives +0, and every two points up or down shifts it by one.',
    glossaryTerm: 'Ability Modifiers',
  },

  // --- the vital numbers -------------------------------------------------
  hp: {
    title: 'Hit points',
    text: 'How much harm you can take before you drop. Damage takes them away, rest and healing give them back; at 0 you fall unconscious.',
    glossaryTerm: 'Hit Points',
  },
  temp_hp: {
    title: 'Temporary hit points',
    text: 'A cushion on top of your real hit points. Damage eats through it first, it never heals, and two lots do not stack: keep the better one.',
    glossaryTerm: 'Temporary Hit Points',
  },
  hit_dice: {
    title: 'Hit dice',
    text: 'One die per level, spent during a short rest to heal. You get half of them back on a long rest.',
    glossaryTerm: 'Hit Points and Hit Point Dice',
  },
  ac: {
    title: 'Armour Class',
    text: 'How hard you are to hit: an attack roll must meet or beat it. Armour, a shield and Dexterity all push it up.',
    glossaryTerm: 'Armor Class',
  },
  speed: {
    title: 'Speed',
    text: 'How far you can walk on your turn, in feet. Rough ground costs double, so 30 ft of speed crosses only 15 ft of it.',
    glossaryTerm: 'Movement and Position',
  },
  initiative: {
    title: 'Initiative',
    text: 'A Dexterity roll at the start of a fight that sets the turn order. Highest goes first, and the order holds all fight.',
    glossaryTerm: ORDER_OF_COMBAT,
  },
  proficiency_bonus: {
    title: 'Proficiency bonus',
    text: 'The bonus you add to whatever you are trained in: attacks, some saves, some skills. It grows as you level up.',
    glossaryTerm: 'Proficiencies',
  },
  passive_perception: {
    title: 'Passive Perception',
    text: 'What you notice without looking for it: 10 plus your Perception bonus. The DM compares it to how well something is hidden.',
    glossaryTerm: 'Perception (skill)',
  },
  xp: {
    title: 'Experience points',
    text: 'What you earn for beating danger and reaching story beats. Enough of them takes you to the next level. Level 2 at 300 XP, 3 at 900, 4 at 2,700, 5 at 6,500, 6 at 14,000, 7 at 23,000, 8 at 34,000, 9 at 48,000, 10 at 64,000, 11 at 85,000, 12 at 100,000, 13 at 120,000, 14 at 140,000, 15 at 165,000, 16 at 195,000, 17 at 225,000, 18 at 265,000, 19 at 305,000, 20 at 355,000.',
    glossaryTerm: 'Experience Points',
  },
  gold: {
    title: 'Gold pieces',
    text: 'Your money. A night at an inn costs a few silver; good armour runs to hundreds of gold.',
  },
  carrying_capacity: {
    title: 'Carrying capacity',
    text: 'How much you can carry before it slows you down: your Strength score times 15 lb.',
  },
  encumbered: {
    title: 'Encumbered',
    text: 'Carrying more than your capacity. Your speed drops to 5 ft until you drop something or grow stronger.',
  },

  // --- saves and skills --------------------------------------------------
  saving_throws: {
    title: 'Saving throws',
    text: 'Rolls to avoid something happening to you: a trap, a spell, a breath of fire. Roll a d20 plus that ability, and add your proficiency bonus if you are trained in it.',
    glossaryTerm: 'Saving Throws',
  },
  'save.str': { title: 'Strength save', text: 'Resisting being shoved, grappled or dragged along by force.', glossaryTerm: 'Saving Throws' },
  'save.dex': { title: 'Dexterity save', text: 'Dodging out of the way: a fireball, a falling net, a swinging blade.', glossaryTerm: 'Saving Throws' },
  'save.con': {
    title: 'Constitution save',
    text: 'Enduring what is already in you: poison, disease, cold, and holding concentration on a spell.',
    glossaryTerm: 'Saving Throws',
  },
  'save.int': { title: 'Intelligence save', text: 'Keeping your mind your own against illusions and mind-reading.', glossaryTerm: 'Saving Throws' },
  'save.wis': { title: 'Wisdom save', text: 'Shaking off fear, charm and other pulls on your will.', glossaryTerm: 'Saving Throws' },
  'save.cha': { title: 'Charisma save', text: 'Holding on to yourself against banishment and possession.', glossaryTerm: 'Saving Throws' },
  skills: {
    title: 'Skills',
    text: 'Narrower talents inside an ability. Roll a d20, add the skill bonus, and try to meet the number the DM sets.',
    glossaryTerm: 'Skill Proficiencies',
  },
  'skill.acrobatics': {
    title: 'Acrobatics',
    text: 'Balance and tumbling: a narrow ledge, a rolling barrel, landing on your feet.',
    glossaryTerm: 'Acrobatics (skill)',
  },
  'skill.animal_handling': {
    title: 'Animal Handling',
    text: 'Calming, reading or steering an animal.',
    glossaryTerm: 'Animal Handling (skill)',
  },
  'skill.arcana': { title: 'Arcana', text: 'What you know about magic, spells and magical creatures.', glossaryTerm: 'Arcana (skill)' },
  'skill.athletics': { title: 'Athletics', text: 'Climbing, swimming, jumping and wrestling.', glossaryTerm: 'Athletics (skill)' },
  'skill.deception': { title: 'Deception', text: 'Telling a convincing lie or wearing a false face.', glossaryTerm: 'Deception (skill)' },
  'skill.history': { title: 'History', text: 'Recalling past events, old kingdoms and famous names.', glossaryTerm: 'History (skill)' },
  'skill.insight': {
    title: 'Insight',
    text: 'Reading what someone really means, or whether they are lying.',
    glossaryTerm: 'Insight (skill)',
  },
  'skill.intimidation': {
    title: 'Intimidation',
    text: 'Getting your way through threats and sheer presence.',
    glossaryTerm: 'Intimidation (skill)',
  },
  'skill.investigation': {
    title: 'Investigation',
    text: 'Working out what the clues mean, rather than spotting them in the first place.',
    glossaryTerm: 'Investigation (skill)',
  },
  'skill.medicine': { title: 'Medicine', text: 'Steadying a dying friend or naming an illness.', glossaryTerm: 'Medicine (skill)' },
  'skill.nature': { title: 'Nature', text: 'Knowing plants, animals, weather and the wild.', glossaryTerm: 'Nature (skill)' },
  'skill.perception': {
    title: 'Perception',
    text: 'Noticing things: a sound behind the door, a figure in the dark.',
    glossaryTerm: 'Perception (skill)',
  },
  'skill.performance': {
    title: 'Performance',
    text: 'Holding a crowd with music, dance or a tale.',
    glossaryTerm: 'Performance (skill)',
  },
  'skill.persuasion': {
    title: 'Persuasion',
    text: 'Winning someone over honestly, with tact or a good argument.',
    glossaryTerm: 'Persuasion (skill)',
  },
  'skill.religion': { title: 'Religion', text: 'Knowing gods, rites, holy symbols and the undead.', glossaryTerm: 'Religion (skill)' },
  'skill.sleight_of_hand': {
    title: 'Sleight of Hand',
    text: 'Quick fingers: picking a pocket, palming a coin, planting an item.',
    glossaryTerm: 'Sleight of Hand (skill)',
  },
  'skill.stealth': { title: 'Stealth', text: 'Moving unseen and unheard.', glossaryTerm: 'Stealth (skill)' },
  'skill.survival': { title: 'Survival', text: 'Tracking, foraging and finding your way in the wild.', glossaryTerm: 'Survival (skill)' },

  // --- counters and states ----------------------------------------------
  inspiration: {
    title: 'Heroic Inspiration',
    text: 'A reward the DM hands out for good play. Spend it to reroll a d20 you just rolled and keep the new result.',
  },
  exhaustion: {
    title: 'Exhaustion',
    text: 'Wear from hunger, cold or magic, counted 1 to 6. Each level takes 2 off your d20 rolls and 5 ft off your speed; at 6 you die.',
    glossaryTerm: 'Exhaustion (condition)',
  },
  concentration: {
    title: 'Concentration',
    text: 'Some spells last only while you hold them in mind. You can hold one at a time, and taking damage calls for a Constitution save to keep it.',
    glossaryTerm: 'Spellcasting',
  },
  death_saves: {
    title: 'Death saving throws',
    text: 'At 0 hit points you roll a d20 each turn: 10 or more is a success, less is a failure. Three successes steady you, three failures kill you.',
    glossaryTerm: 'Dropping to 0 Hit Points',
  },
  conditions: {
    title: 'Conditions',
    text: 'Named states that change what you can do, such as prone, frightened or poisoned. Each one has its own rules.',
  },

  // --- spells ------------------------------------------------------------
  spellcasting_ability: {
    title: 'Spellcasting ability',
    text: 'The stat your spells run on - Intelligence, Wisdom or Charisma, depending on your class. Your save DC and your spell attacks are both built from it.',
    glossaryTerm: 'Spellcasting',
  },
  spell_save_dc: {
    title: 'Spell save DC',
    text: '8 + your proficiency bonus + your spellcasting ability modifier. A target must roll this or higher on its save to resist the spell.',
    glossaryTerm: 'Spellcasting',
  },
  spell_attack_bonus: {
    title: 'Spell attack bonus',
    text: 'What you add to the d20 when a spell has to hit, like a ray or a bolt: your proficiency bonus plus your spellcasting ability modifier.',
    glossaryTerm: 'Spellcasting',
  },
  spell_slots: {
    title: 'Spell slots',
    text: 'The fuel for your spells: one slot per casting, by level. A long rest gives them all back.',
    glossaryTerm: 'Spellcasting',
  },
  cantrips: {
    title: 'Cantrips',
    text: 'Small spells you know by heart. They cost no slot and can be cast as often as you like.',
    glossaryTerm: 'Spellcasting',
  },
  prepared: {
    title: 'Prepared spells',
    text: 'The spells you have ready today. You choose them after a long rest, and only these can be cast.',
    glossaryTerm: 'Spellcasting',
  },
  known: {
    title: 'Known spells',
    text: 'The spells your character has learned for good. They are always available to cast, slots allowing.',
    glossaryTerm: 'Spellcasting',
  },

  // --- the battle side ---------------------------------------------------
  cr: {
    title: 'Challenge Rating',
    text: 'Rough difficulty of a creature. A CR 1 creature is a fair fight for a party of four level-1 characters.',
  },
  creature_type: {
    title: 'Creature type and size',
    text: 'What kind of thing it is and how much space it takes up. Some spells and weapons only bite on certain types.',
  },
  senses: {
    title: 'Senses',
    text: 'How it perceives you. Darkvision sees in the dark, tremorsense feels footsteps through the ground, blindsight needs no eyes at all.',
    glossaryTerm: VISION,
  },
  movement_left: {
    title: 'Movement left',
    text: 'How much of this turn of walking you have not spent yet. It refills at the start of your next turn.',
    glossaryTerm: 'Movement and Position',
  },
  action: {
    title: 'Action',
    text: 'The main thing you do on your turn: attack, cast a spell, dash, hide. One per turn.',
    glossaryTerm: ORDER_OF_COMBAT,
  },
  bonus_action: {
    title: 'Bonus action',
    text: 'A quick extra, and only when a feature or spell says it takes one. One per turn, never on its own.',
    glossaryTerm: ORDER_OF_COMBAT,
  },
  reaction: {
    title: 'Reaction',
    text: 'One answer to something outside your turn, such as an opportunity attack when a foe walks out of your reach.',
    glossaryTerm: ORDER_OF_COMBAT,
  },
  cover: {
    title: 'Cover',
    text: 'Something between you and the target. Half cover gives it +2 AC, three-quarters +5, and behind total cover it cannot be hit at all.',
    glossaryTerm: 'Cover',
  },
  advantage: {
    title: 'Advantage and disadvantage',
    text: 'Roll two d20s instead of one: with advantage keep the higher, with disadvantage the lower. One of each cancels out.',
    glossaryTerm: 'Advantage/Disadvantage',
  },
  natural_20: {
    title: 'Natural 20 and natural 1',
    text: 'The number on the die itself, before any bonus. On an attack a 20 always hits and doubles the damage dice; a 1 always misses.',
    glossaryTerm: 'Critical Hits',
  },
  damage_types: {
    title: 'Damage types',
    text: 'Every hit has a kind, from slashing to fire to poison, and some creatures care a great deal which one it is.',
    glossaryTerm: 'Damage Types',
  },
  resistances: {
    title: 'Resistance',
    text: 'Damage of that type is halved against this creature.',
    glossaryTerm: 'Resistance and Vulnerability',
  },
  immunities: {
    title: 'Immunity',
    text: 'Damage of that type does nothing at all to this creature.',
    glossaryTerm: 'Immunity',
  },
  vulnerabilities: {
    title: 'Vulnerability',
    text: 'Damage of that type counts double against this creature.',
    glossaryTerm: 'Resistance and Vulnerability',
  },
  bloodied: {
    title: 'Bloodied',
    text: 'Down to half its hit points or less. It is a rough read on how the fight is going, not a rule of its own.',
  },
  distance: {
    title: 'Distance',
    text: 'How far away it is, measured on the grid at 5 ft a square. Melee reach is usually 5 ft; a bow carries much further.',
    glossaryTerm: 'Movement and Position',
  },

  // --- what you can do this turn ----------------------------------------
  'action.move': {
    title: 'Move',
    text: 'Walk up to your remaining speed. Rough ground costs double, and stepping out of reach of a foe can draw an attack.',
    glossaryTerm: 'Movement and Position',
  },
  'action.attack': {
    title: 'Attack',
    text: 'Swing or shoot at a target: roll a d20 plus your bonus against its AC, then roll damage if you hit.',
    glossaryTerm: 'Making an Attack',
  },
  'action.dash': { title: 'Dash', text: 'Spend your action to move again: double your speed this turn.', glossaryTerm: ORDER_OF_COMBAT },
  'action.disengage': {
    title: 'Disengage',
    text: 'Spend your action to step away safely: no opportunity attacks against you this turn.',
    glossaryTerm: ORDER_OF_COMBAT,
  },
  'action.dodge': {
    title: 'Dodge',
    text: 'Spend your action defending: attacks against you have disadvantage and your Dexterity saves have advantage.',
    glossaryTerm: ORDER_OF_COMBAT,
  },
  'action.help': {
    title: 'Help',
    text: 'Spend your action aiding an ally: they get advantage on their next attack or check.',
    glossaryTerm: ORDER_OF_COMBAT,
  },
  'action.hide': {
    title: 'Hide',
    text: 'Make a Stealth roll to slip out of sight. You need cover or darkness, and attacking unseen gives advantage.',
    glossaryTerm: 'Hiding',
  },
  'action.ready': {
    title: 'Ready',
    text: 'Name a trigger now and hold an action for it. When the trigger happens you spend your reaction to act.',
    glossaryTerm: ORDER_OF_COMBAT,
  },
  'action.utilize': {
    title: 'Utilize',
    text: 'Use an object: pull a lever, open a door, drink the potion someone hands you.',
    glossaryTerm: 'Interacting with Objects',
  },
  'action.cast': {
    title: 'Cast a spell',
    text: 'Spend a slot, or nothing at all for a cantrip, to work magic. Many spells let the target make a saving throw.',
    glossaryTerm: 'Spellcasting',
  },
  'action.action': {
    title: 'Action',
    text: 'Something this creature can do with its action, taken from its sheet or stat block.',
    glossaryTerm: ORDER_OF_COMBAT,
  },
  'action.bonus': {
    title: 'Bonus action',
    text: 'A quick extra this creature may take on top of its action, once per turn.',
    glossaryTerm: ORDER_OF_COMBAT,
  },
  'action.reaction': {
    title: 'Reaction',
    text: 'Something this creature can do out of turn, once per round, when its trigger happens.',
    glossaryTerm: ORDER_OF_COMBAT,
  },
  'action.death_save': {
    title: 'Death saving throw',
    text: 'Rolled at the start of each turn at 0 hit points: three successes steady you, three failures kill you.',
    glossaryTerm: 'Dropping to 0 Hit Points',
  },
  'action.grapple': {
    title: 'Grapple',
    text: 'Take hold of a creature no more than one size larger with an Unarmed Strike. It saves with Strength or Dexterity, its choice, or its speed drops to 0.',
    glossaryTerm: 'Making an Attack',
  },
  'action.shove': {
    title: 'Shove',
    text: 'Push a creature with an Unarmed Strike. It saves with Strength or Dexterity, its choice, or it is knocked 5 ft back or flat on its face.',
    glossaryTerm: 'Making an Attack',
  },
  'action.escape_grapple': {
    title: 'Escape the grapple',
    text: 'Spend your action on an Athletics or Acrobatics check against the grappler. Beat it and you are free to move again.',
    glossaryTerm: 'Ability Checks',
  },
  'action.stand': {
    title: 'Stand up',
    text: 'Getting off the ground ends Prone and costs half your speed in movement.',
    glossaryTerm: 'Movement and Position',
  },
  'action.release_ready': {
    title: 'Release a readied action',
    text: 'The trigger you named has happened, so the action you were holding goes off. It spends your reaction for the round.',
    glossaryTerm: ORDER_OF_COMBAT,
  },
  'action.incapacitated': {
    title: 'Nothing this turn',
    text: 'Something has left you incapacitated: no action, no bonus action, no reaction until it ends.',
    glossaryTerm: ORDER_OF_COMBAT,
  },
  'action.no_move': {
    title: 'Cannot move',
    text: 'Something has your speed at 0: grappled, restrained or worse. You may still act where you stand.',
    glossaryTerm: 'Movement and Position',
  },
  'action.no_spells': {
    title: 'No spellcasting',
    text: 'You are wearing armour or a shield you were never trained in, and that shuts your magic off entirely.',
    glossaryTerm: 'Equipment Proficiencies',
  },
  'action.thrown': {
    title: 'Thrown weapon',
    text: 'A dagger, axe or spear flung at a target: a ranged attack made with the same bonus, out to the range on the weapon.',
    glossaryTerm: 'Ranged Attacks',
  },

  // --- senses, spelled out; {range} is filled in from the creature's own line
  'sense.darkvision': {
    title: 'Darkvision',
    text: 'Sees in darkness as if it were dim light, out to {range}, though only in shades of grey.',
    glossaryTerm: VISION,
  },
  'sense.blindsight': {
    title: 'Blindsight',
    text: 'Perceives everything around it out to {range} without using its eyes at all; blinding it changes nothing inside that range.',
    glossaryTerm: VISION,
  },
  'sense.tremorsense': {
    title: 'Tremorsense',
    text: 'Feels anything touching the ground out to {range} through the vibrations it makes, even in pitch dark.',
    glossaryTerm: VISION,
  },
  'sense.truesight': {
    title: 'Truesight',
    text: 'Sees the truth out to {range}: through darkness, invisibility, illusions and shapechanging alike.',
    glossaryTerm: VISION,
  },
  'sense.passive_perception': {
    title: 'Passive Perception',
    text: 'What it notices without looking. Your hiding roll has to beat this number.',
    glossaryTerm: 'Perception (skill)',
  },

  // --- creature types ----------------------------------------------------
  'type.aberration': {
    title: 'Aberration',
    text: 'Something from beyond the world, alien in shape and thought, such as a beholder or a mind flayer.',
  },
  'type.beast': {
    title: 'Beast',
    text: 'An ordinary animal: wolf, bear, giant spider. Druid and ranger magic often works only on beasts.',
  },
  'type.celestial': { title: 'Celestial', text: 'A creature of the upper planes, such as an angel or a pegasus.' },
  'type.construct': {
    title: 'Construct',
    text: 'A made thing given motion, such as an animated armour or a golem. It usually ignores poison and exhaustion.',
  },
  'type.dragon': { title: 'Dragon', text: 'A true dragon or its close kin: old, proud and dangerous out of all proportion to its size.' },
  'type.elemental': { title: 'Elemental', text: 'Living fire, air, earth or water from the elemental planes.' },
  'type.fey': {
    title: 'Fey',
    text: 'A creature of the faerie realms, such as a dryad or a pixie: charming, tricky and bound by its own rules.',
  },
  'type.fiend': { title: 'Fiend', text: 'A devil, demon or worse. Many are hurt by radiant damage and hate holy ground.' },
  'type.giant': { title: 'Giant', text: 'Huge humanlike folk: ogres, trolls and the giants proper.' },
  'type.humanoid': {
    title: 'Humanoid',
    text: 'People-shaped folk, from goblins to elves to you. It matters for spells such as Hold Person, which only affect humanoids.',
  },
  'type.monstrosity': { title: 'Monstrosity', text: 'A frightening creature that is none of the other types, such as an owlbear.' },
  'type.ooze': { title: 'Ooze', text: 'A shapeless crawling thing that eats what it touches, such as a gelatinous cube.' },
  'type.plant': { title: 'Plant', text: 'A walking or thinking plant, such as a treant or a shambling mound.' },
  'type.undead': {
    title: 'Undead',
    text: 'Something dead and still moving: skeleton, zombie, vampire. Turn Undead and radiant damage bite hard here.',
  },

  // --- sizes -------------------------------------------------------------
  'size.tiny': { title: 'Tiny', text: 'Shares a square with others and takes about 2½ ft of space: a rat, an imp, a sprite.' },
  'size.small': { title: 'Small', text: 'Fills one 5 ft square, like a halfling or a goblin, and moves as easily as you do.' },
  'size.medium': { title: 'Medium', text: 'Fills one 5 ft square: the size of most people, and the size of your character.' },
  'size.large': { title: 'Large', text: 'Fills a 2 by 2 block of squares, 10 ft across: an ogre, a horse, a dire wolf.' },
  'size.huge': { title: 'Huge', text: 'Fills a 3 by 3 block, 15 ft across: a treant or a young dragon.' },
  'size.gargantuan': { title: 'Gargantuan', text: 'Fills a 4 by 4 block or more, 20 ft across and up: an ancient dragon, a kraken.' },

  // --- damage types ------------------------------------------------------
  'damage.acid': { title: 'Acid damage', text: 'Burning from corrosive spray or ooze; it eats through gear as readily as flesh.', glossaryTerm: 'Damage Types' },
  'damage.bludgeoning': {
    title: 'Bludgeoning damage',
    text: 'Blunt force: clubs, falling rocks, a long fall.',
    glossaryTerm: 'Damage Types',
  },
  'damage.cold': { title: 'Cold damage', text: 'Biting frost that numbs and slows.', glossaryTerm: 'Damage Types' },
  'damage.fire': { title: 'Fire damage', text: 'Flame and searing heat; it sets loose gear alight too.', glossaryTerm: 'Damage Types' },
  'damage.force': {
    title: 'Force damage',
    text: 'Pure magical energy. Almost nothing resists it, which makes it the most reliable damage in the game.',
    glossaryTerm: 'Damage Types',
  },
  'damage.lightning': { title: 'Lightning damage', text: 'A bolt or arc of electricity.', glossaryTerm: 'Damage Types' },
  'damage.necrotic': {
    title: 'Necrotic damage',
    text: 'Withering life force. Undead are usually immune and often healed by it.',
    glossaryTerm: 'Damage Types',
  },
  'damage.piercing': { title: 'Piercing damage', text: 'Punctures: arrows, spears, fangs.', glossaryTerm: 'Damage Types' },
  'damage.poison': {
    title: 'Poison damage',
    text: 'Venom and toxins, often with the poisoned condition attached. Constructs and undead shrug it off.',
    glossaryTerm: 'Damage Types',
  },
  'damage.psychic': {
    title: 'Psychic damage',
    text: 'Harm to the mind itself; armour is no help against it.',
    glossaryTerm: 'Damage Types',
  },
  'damage.radiant': {
    title: 'Radiant damage',
    text: 'Searing holy light. Undead and fiends feel it worst.',
    glossaryTerm: 'Damage Types',
  },
  'damage.slashing': { title: 'Slashing damage', text: 'Cuts: swords, axes, claws.', glossaryTerm: 'Damage Types' },
  'damage.thunder': { title: 'Thunder damage', text: 'A concussive boom that rattles bones and shatters glass.', glossaryTerm: 'Damage Types' },

  // --- conditions --------------------------------------------------------
  'condition.blinded': {
    title: 'Blinded',
    text: 'Cannot see, so anything needing sight simply fails: its attacks have disadvantage, and attacks against it have advantage.',
    glossaryTerm: 'Blinded (condition)',
  },
  'condition.charmed': {
    title: 'Charmed',
    text: 'Cannot attack or harm whoever charmed it, who in turn has advantage on social checks with it.',
    glossaryTerm: 'Charmed (condition)',
  },
  'condition.deafened': { title: 'Deafened', text: 'Cannot hear, and fails anything that needs hearing.', glossaryTerm: 'Deafened (condition)' },
  'condition.exhaustion': {
    title: 'Exhaustion',
    text: 'Counted 1 to 6. Each level takes 2 off d20 rolls and 5 ft off speed; at 6 the creature dies.',
    glossaryTerm: 'Exhaustion (condition)',
  },
  'condition.frightened': {
    title: 'Frightened',
    text: 'Rolls at disadvantage while it can see what scares it, and cannot willingly move closer to it.',
    glossaryTerm: 'Frightened (condition)',
  },
  'condition.grappled': {
    title: 'Grappled',
    text: 'Held fast: speed 0, and disadvantage on attacks against anyone but the grappler. It ends if the grappler is incapacitated or the two are pulled apart.',
    glossaryTerm: 'Grappled (condition)',
  },
  'condition.incapacitated': {
    title: 'Incapacitated',
    text: 'Takes no action, bonus action or reaction, and cannot concentrate.',
    glossaryTerm: 'Incapacitated (condition)',
  },
  'condition.invisible': {
    title: 'Invisible',
    text: 'Cannot be seen: attacks against it have disadvantage, and its own attacks have advantage.',
    glossaryTerm: 'Invisible (condition)',
  },
  'condition.paralyzed': {
    title: 'Paralyzed',
    text: 'Frozen still: it cannot act, its speed is 0 and its Strength and Dexterity saves fail. Attacks against it have advantage, and any hit within 5 ft is a critical.',
    glossaryTerm: 'Paralyzed (condition)',
  },
  'condition.petrified': {
    title: 'Petrified',
    text: 'Turned to stone: it cannot act, its speed is 0 and its Strength and Dexterity saves fail. Attacks against it have advantage.',
    glossaryTerm: 'Petrified (condition)',
  },
  'condition.poisoned': {
    title: 'Poisoned',
    text: 'Attack rolls and ability checks are at disadvantage until it wears off.',
    glossaryTerm: 'Poisoned (condition)',
  },
  'condition.prone': {
    title: 'Prone',
    text: 'On the ground: its attacks have disadvantage, nearby attackers have advantage, and standing up costs half its movement.',
    glossaryTerm: 'Prone (condition)',
  },
  'condition.restrained': {
    title: 'Restrained',
    text: 'Speed 0, attacks at disadvantage, attacks against it at advantage, and Dexterity saves at disadvantage.',
    glossaryTerm: 'Restrained (condition)',
  },
  'condition.stunned': {
    title: 'Stunned',
    text: 'Cannot act, its speed is 0 and its Strength and Dexterity saves fail; attacks against it have advantage.',
    glossaryTerm: 'Stunned (condition)',
  },
  'condition.unconscious': {
    title: 'Unconscious',
    text: 'Out cold and prone: it drops what it holds, attacks against it have advantage, and hits within 5 ft are critical.',
    glossaryTerm: 'Unconscious (condition)',
  },

  // --- weapons, armour and the fine print -------------------------------
  grip: {
    title: 'Versatile grip',
    text: 'A versatile weapon does more damage held in two hands. Free a hand - put the shield away - and the bigger die is yours.',
    glossaryTerm: 'Melee Attacks',
  },
  heavy: {
    title: 'Heavy weapon',
    text: 'A big weapon needs Strength 13 in melee, or Dexterity 13 at range. Below that you swing it at disadvantage.',
    glossaryTerm: 'Melee Attacks',
  },
  ranged_in_melee: {
    title: 'Shooting in a crowd',
    text: 'Loosing an arrow with an enemy right beside you is rushed work: the attack has disadvantage.',
    glossaryTerm: 'Ranged Attacks',
  },
  armor_proficiency: {
    title: 'Armour proficiency',
    text: 'Armour you were never trained in fights you: every Strength and Dexterity d20 test has disadvantage, and you cannot cast spells at all.',
    glossaryTerm: 'Equipment Proficiencies',
  },
  stealth_disadvantage: {
    title: 'Stealth disadvantage',
    text: 'Some armour is too noisy or cumbersome to sneak in: it gives disadvantage on Stealth checks while worn.',
    glossaryTerm: 'Stealth (skill)',
  },
  attunement: {
    title: 'Attunement',
    text: 'Up to three magic items; attuning takes a short rest.',
  },
  magic_charges: {
    title: 'Charges',
    text: 'Spent with use; regains at the time shown.',
  },
  weapon_proficiency: {
    title: 'Weapon proficiency',
    text: 'You can swing any weapon, but only a weapon you are trained in adds your proficiency bonus to the attack roll.',
    glossaryTerm: 'Equipment Proficiencies',
  },
  tool_proficiency: {
    title: 'Tool proficiency',
    text: 'A tool you are trained in adds your proficiency bonus to the check. If a skill you are also trained in applies, you roll with advantage instead.',
    glossaryTerm: 'Proficiencies',
  },
  surprise: {
    title: 'Surprised',
    text: 'Caught completely off guard at the start of a fight: you roll initiative with disadvantage, so you are likely to act late.',
    glossaryTerm: ORDER_OF_COMBAT,
  },
  stable: {
    title: 'Stable',
    text: 'Steadied at 0 hit points: you stop rolling death saves and stay unconscious until you are healed or hurt again.',
    glossaryTerm: 'Dropping to 0 Hit Points',
  },
  spellbook: {
    title: 'Spellbook',
    text: 'A Wizard only prepares from the spells written in their book. Levelling copies two more in, and spells found in play can be copied too.',
    glossaryTerm: 'Spellcasting',
  },
  always_prepared: {
    title: 'Always prepared',
    text: 'A feat or trait gave you this spell outright. It is always ready to cast and never counts against the spells your class prepares.',
    glossaryTerm: 'Spellcasting',
  },
  spell_swap: {
    title: 'Swapping a spell',
    text: 'Every time you gain a level you may trade one spell you know for another your class can learn. It is optional: leave it alone and nothing changes.',
    glossaryTerm: 'Spellcasting',
  },
  expertise: {
    title: 'Expertise',
    text: 'Two skills you are already proficient in count your proficiency bonus twice. Pick the ones you lean on most.',
    glossaryTerm: 'Proficiency Bonus',
  },
  fighting_style: {
    title: 'Fighting Style',
    text: 'The way you fight, chosen once: archery adds to your bow attacks, defence to your armour, and so on.',
  },
  metamagic: {
    title: 'Metamagic',
    text: 'A Sorcerer bends a spell as it is cast — further, faster, or on two targets — by spending sorcery points.',
  },
  invocations: {
    title: 'Eldritch Invocations',
    text: 'Scraps of forbidden lore your patron grants: small permanent powers, some of which need a higher Warlock level.',
  },
  languages: {
    title: 'Languages',
    text: 'The tongues you can speak, read and understand. Anything said in one you do not know is simply noise, and the DM narrates what you miss.',
  },
  ruling: {
    title: 'DM ruling',
    text: 'The DM allowed something the rules do not spell out, and said why. It stands for this moment only.',
  },

  // --- progression --------------------------------------------------------
  power_budget: {
    title: 'Power budget',
    text: 'What one feat is worth, priced in quarters: a +2 to an ability or an extra 1d6 on every hit each cost the whole of it. Anything the DM invents is measured against it.',
  },
  rules_mode: {
    title: 'Rules mode',
    text: 'How far the DM may go beyond the rulebook: strict keeps to it, flexible asks you before anything too strong, freeform allows whatever you two like.',
  },
  xp_mode: {
    title: 'XP mode',
    text: 'How you reach the next level: by adding up experience points, or when the story reaches the beat the DM has set for it.',
  },
  milestone: {
    title: 'Milestone',
    text: 'Levelling by story rather than by arithmetic: no points are counted and the DM says when the next level has been earned.',
  },
  library: {
    title: 'Library',
    text: 'Everything invented for you, in two lists: what belongs to this story, and what you have kept for every story you play.',
  },
  custom_subclass: {
    title: 'Custom subclass',
    text: 'A subclass the DM built for you rather than one from the rulebook. It is priced against the same power budget as any other option.',
  },
  custom_spell: {
    title: 'Custom spell',
    text: 'A spell the DM built for you rather than one from the rulebook. It is priced against the same power budget as any other option.',
  },
  session_rhythm: {
    title: 'Play rhythm',
    text: 'One chat per play session. Start with load_campaign, finish with save_checkpoint, and open a new chat next time — long chats forget rules. After a server update, refresh the dnd tunnel app in ChatGPT.',
  },

  // --- the story and the codex -------------------------------------------
  'story.act': {
    title: 'Act',
    text: 'The largest piece of the story, a few chapters long. Most tales run to three: the setup, the trouble, and the reckoning.',
  },
  'story.chapter': {
    title: 'Chapter',
    text: 'A stretch of play with one goal, closed with a recap when the goal is met or lost. The story then opens the next one.',
  },
  'story.thread': {
    title: 'Plot thread',
    text: 'A question the story has not answered yet. It stays open until something in play resolves it or it is dropped.',
  },
  'story.clue': {
    title: 'Clue',
    text: 'A piece of an answer to one thread. Planted means it is out there to be found; found means your character has it.',
  },
  'story.rumour_scope': {
    title: 'Rumour scope',
    text: 'How far the talk has carried: a whole world, one region, or the room you heard it in. Wide talk is vaguer than local talk.',
  },
  'story.journal': {
    title: 'Journal',
    text: 'Your own notes, written by you and never by the DM. The DM can read them, so they are a fine way to say what you plan.',
  },
  'codex.voice_card': {
    title: 'Voice card',
    text: 'How this character sounds and what drives them: speech, a catchphrase, what they want, what they fear, how they treat you.',
  },
  'codex.relations': {
    title: 'Relationship',
    text: 'A tie between two named things in the story: family, allegiance or regard. Each tie reads from both ends.',
  },
  'relation.parent': { title: 'Parent of', text: 'This one is the parent of the names listed under it.' },
  'relation.child': { title: 'Child of', text: 'This one is the child of the names listed under it.' },
  'relation.spouse': { title: 'Married to', text: 'Married or bonded to the name listed, in whatever form this world keeps.' },
  'relation.sibling': { title: 'Sibling of', text: 'Brother or sister to the names listed, by blood or by adoption.' },
  'relation.ally': { title: 'Ally of', text: 'Openly on the same side as the names listed, at least for now.' },
  'relation.enemy': { title: 'Enemy of', text: 'Set against the names listed, openly or otherwise.' },
  'relation.member_of': { title: 'Member of', text: 'Belongs to the faction or order listed: sworn, hired or enrolled.' },
  'relation.has_member': { title: 'Members', text: 'The people who belong to this faction or order.' },
  'relation.owns': { title: 'Owns', text: 'Holds the item or place listed, by right or by grip.' },
  'relation.owned_by': { title: 'Owned by', text: 'Held by the name listed, by right or by grip.' },
  'relation.rules': { title: 'Rules', text: 'Holds authority over the place or people listed.' },
  'relation.ruled_by': { title: 'Ruled by', text: 'Under the authority of the name listed.' },
  'relation.serves': { title: 'Serves', text: 'Works for or worships the name listed.' },
  'relation.served_by': { title: 'Served by', text: 'Served or worshipped by the names listed.' },
  'relation.knows': { title: 'Knows', text: 'Acquainted with the names listed, without anything stronger implied.' },
  'relation.rival': { title: 'Rival of', text: 'Competes with the name listed without being an outright enemy.' },
  'relation.lover': { title: 'Lover of', text: 'Romantically tied to the name listed.' },
};

/** The help for one key, or null when nothing is written for it. */
export function helpFor(key: string): Help | null {
  return HELP[key] ?? null;
}

export const HELP_KEYS = Object.keys(HELP);

/** A legal action id is `dash` or `attack:Longbow`: both look up the same help. */
export const actionHelpKey = (id: string): string =>
  // "attack:Dagger (thrown)" is the throw, not the swing, so it gets the throwing help.
  /\(thrown\)$/i.test(id) ? 'action.thrown' : `action.${id.split(':')[0]}`;

/** The flags a combatant carries, as the chip beside its name looks them up. */
const FLAG_HELP: Record<string, string> = {
  dashed: 'action.dash',
  dodging: 'action.dodge',
  disengaged: 'action.disengage',
  hidden: 'action.hide',
  helped_by: 'action.help',
  ready: 'action.ready',
  grappled_by: 'condition.grappled',
  grappling: 'action.grapple',
};

export const flagHelpKey = (flag: string): string => FLAG_HELP[flag] ?? 'conditions';

const slug = (value: string): string => value.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** "Prone" or "Heavily Obscured" -> the condition entry, else the general one. */
export function conditionHelpKey(name: string): string {
  const key = `condition.${slug(name)}`;
  return key in HELP ? key : 'conditions';
}

/** A condition's own help, with what the fight log said it does standing in for the written text. */
export function conditionHelp(name: string, effect: string | undefined): Help | null {
  const base = helpFor(conditionHelpKey(name));
  if (!base) return null;
  return effect ? { ...base, text: effect } : base;
}

/** The `as` side of a tie -> its own entry, else the general one. */
export function relationHelpKey(as: string): string {
  const key = `relation.${slug(as)}`;
  return key in HELP ? key : 'codex.relations';
}

const FEATURE_HELP: Record<string, string> = {
  expertise: 'expertise',
  fighting_style: 'fighting_style',
  metamagic: 'metamagic',
  eldritch_invocations: 'invocations',
};

/** A level-up feature that is itself a choice -> its entry, or nothing when it has none. */
export const featureHelpKey = (feature: string): string | null => FEATURE_HELP[slug(feature)] ?? null;

export const typeHelpKey = (type: string): string => `type.${slug(type)}`;
export const sizeHelpKey = (size: string): string => `size.${slug(size)}`;

const DAMAGE_WORDS = [
  'acid',
  'bludgeoning',
  'cold',
  'fire',
  'force',
  'lightning',
  'necrotic',
  'piercing',
  'poison',
  'psychic',
  'radiant',
  'slashing',
  'thunder',
];

/** "piercing from nonmagical attacks" is still piercing; anything with no damage word has no help. */
export function damageHelpKey(token: string): string | null {
  const words = token.toLowerCase();
  const found = DAMAGE_WORDS.find((word) => words.includes(word));
  return found ? `damage.${found}` : null;
}

const SENSE_NAMES = ['darkvision', 'blindsight', 'tremorsense', 'truesight', 'passive perception'];

/** "Darkvision 60 ft." -> the darkvision help with its own range read into the wording. */
export function senseHelp(token: string): Help | null {
  const clean = token.trim();
  const name = SENSE_NAMES.find((sense) => clean.toLowerCase().startsWith(sense));
  const base = name ? HELP[`sense.${slug(name)}`] : undefined;
  if (!base) return null;
  const range = /(\d+)\s*(ft|feet)/i.exec(clean);
  return {
    ...base,
    title: clean.replace(/\.$/, '') || base.title,
    text: base.text.replace('{range}', range ? `${range[1]} ft` : 'its listed range'),
  };
}
