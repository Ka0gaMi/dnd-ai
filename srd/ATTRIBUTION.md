# SRD 5.2.1 data — attribution and licence

The JSON in this folder is game rules content from the **System Reference Document 5.2.1**,
published by Wizards of the Coast under the Creative Commons Attribution 4.0 International
Licence. The required notice:

> This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards
> of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under
> the Creative Commons Attribution 4.0 International License, available at
> https://creativecommons.org/licenses/by/4.0/legalcode.

## Where the files come from

Refresh them with `npm run srd:fetch`. Nothing in this folder is edited by hand; the one piece of
SRD content kept outside it is the creature tag table in `src/srd/data.ts`, transcribed by hand
because neither upstream dataset carries the parenthesised tag of a stat block's type line.

| Folder | Source | Used for |
|---|---|---|
| `open5e/` | [open5e/open5e-api](https://github.com/open5e/open5e-api), `data/v2/wizards-of-the-coast/srd-2024` (code modified-MIT, data CC-BY-4.0) | `Spell.json` (all 339 spells, with the class list each spell belongs to), `Rule.json` + `ConditionDescription.json` + `SkillDescription.json` + `AbilityDescription.json` (the seeded glossary), `Creature.json` + `CreatureAction.json` + `CreatureActionAttack.json` + `CreatureTrait.json` (331 stat blocks with their traits, actions and attack rolls), `ClassFeature.json` (the option lists the class tables only point at, chiefly "Metamagic Options") |
| (transcribed) | The creature **tags** of the SRD 5.2.1 Monster Manual type lines ("Small Fey (Goblinoid)"), hand-copied into `CREATURE_TAGS` in `src/srd/data.ts` | a homebrew clause narrowed by `target.type: ["goblinoid"]`: neither dataset carries the tag, only the type |
| `5e-bits/` | [5e-bits/5e-database](https://github.com/5e-bits/5e-database), `src/2024/en` (MIT) | `Classes.json`, `Levels.json`, `Features.json`, `Subclasses.json` (class tables, level progression, feature text), `Species.json` + `Traits.json`, `Backgrounds.json`, `Feats.json`, `Equipment.json`, `Skills.json`, `Magic-Items.json` (262 magic items with their rarity, attunement requirement, charges and +N), `Weapon-Properties.json` + `Weapon-Mastery-Properties.json` (the 2024 weapon property and mastery text) |

Open5e's 2024 dataset has the spells and the rules glossary but no class progression tables;
5e-bits has the class, species, background and equipment tables but no 2024 spell file. Hence both.

`ClassFeature.json` is Open5e's class feature text, kept for the lists 5e-bits' `Features.json` only
refers to ("the options are presented later in this class's description"): the Metamagic options are
read out of it with their sorcery point costs. The Eldritch Invocation options are in it too, but the
choice pool stays the hand-written table in `src/srd/data.ts`, whose prerequisite levels the level-up
flow has used since R2.

Magic items come from 5e-bits rather than Open5e's `MagicItem.json`: it keeps the SRD's generic
"Weapon +1" / "Armor +2" / "Shield +3" entries instead of exploding them into one row per base item,
and it carries the attunement requirement text ("Paladin", "Spellcaster") that Open5e drops.
