# Class features

Class features of all twenty levels are engine mechanics, not notes: all twelve SRD classes with their
SRD subclasses (Path of the Berserker, Champion, Thief, Warrior of the Open Hand, Oath of Devotion,
Hunter, College of Lore, Life Domain, Circle of the Land, Draconic Sorcery, Fiend Patron, Evoker). The
engine owns uses, resources, durations and dice. `get_battle_state` lists what a character may take
under `legal_actions` as `feature:<id>`; each combatant's `class_features` carries the uses left,
whether a Rage, Wild Shape or Innate Sorcery runs, and why any is left to you.

## Feature actions

**Features with an action of their own** are taken with `use_action {actor_id, action_name: "<id>"}`.
The engine spends the action, the bonus action or the reaction, spends the resource, and refuses with
what is left when there is none: `rage`, `second_wind`, `action_surge`, `cunning_action_dash`,
`cunning_action_disengage`, `cunning_action_hide`, `steady_aim`, `fast_hands`, `uncanny_dodge`,
`flurry_of_blows`, `patient_defense`, `step_of_the_wind`, `deflect_attacks`, `deflect_redirect`,
`uncanny_metabolism`, `wholeness_of_body`, `lay_on_hands` (with `amount`, or `option: "poison"`),
`divine_sense`, `abjure_foes`, `hunters_lore`, `tireless`, `bardic_inspiration` (with `target_id`),
`font_of_inspiration` (with `slot_level`), `cutting_words`, `divine_spark_heal` /
`divine_spark_radiant` / `divine_spark_necrotic` (with `target_id`), `turn_undead`, `preserve_life`,
`wild_shape` (with `option` naming the Beast), `wild_shape_revert`, `wild_resurgence_shape` (with
`slot_level`), `wild_resurgence_slot`, `lands_aid` (with `point`), `innate_sorcery`,
`font_of_magic_to_points` / `font_of_magic_to_slot` (with `slot_level`), `dark_ones_own_luck`,
`pact_weapon` (with `option` naming the weapon). From level 11: `intimidating_presence`,
`fleet_step` (or `fleet_step_focus`), `persistent_rage_regain`, `natures_veil`, `superior_hunters_defense`, `superior_defense`, `quivering_palm`
(with `target_id`, to end the vibrations), `holy_nimbus`, `natures_sanctuary` (with `point`),
`natures_magician` (with `amount`), `lay_on_hands_blinded` and its five siblings (Restoring Touch),
and the five stances (topic `stances-and-epic-boons`). An id a character has no feature for is
refused and the reply names the ones it does have; so is any other id-shaped `action_name` the engine
does not know, rather than spending the Action on nothing. Anything the engine has no feature for is
named in words, with its own dice and DC.

## Feature action details

**Patient Defense** and **Step of the Wind** are the free halves of Monk's Focus: Disengage, or Dash, as
a Bonus Action for nothing. Pass `option: "focus"` (or the id `patient_defense_focus` /
`step_of_the_wind_focus`) to spend 1 Focus Point for Disengage **and** Dodge, or Disengage **and** Dash
with the jump distance doubled for the turn. **Fleet Step** takes Step of the Wind on the heels of
another Bonus Action and takes the same option: `fleet_step` for the free Dash, `fleet_step_focus` for
both halves.

**Persistent Rage is offered, never taken for the Barbarian.** Its text says "you can regain", so
rolling Initiative answers with `persistent_rage_available` naming the uses of Rage on offer, and
nothing moves until `use_action {action_name: "persistent_rage_regain"}` takes them. It costs no
action, and the window closes at the end of that Barbarian's first turn of the fight.

**An action whose uses are gone stays on offer when something else buys it back.** Intimidating
Presence costs a use of Rage once its own use is spent, and Holy Nimbus a level 5 spell slot; both stay
in `legal_actions` at 0 uses while that fallback is affordable, and the hint names what the next one
will cost.

**Steady Aim** needs a Rogue who has not moved yet this turn, and the engine refuses it once they have.
Movement paid for by a Dash or a Tactical Shift counts the same as any other; being pushed or dragged
does not, because that is not the Rogue moving.

**Action Surge** buys one more action, the Magic action excepted: while the surged action is still
unspent the engine refuses a spell cast as an Action, and taking any other action clears it.

## Attack flags

**Features the player chooses per swing** are flags on `attack`: `reckless` (Barbarian, Advantage on
Strength attacks until your next turn and Advantage on attacks against you), `brutal_strike`
(`"forceful"`, `"hamstring"`, and `"staggering"` or `"sundering"` from level 13, bought by giving that
Advantage up; an array of two different effects from level 17, when the dice become 2d10),
`sneak_attack: false` to keep the turn's one Sneak Attack back, `cunning_strike` (`["poison"]`,
`["trip"]`, `["withdraw"]` at one Sneak Attack die each, and `["daze"]` at two, `["obscure"]` at three
and `["knock_out"]` at six from level 14 - two effects at once from level 11, and at least one die has
to be left to deal damage with; **Daze is yours to enforce**, because the SRD has no Dazed condition:
the reply states the CON save and the limit it puts on the creature's next turn, and nothing lands on
the creature), `stunning_strike`, `flurry` (one of the Unarmed Strikes the bonus
action bought), `empowered_strike` (Force damage), `mastery_property` (Tactical Master),
`sacred_weapon` (Paladin, on an attack of the Attack action), `quivering_palm` (Monk 17, 4 Focus
Points on an Unarmed Strike), `hurl_through_hell` (Warlock 14, once a turn), `prey_target_id`
(Ranger 11, the second creature the Hunter's Mark damage jumps to), `peerless_aim` (Boon of Combat
Prowess, turn this miss into a hit). Everything unconditional
applies itself and is reported under `features` in the reply: Rage Damage, Sneak Attack, Frenzy,
Colossus Slayer, Hunter's Mark. Narrate what the reply says; never add the damage yourself.

## Rage and Wild Shape

**Rage** is a bonus action that lasts until the end of the Barbarian's next turn and extends itself
whenever they attack, force a save, or spend a bonus action on it again (`use_action "rage"` while
raging extends rather than spends). Entering it ends whatever the Barbarian was concentrating on, with a
line in the log. While it runs: Resistance to bludgeoning, piercing and slashing, Rage Damage on
Strength attacks, Advantage on Strength checks and saves, and no spells and no Concentration - the
engine refuses an SRD spell, a custom spell and any `concentration: true` action outright. It ends on the turn it was not extended, when
they are Incapacitated, or after ten minutes, with a line in the log.

**Wild Shape** puts the Beast's game statistics on the Druid: `use_action {action_name: "wild_shape",
option: "Wolf"}` swaps in the creature's Armor Class, Speed, senses and attacks, hands out temporary
hit points equal to the Druid level, and leaves the hit points, the class features and the mental
scores where they are. The Druid keeps every skill and saving throw proficiency with their own
proficiency bonus, and what their features make them resist or shrug off holds inside the Beast; the
Beast's own modifier is used wherever it is the higher one. `get_battle_state` shows the form under the combatant's `known` block and the
result carries `wild_shape {form, ac, speed, attacks}`. The form lasts half the Druid's level in
hours, and ends early on `wild_shape_revert` (a Bonus Action, no use), when the Druid is
Incapacitated, or when the hours run out. **No spells while shifted** - the engine refuses them - and
the level table gates the form: CR 1/4 and no Fly Speed at 2, CR 1/2 at 4, CR 1 and flight at 8.

## Reactions

**Reactions are offered, not taken.** A hit answers with `reactions_available` when the one who was
hit could still spend a reaction on Uncanny Dodge, Deflect Attacks or Retaliation. Uncanny Dodge and
Deflect Attacks are **declared before the blow**: `use_action {action_name: "uncanny_dodge"}` spends
the reaction and the next attack the character can see is halved (Deflect Attacks takes
1d10 + DEX + level off it instead). Either one works on the attack's **whole** damage - the weapon dice
and every rider on them, Sneak Attack and a smite included - and what is left is taken out of the parts
in order, weapon damage first. Offer it; let the player decide. Retaliation is an
`attack {out_of_turn: true, reason: "Retaliation"}`.

A Deflect Attacks that takes the blow to 0 answers with
`deflect_redirect_available {attacker_id, within_ft}`:
`use_action {action_name: "deflect_redirect", target_id, out_of_turn: true, reason: "Deflect Attacks"}`
spends 1 Focus Point and no second reaction, and the creature makes a DEX save against 8 + WIS +
proficiency bonus or takes two rolls of the Martial Arts die + DEX in the attack's own damage type. The
window closes at the next turn boundary.

**Cutting Words** is the College of Lore's reaction, declared the same way a stance is:
`use_action {action_name: "cutting_words", out_of_turn: true, reason: "Cutting Words"}` spends the
reaction and a use of Bardic Inspiration, and the next attack roll by an enemy within 60 ft is cut by
the die. An attack answers with the offer under `reactions_available` while the Bard can still take
it. Subtracting the die from a damage roll or an ability check instead is yours to narrate.

## Smites and auras

**Sacred Weapon** is not an action of its own: it rides on the Attack action as
`attack {sacred_weapon: true}` on one of that action's melee swings. It spends a Channel Divinity before
the roll and blesses that weapon for 10 minutes - Charisma (minimum +1) on its attack rolls, Radiant
damage at will, bright light in a 20 ft radius - and the fight log names it on every attack it helps.

**Divine Smite** is a spell that follows a melee hit. The hit answers with
`smite_ready: {target_id, action}`; inside the same turn,
`use_action {actor_id, spell: "Divine Smite", slot_level?}` lands 2d8 Radiant (one more d8 per slot
level above 1, and one more against a Fiend or an Undead). Leaving `slot_level` out spends the free
casting Paladin's Smite gives once a long rest. **Hunter's Mark** works the same way for the free
castings of Favored Enemy: `use_action {spell: "Hunter's Mark", target_id}` marks the quarry, and
every later weapon hit on it by that Ranger carries 1d6 force damage on its own.

**The auras at the top of the table.** Aura Expansion widens every aura of that Paladin's to 30 ft,
Smite of Protection gives everyone inside Half Cover until the Paladin's next turn, so it covers them
through the enemies' own turns in between (the attack log says so), and Holy Nimbus burns each enemy
that starts its turn inside for Charisma + proficiency bonus in Radiant damage. Advantage on the saves a Fiend or an Undead forces is yours to pass, because
the engine does not know what forced a save.

## Inspiration and Channel Divinity

**Bardic Inspiration** is a Bonus Action that hands a creature within 60 ft one die of the Bard's
level (d6, d8 at 5, d10 at 10) - `use_action {action_name: "bardic_inspiration", target_id}` - and the
die is held on **that creature's** sheet until it is rolled. Because a tool call cannot stop halfway
through a roll to ask, the die is **declared before** the roll it might save: `attack {inspiration:
true}` in a fight and `roll {bardic_inspiration: true, dc}` outside one. The engine rolls the die only
when the test would otherwise fail, and spends it only when it turns the failure into a success, so a
hopeful declaration never throws the die away. An attack the die could not save answers with
`bardic_inspiration_available` to remind you it is still there.

**Channel Divinity** is the Cleric's two effects on one resource: `divine_spark_heal`,
`divine_spark_radiant` or `divine_spark_necrotic` at a creature within 30 ft (1d8 + WIS, another d8 at
7, 13 and 18, half damage on a successful CON save), and `turn_undead`, which forces a WIS save on
every Undead within 30 ft and leaves the ones that fail Frightened and Incapacitated for a fixed
minute - ten rounds, no repeat save, and it ends the moment that creature takes any damage;
Sear Undead adds WIS d8 Radiant to each of them from level 5. Turn Undead is refused, and costs
nothing, when there is no Undead in range. **Preserve Life** pours five times the Cleric's level into
the Bloodied within 30 ft, the Cleric included and whichever side they are on, and never past half
their hit points; name one with `target_id` to pour it all into them.

## Metamagic and Overchannel

**Metamagic** rides on `use_action {spell, metamagic: ["Quickened Spell", ...]}`. The engine checks
the Sorcerer knows the option, that only one rides on a casting (Empowered Spell and Seeking Spell may
always come along, and Sorcery Incarnate allows two while Innate Sorcery runs), and that the sorcery
points are there - and that the slot the casting costs is there - all before anything is spent, so a
refused casting leaves no points behind. Careful Spell takes `careful_targets` and is refused without
them, Twinned Spell `twin_target` and only on a spell a higher-level slot would reach an additional
creature with (Charm Person yes, Fireball no), Heightened Spell `heighten_target`, Transmuted Spell
`transmute_to`; Quickened Spell turns the casting into a Bonus Action and locks the turn's other level
1+ casting out, Distant Spell doubles the range, Empowered Spell rerolls the lowest damage dice,
Seeking Spell rerolls a missed spell attack, Extended Spell doubles the duration and gives Advantage
on the saves that keep its Concentration, and Subtle Spell is narrated. **Font of Magic** turns a slot
into points (`font_of_magic_to_points`) and points into a slot (`font_of_magic_to_slot`), by the table
the SRD prints. A created slot is a bonus one beside the class table's: no slot need be expended to
make it, it is spent before the table's own, and it vanishes on a long rest. Wild Resurgence's slot
works the same way.

**Overchannel** is `use_action {spell, slot_level, overchannel: true}` on a damaging Wizard spell cast
with a slot of level 1 to 5: every die comes up at its highest. The first use each long rest is free;
each one after it burns the Evoker for 2d12 Necrotic per slot level, a d12 more each time, and no
Resistance or Immunity softens that.

## Casting features

**The caster's own features shape the casting**, and the reply says which: Innate Sorcery's +1 to the
save DC and Advantage on Sorcerer spell attacks, Metamagic under `spell_modifiers`, Sculpt Spells
(`sculpt: [ids]`, up to 1 + the spell's level creatures carved out of an Evocation), Potent Cantrip
(half damage on a save or a miss), Empowered Evocation, Elemental Affinity and Agonizing Blast under
`features`, and Disciple of Life and Blessed Healer on the healing line. A damage bonus that the SRD
puts on "one damage roll of that spell" lands once, however many creatures the spell caught.

**A spell a feature pays for** is `use_action {spell, free_cast: "divine_intervention"}` (any Cleric
spell of level 5 or lower, once per long rest - and Wish itself once Greater Divine Intervention
arrives at 20, after which the feature waits 2d4 long rests, which is yours to count),
`free_cast: "mystic_arcanum"` (Warlock 11+, the one Warlock spell chosen at each of levels 6, 7, 8 and
9 as the table hands them out at 11, 13, 15 and 17, once a long rest each; another spell of that level
is refused, naming the one the level-up recorded), `free_cast: "spell_mastery"` (Wizard 18, the
chosen level 1 and level 2 spells at will), `free_cast: "signature_spell"` (Wizard 20, each of the two
level 3 signature spells once before a rest), `free_cast: "natural_recovery"` (one prepared Circle
spell), or `free_cast: "wild_companion" | "pact_of_the_chain"` with `option` naming the animal - both
cast Find Familiar as a Magic action rather than over an hour, the Druid for a use of Wild Shape and
the Warlock for nothing, and the familiar joins the fight as a companion of the chosen form (Bat, Cat,
Frog, Hawk, Lizard, Octopus, Owl, Rat, Raven, Spider or Weasel). Everything else that casts for free
applies itself.

## Eldritch Invocations

**Eldritch Invocations** apply themselves off the sheet: Agonizing Blast and Repelling Blast on a
Warlock cantrip, Pact of the Blade's Charisma on a Melee weapon, Thirsting Blade's second attack,
Eldritch Smite as `attack {eldritch_smite: true}` (a Pact Magic slot for 1d8 Force per slot level plus
one, and Prone), Lifedrinker's 1d6, Eldritch Mind's Advantage on Concentration saves, and the ones
that simply cast a spell with no slot (Armor of Shadows, Fiendish Vigor and the rest, which need
nothing but the spell's own name). Gift of the Depths counts its free Water Breathing: one per long
rest, and the next comes out of a Pact Magic slot. The ones the engine leaves alone say so in the
sheet's `class_features` note. The level each invocation may first be taken at is read from the
bundled SRD text, so Agonizing Blast, Devil's Sight, Eldritch Spear, Fiendish Vigor, Lessons of the
First Ones, Mask of Many Faces, Misty Visions, Otherworldly Leap and Repelling Blast are Level 2+.

## Timing windows

**Once per turn means once per turn.** Sneak Attack, Stunning Strike, Colossus Slayer, Frenzy, Divine
Strike, Primal Strike, Eldritch Smite, Lifedrinker, Quivering Palm, Hurl Through Hell, Superior
Hunter's Prey and Arcane Apotheosis's free Metamagic come back at every turn boundary, so a Rogue who
sneak-attacked on its own turn may sneak again on an opportunity attack during someone else's.
Peerless Aim is not one of them: its window is "once until the start of your next turn", so it comes
back only when that Fighter's own turn comes round.

**How long a condition a hit leaves runs is a question of whose turn edge closes it.** Stunning
Strike's Stunned runs to the start of *your* next turn, Hurl Through Hell's Incapacitated to the end
of *your* next turn, and Devious Strikes' Obscure Blinded to the end of *its* next turn - so a stunned
or incapacitated creature loses the turn in between, which is the point of the feature. `get_battle_state`
lists each of them under `effects` until it ends, and the log says whose turn ended it.

**The level 11-20 features whose window is easy to get wrong.** Studied Attacks buys Advantage on your
**next** attack roll against that creature and is spent on it, hit or miss. Relentless Rage counts
every attempt, successful or not: the DC climbs 5 each time and goes back to 10 on a short or a long
rest, and the count sits on the sheet, so it survives the end of the fight. Quivering Palm carries on
one creature at a time - setting it on a new one takes it off the last, and the reply says so. Words
of Creation keeps Power Word Heal and Power Word Kill always prepared and reaches a second creature
**within 10 ft of the first** with `twin_target`; further than that is refused and costs nothing.
Survivor rolls the Champion's death saves with Advantage and counts an 18 or better as a 20, whether
the server rolls them or the player clicks the card.

## Stances and Epic Boons

**A stance on a D20 Test is declared before the roll**, the way Uncanny Dodge is declared before the
blow: a tool call cannot stop halfway through a roll to ask. `use_action {action_name: "indomitable"}`
(Fighter 9, reroll a failed save with your level on it), `"disciplined_survivor"` (Monk 14, the same
for 1 Focus Point), `"peerless_skill"` (College of Lore 14, a Bardic Inspiration die on a failed
ability check or attack roll), `"stroke_of_luck"` (Rogue 20, a failed D20 Test becomes a 20) and
`"boon_of_fate"` (2d4 on one of your own). None of them costs an action, and **the use is spent only
when the stance fires** - on the next roll of that kind that fails - so a declaration that is never
needed costs nothing. Peerless Skill goes further and keeps the die when the roll fails even with it
on. The roll's own `notes` say what happened.

**A declared stance shows in `class_features`** as `active: true` with its `stance_mode`, on every
turn until the roll it was bought for comes: `get_battle_state` tells you an Indomitable or a Boon of
Fate is still armed.

**The Epic Boon taken at 19** is a feat on the sheet, and the ones the engine applies do so on their
own: Boon of Combat Prowess turns a miss into a hit when the swing asks for it with
`attack {peerless_aim: true}` (once until the start of your next turn; a swing that asks when it is
already spent is refused), Boon of Irresistible Offense makes your
bludgeoning, piercing and slashing damage ignore Resistance and adds the raised score on a natural 20,
Boon of Spell Recall sometimes leaves a level 1-4 slot unspent, and Boon of Fate is the stance above -
lending its 2d4 to another creature within 60 ft, and subtracting it from a successful D20 Test an
enemy made, are both yours to call.
Boon of Dimensional Travel, Boon of the Night Spirit and Boon of Truesight wait for the teleport,
light and vision packages, and say so on the sheet.

## Passives and Fighting Styles

**Passives are already in the numbers.** Unarmored Defense (Barbarian and Monk), the Defense and
Archery Fighting Styles, Fast Movement, Unarmored Movement, Roving and Martial Arts show in the
sheet's `ac_breakdown`, `speed_reason` and the attack lines - do not add them again. Improved Critical
widens the critical range to 19; Danger Sense, Feral Instinct and Remarkable Athlete move the d20 and
say so in `notes`; Aura of Protection adds the Paladin's Charisma to every save inside 10 ft; Evasion
and Reliable Talent apply where the roll is made.

**The level 20 capstones that are pure numbers** are on the sheet already: Primal Champion's +4 to
Strength and Constitution, Body and Mind's +4 to Dexterity and Wisdom (both to a maximum of 25), the
saving throw proficiencies of Slippery Mind and Disciplined Survivor, and the fourth attunement slot
Use Magic Device opens. Two and Three Extra Attacks are the Attack action's count.

**Only four Fighting Styles exist here**, because those are the four the SRD carries: Archery,
Defense, Great Weapon Fighting and Two Weapon Fighting. Archery, Defense and Great Weapon Fighting
apply themselves; Great Weapon Fighting's floor of 3 on a damage die needs the server to have rolled
that die, so it is skipped when the player rolled their own damage. Two Weapon Fighting waits for
two-weapon fighting itself. Dueling, Protection, Interception and the rest are not SRD content: if a
player wants one, write it as homebrew with `propose {op: feature}`.

## Left to you

**Left to you, and why.** Tactical Mind and Countercharm (no reroll seam on a resolved roll),
Primal Knowledge (an out-of-combat check), Second-Story Work, Slow Fall, Acrobatic Movement and
Roving's climb and swim speeds (movement modes are not built), Supreme Sneak, Devil's Sight and Witch
Sight (vision and cover), Defensive Tactics (the engine does not know an attack is an opportunity
attack), Faithful Steed and Investment of the Chain Master (summoning), Thieves' Cant and Druidic,
Ritual Adept (ritual casting arrives with R8), Magical Cunning (a 1-minute rite, which has no seam in
or out of a fight: give back half the Pact Magic slots yourself, once per long rest), Contact Patron
(Contact Other Plane takes a minute to cast), Pact of the Tome (its cantrips and rituals are added
with `spells {op: learn}`), Gift of the Protectors, Hunter's Prey's Horde Breaker (its second attack is
another `attack` call, which the reply asks you for), and Open Hand Technique's Addle, Push and
Topple, which the reply names on every Flurry hit for you to apply. Nature's Ward names the Poisoned
immunity itself and leaves the land's Resistance to you until a land is recorded on the sheet. From
level 11: Thief's Reflexes (two turns in the first round needs a second slot in the initiative order -
take the second turn with `out_of_turn` calls at initiative minus 10), Feral Senses (Blindsight),
Dragon Wings (flight), Dragon Companion (Summon Dragon needs a summoning model) and Eldritch Master
(it rides on Magical Cunning, a rite between fights). Nature's Sanctuary spends the use of Wild Shape
and describes the grove; the Half Cover and the borrowed Resistance inside it are yours to apply,
because the engine keeps no standing zone on the map.
