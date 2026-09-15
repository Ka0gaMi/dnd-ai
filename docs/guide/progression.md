# Progression: levelling, homebrew and the play profile

Read this before you hand out a level, invent a feature or write a background.

## How this table advances

Two dials in the campaign settings decide everything here.

- `xp_mode` — `xp` (default) counts experience points, `milestone` levels on story beats.
- `rules_mode` — `strict`, `flexible` (default) or `freeform`. It decides what happens when you
  invent something the rules do not cover.

You never set these. They are the player's; read them from the briefing and follow them.

## Awarding advancement

**XP campaigns.** Call `award_xp` after a fight, a solved problem or a finished quest step. When
the total crosses the threshold the result says `level_up_available: true` and carries
`level_up_options` — hit points, new features, and any subclass, feat or spell decision.

**Milestone campaigns.** `award_xp` counts nothing and tells you so. Call `grant_level` at the
beat the level belongs to: the villain falls, the chapter closes, the oath is sworn. It returns the
same `level_up_options`.

Either way the sheet does not change yet.

## The level-up window

Call `propose_level_up_options` next. It puts the SRD options into the player's window together
with your own suggestions, each with a justification and a power report. Base those suggestions on
`get_play_profile`, not on the class list: the point is to offer the thing they have been trying to
do all campaign, not the thing the book says comes next.

Recommend from the rulebook first. The window carries every SRD option the player may take, each
with a `details` entry your tooltip text comes from — what a spell costs to cast, how far it
reaches, what a feat or a subclass actually does. Pass `recommendations` naming the spells,
cantrips, subclass, feat, ability scores or hit point method you would take, each with a `why` a
novice understands: say what the spell does in play ("Grease turns a corridor into a slide, which
is how you have won every fight this chapter"), not which keyword it has. Names are checked against
the options on offer, so a recommendation is always something they can pick. Only then add
suggestions of your own, for what the rules do not cover.

```
propose_level_up_options{campaign_id, recommendations: {
  spells: [{name: "Grease", why: "Drops everyone in a corridor on their back; your traps do the rest."}],
  hp: "average"
}, suggestions: [
  {name: "Snare Master", text: "...", mechanics: {skill_proficiencies: ["stealth"]},
   justification: "Every fight this chapter started with a trap."}
]}
```

**One homebrew suggestion per level-up.** Send the one you believe in; a second is refused with the
name of the one that was kept, and you can offer the rest at a later level. The SRD
recommendations are not limited — recommend freely from what the rules already give.

The player chooses in their window, and the server applies it. If they tell you their choices in
chat instead, call `level_up` with them (`homebrew_ids` carries anything they picked from your
suggestions or from the library). Levels 2 through 20 are supported, with an Epic Boon on offer at
19; a companion built from a class can level the same way (pass its `character_id`), but a
stat-block companion cannot.

## What a level asks for

`level_up_options` carries every question the level puts to the player. Ask them all before you call
`level_up`; anything missing comes back as an error naming what is still needed.

**Features that are a choice.** Expertise, a Fighting Style, Metamagic, Eldritch Invocations, Divine
Order, Primal Order, Blessed Strikes, Elemental Fury, Scholar, the College of Lore's Bonus
Proficiencies and Magical Discoveries, the Draconic sorcerer's Elemental Affinity, the Warlock's
Mystic Arcanum (one spell at each of 11, 13, 15 and 17, a level higher each time, and that spell is the
only one the arcanum casts) and the Wizard's
Spell Mastery at 18 and Signature Spells at 20 all arrive as `feature_choices`, each with the pool it
must be picked from. Answer with
`choices.feature_options: {"Expertise": ["stealth", "perception"]}`. Expertise doubles the bonus of
skills the character is already proficient in, so only those are on offer; a Fighting Style is stored
with its numbers, and the invocation list grows with the Warlock table (1 at level 1, 3 at 2, 5 at 5,
6 at 7, 7 at 9, 8 at 12, 9 at 15, 10 at 18). Each invocation is offered at the level its own SRD text
gives it and only once the Pact it names is held, so level 1 offers Armor of Shadows, Eldritch Mind
and the three Pacts, and Agonizing Blast and its like wait for level 2. The picks are applied, not just recorded: Divine Order
(Protector) and Primal Order (Warden) add the weapon and armour training, Scholar adds the Expertise,
Bonus Proficiencies adds the three skills, and the combat engine reads Blessed Strikes, Elemental
Fury, Elemental Affinity and the invocations off the sheet.

**Feats.** A feat is no longer just text: its ability increase, proficiencies, spells and numbers are
applied when it is taken. The ones that need an answer say so in `choices` beside the feat in the
options — which ability Grappler raises, which three proficiencies Skilled grants, which list Magic
Initiate draws on and which ability casts its spells. Send them as `choices.feat_choices`. A general
feat needs level 4 and whatever prerequisite it lists. An ability score stops at 20; only an Epic Boon
at 19 goes past it, to 30, and an increase that would break the cap is refused rather than trimmed.

**Spells.** Every caster may swap one cantrip when they gain a level:
`choices.replace_cantrip {old, new}`. Bards, Rangers, Sorcerers and Warlocks may also swap one spell,
`choices.replace_spell {old, new}`. Clerics, Druids, Paladins and Wizards do not: they change their
whole list after a long rest instead (see below). A Wizard also copies two new spells into their
spellbook at every level, `choices.spellbook: [a, b]`.

## What the engine does with a class feature

For all twelve classes every class feature of every level, and their SRD subclass features, are real
mechanics in combat: the engine owns their uses, their resources, their duration and their dice, lists
them in `legal_actions` and carries them on every combatant as `class_features`. The combat guide
says how each one is taken. The handful the engine hands back name the reason on the sheet (the combat
guide lists them).

**What a level-up writes on the sheet itself** at the top of the table: Primal Champion adds 4 to
Strength and Constitution at Barbarian 20 and Body and Mind adds 4 to Dexterity and Wisdom at Monk 20,
both to a maximum of 25; Slippery Mind makes a Rogue proficient in Wisdom and Charisma saving throws
at 15 and Disciplined Survivor makes a Monk proficient in all of them at 14; Use Magic Device gives a
Thief a fourth attunement slot at 13; Words of Creation keeps Power Word Heal and Power Word Kill
always prepared at Bard 20, beside what the table lets that Bard prepare. The level-up reply names
each one beside the feature. Primal Champion's Constitution raises `hp_max` retroactively, for every
level already taken and not just the twentieth, because the maximum is derived from the score.

Some features are a choice the player makes at level-up and the engine then reads: the **Fighting
Style** feat (only the four the SRD carries - Archery, Defense, Great Weapon Fighting, Two Weapon
Fighting; anything else is homebrew through `propose_feature`), the Hunter's **Hunter's Prey**
(Colossus Slayer or Horde Breaker), **Divine Order**, **Primal Order**, **Blessed Strikes**,
**Elemental Fury**, **Scholar** and **Elemental Affinity**. All come back from `level_up_options`
under `feature_choices`. Cunning Strike is not one of these: a Rogue picks its effect on each swing,
as a flag on `attack`, and a Sorcerer names its Metamagic on each casting the same way.

**A rest is where some of them are spent.** `rest {kind: "short"}` takes `arcane_recovery`,
`natural_recovery` and `sorcerous_restoration` (each once per long rest) and `memorize_spell
{replace, with}` for a level 5 Wizard; either rest takes `fiendish_resilience` with the damage type a
Fiend warlock resists until the next one. Each is refused, with the reason, when the character has no
such feature or has already spent it.

## Preparing spells

`prepared` is what the character can cast today; `known` is what they have learned. The class table's
prepared count is the size of the list, and it is enforced.

- **Cleric, Druid, Paladin, Wizard** rewrite the whole list after a long rest with
  `prepare_spells {character_id, spells}`. The list must be exactly the length the table gives, nothing
  above the level they can cast, and a Wizard may only prepare what is written in their spellbook.
- **Bard, Ranger, Sorcerer, Warlock** keep what they know and swap one spell on levelling. A Bard of
  level 10 has Magical Secrets, so the Cleric, Druid and Wizard lists are offered to them as well.
- A **Wizard's spellbook** starts with six level 1 spells - the four they have prepared plus two more,
  `create_character {spellbook}` - and grows by two at each level. Anything else they find - a scroll,
  a dead rival's book, a master's gift - is `learn_spell {character_id, spell}`. The gold and the hours
  that costs are yours to narrate; the tool only records the page.
- Everyone else gets a spell outside a level-up with `grant_spell {character_id, spell, reason}`: a pick
  a duplicate ate, a boon, a quest reward. It must be on their class list and no higher than they cast,
  and the reason is logged as your ruling.

## Languages and tools

Every character knows Common and two more languages, chosen at creation from
`list_character_options`. `add_language {campaign_id, name, speakers, script}` invents one for this
world - it joins the list wherever a language is chosen and shows up in the glossary - and
`grant_language {character_id, name}` teaches one in play. What a character speaks is on the sheet
under `proficiencies.languages`, and a check to understand a language they do not know is refused by
the `roll` tool rather than rolled.

Tool proficiencies come from the class, the background and the Skilled feat. They matter on a check:
see the rolls guide for what `roll {tool}` does with them.

## Tagging play

Call `note_play` once or twice a session, when the player does something characteristic: rigging a
trap, talking down a guard, setting the room on fire. One sentence, in their words where you can,
with tags from the fixed list (`improvise`, `engineering`, `trap`, `environment`, `stealth`,
`social`, `brute_force`, `magic`, `ranged`, `melee`, `leadership`, `mercy`, `cruelty`,
`exploration`, `investigation`).

`get_play_profile` reads it back: tag counts, your best lines, and what the engine has seen — the
skills they roll, the attacks and actions they use, the effects they leave on the battlefield. It
costs nothing to call and it is the only honest answer to "what do they enjoy?".

## Inventing a feature

`propose_feature` prices what you invented against the **power budget**: one feat's worth of power,
which is also what the level 1 origin feat and the level 4 ability score improvement are worth.

| Part | Cost |
| --- | --- |
| +2 to an ability score | 1 (+1 costs 0.5) |
| +1 to hit, or +1 AC | 0.5 each |
| extra 1d6 damage once a turn | 0.25 (on every hit: 0.5) |
| a line of prose the engine only reminds you of | 0.25 |
| a skill proficiency | 0.25 |
| +10 ft speed | 0.5 |
| a damage resistance | 0.5 |
| a 1st-level spell | 0.5 |

Write what it does as **clauses** — `when` it fires, what narrows it, what it `do`es, how often and
who decides — and price them with `check_mechanics` before you propose: clauses are what the engine
runs, and a narrow or rare clause costs a fraction of an always-on one. The older `mechanics`
numbers are still accepted and converted for you; prose alone is a reminder, not a rule. The verbs,
the five rules and the worked examples are in `read_guide{section: "homebrew"}`.

What happens next follows `rules_mode`:

- **strict** — anything over budget is refused and you get the report. Cut it down.
- **flexible** — the player gets a dialog with the report and accepts, rejects or edits it. The tool
  waits as long as a player roll does; if they are slow the result says `awaiting_player`. Carry on
  with the scene. Their answer applies itself and reaches you as a `homebrew_decision` event and in
  the next briefing ("Player accepted 'Trapwright' despite the over-budget warning"). Never
  re-propose a feature you are already waiting on, and never narrate the feature as theirs until
  the answer is in.
- **freeform** — applied at once, with a warning when it is strong.

If the player asks for something deliberately overpowered, set `allow_over_budget: true`. It goes
on the sheet with an over-budget marker their window shows, so the choice stays visible. Never set
that flag on your own.

**One story boon per chapter.** A feature you hand out mid-story is a chapter's worth of reward. If
one has already gone on the sheet since the current chapter opened - or, while no chapter is open,
since this session began - a second follows `rules_mode`: strict refuses it, flexible puts it to the
player, freeform applies it with a `cadence_warning`. Close the chapter before the next boon, or make
the reward something that is not a feature. Only what `propose_feature` applied counts: a homebrew
spell is not a boon.

## Writing a background

`create_background` writes a 2024-shaped background for this campaign: three ability scores, an
origin feat, two skill proficiencies, a tool and starting equipment.

```
create_background{campaign_id, name: "Trapwright", abilities: ["dex","int","wis"],
  origin_feat: "Alert",                       // or {name, text, mechanics} for one you invent
  skills: ["stealth","investigation"], tool: "Thieves' Tools",
  equipment: {items: [{name: "Dagger", qty: 1}], gold: 15},
  text: "You grew up rigging snares under the city."}
```

The shape is validated and the origin feat is measured against the budget (an SRD feat is exactly
1). Afterwards pass the name to `create_character` like any SRD background. Custom backgrounds win
over SRD ones of the same name.

## Writing a subclass

`propose_subclass` takes a subclass you wrote for one class: its name, a line of flavour, and its
features keyed by the level they arrive at — `"3"`, `"6"`, `"10"`, `"14"` for most classes, and for
the rest whatever levels that class's SRD subclass uses.

Each bundle is priced on its own against the SRD subclass of the same class at the same level, by
the table above: prose costs nothing, numbers cost what they cost, and one feat's worth per level is
what the rulebook gives. A bundle at a level where the SRD subclass gives nothing is allowed
nothing, and the report says so.

```
propose_subclass{campaign_id, justification, schema: {
  class: "Barbarian", name: "Path of the Storm", flavour_text: "The thunder answers when you roar.",
  features: {"3": [{name: "Thunderstep", text: "...", mechanics: {speed: 10}}],
             "6": [{name: "Stormheart", text: "...", mechanics: {to_hit: 1, ac: 1}}]}}}
```

When the player asks for a subclass from a book the SRD does not include, write your own version of
it and pass `recreated_from: "Oath of Vengeance"`. It is stored and returned as a label only — none
of the original text is here, and none of it is shipped with the app — so the library can say what
your version stands in for.

`rules_mode` decides the rest as it does for a feature: strict refuses, flexible asks the player,
freeform stores it with a warning. Storing it puts nothing on a sheet — it
joins the SRD subclass on the level-up window's subclass list with `homebrew: true`, its
`homebrew_id` and its power label. The player picks it there, or you call `level_up` with
`subclass_homebrew_id`. Its later bundles then arrive by themselves at the levels they are written
for.

## Writing a spell

`propose_spell` takes a spell as data, not prose: level, school, casting time, range, components,
duration, concentration, ritual, the classes that may cast it, and an `effect` saying whether it is
an `attack`, a `save`, `auto`, `heal` or `utility`, with its damage dice and type, the saving throw
ability, `half_on_save`, an area `shape`, `healing` dice or a `condition` it leaves behind.

The budget comes from the SRD itself: the median of what the SRD spells of that level actually roll,
counted apart for single targets, for areas and for healing, with a condition on top costing a
quarter of that budget and a spell that only changes the fiction priced at a flat 0.5. The report
names the SRD spell your dice sit beside, so "2d10 fire at level 1" comes back as above the
1st-level single-target budget rather than as an opinion.

Pass `character_id` to put it on that character's sheet — a cantrip among their cantrips, anything
else among their prepared spells; the sheet lists them again under `homebrew_spells`. In a fight the
engine runs it from that data: `use_action{action_name: "Ember Lance"}` reads the dice, the shape,
the save ability and the DC off the caster's sheet, and the slot is spent with `use_spell_slot` as
usual. Out of combat you narrate it yourself. Custom spells of an eligible level also appear among
the level-up spell options, marked `homebrew: true`.

## The personal library

`save_to_library{homebrew_id}` lifts a background, feat, feature, subclass or spell out of this campaign and into
the player's library, where every campaign can use it; `list_library` reads it back. Offer library
entries by name when you prepare a level-up — a favourite from a dead character is the easiest
suggestion you will ever make. Entries keep their power report and label wherever they go, and are
stamped with `balanced_at_level`: the level the character stood at when it was kept. Read it before
you offer one — a boon written for a level 11 character is not a level 2 gift.

## Rules the engine does not own

- What a character has earned, and when. The cadence rules above are a ceiling, not a schedule.
- Whether a homebrew feature fits the fiction: the budget prices power, not taste.
- Multiclassing, which is not supported; a character advances in the class they started in.
- Retraining and rewriting a sheet after the fact.
- Long rests as story: the server enforces the 8 hours and the one-per-24-hours rule, but whether
  the party gets to rest at all is yours.
