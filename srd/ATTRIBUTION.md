# SRD 5.2.1 data — attribution and licence

The JSON in this folder is game rules content from the **System Reference Document 5.2.1**,
published by Wizards of the Coast under the Creative Commons Attribution 4.0 International
Licence. The required notice:

> This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards
> of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under
> the Creative Commons Attribution 4.0 International License, available at
> https://creativecommons.org/licenses/by/4.0/legalcode.

## Where the files come from

Refresh the dataset JSON with `npm run srd:fetch`, and the three rules chapters with
`npm run srd:fetch:rules` (needs `pip install pymupdf`; the extraction was verified with pymupdf 1.28).
Nothing in this folder is edited by hand; the one piece of
SRD content kept outside it is the creature tag table in `src/srd/data.ts`, transcribed by hand
because neither upstream dataset carries the parenthesised tag of a stat block's type line.

| Folder | Source | Used for |
|---|---|---|
| `open5e/` | [open5e/open5e-api](https://github.com/open5e/open5e-api), `data/v2/wizards-of-the-coast/srd-2024` (code modified-MIT, data CC-BY-4.0) | `Spell.json` (all 339 spells, with the class list each spell belongs to), `Rule.json` + `ConditionDescription.json` + `SkillDescription.json` + `AbilityDescription.json` (the seeded glossary), `Creature.json` + `CreatureAction.json` + `CreatureActionAttack.json` + `CreatureTrait.json` (331 stat blocks with their traits, actions and attack rolls), `ClassFeature.json` (the option lists the class tables only point at, chiefly "Metamagic Options") |
| `srd-5.2.1/` | The official **SRD v5.2.1 PDF** ([English](https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf), published 2025-05-01, CC-BY-4.0), extracted by `scripts/fetch-srd-pdf.py` (`npm run srd:fetch:rules`, needs `pip install pymupdf` — AGPL-3.0) | the 2024 **Rules Glossary** (156 entries: the 155 rules — D20 Test, Concentration, Unarmed Strike, Attunement, Heroic Inspiration, Passive Perception, the actions, every condition — plus the `Glossary Conventions` abbreviations table), the **Spells-chapter rules** (25 rules plus the 2 titled sidebars `Casting in Armor` and `Identifying an Ongoing Spell`; includes "One Spell with a Spell Slot per Turn") and the **Playing the Game** chapter (112 entries from pages 5–18: the sections' own lead text — D20 Tests, Proficiency, Actions, Combat, Damage and Healing — with their subsections and rule entries, plus the 8 titled sidebars from `Exceptions Supersede General Rules` to `Knocking Out a Creature`). Open5e's `Rule.json` paraphrases that last chapter; the PDF's own text now covers 40 of its 56 entries, and it stays for the 15 that no PDF chapter carries (chiefly the character-creation and level-up steps). The PDF's outline gives the chapter boundaries and its rule headings are the GillSans-SemiBold runs at ≥ 11.5pt, which nest by size (26pt chapter, 18pt section, 14pt subsection, 12pt entry), so entry segmentation is structural rather than a text heuristic; a chapter or section title becomes an entry only for the lead text it prints before its first child, and a titled sidebar keeps only the lines in its own margin column. Playing the Game repeats names across its sections, so a name that is not unique in that file is prefixed with as much of its heading path as it takes — `Ability Checks: Ability Modifier`, `Saving Throws: Ability Modifier`, `Attack Rolls: Ability Modifier` — while a unique name such as `Cover` stays bare and merges with the glossary's entry of that name in `allRules()`, glossary text first. Each `desc` keeps the printed shape: paragraphs separated by a blank line (the page marks a new one with a leading tab or a bold run-in heading such as "Damage."), one line per bullet item, and every titled table as its own paragraph of `|`-separated rows carrying its header row once, however the page splits that table across side-by-side halves or two columns. The untitled Gill Sans grids — the abbreviation list, the name lists in `Action` or `Condition` — have no header row and stay as a single paragraph in reading order. The glossary and spell entries' names and text were diffed against an independent markdown transcription of the same SRD: identical names, and after normalising markdown emphasis, table pipes and curly quotes, 145/155 and 22/25 entries are identical — the rest differ only in table/list ordering, plus the two sidebars, which the transcription folded into their parent entries. Playing the Game was checked against the printed pages instead, entry by entry; two quirks are the PDF's own, not the extraction's: its numbered steps carry a running counter and a colon ("4: Roll 1d20" on page 6), and the Skills table, which page 9 prints above the text that introduces it, lands at the end of the `Actions` entry. |
| (transcribed) | The creature **tags** of the SRD 5.2.1 Monster Manual type lines ("Small Fey (Goblinoid)"), hand-copied into `CREATURE_TAGS` in `src/srd/data.ts` | a homebrew clause narrowed by `target.type: ["goblinoid"]`: neither dataset carries the tag, only the type |
| `5e-bits/` | [5e-bits/5e-database](https://github.com/5e-bits/5e-database), `src/2024/en` (MIT) | `Classes.json`, `Levels.json`, `Features.json`, `Subclasses.json` (class tables, level progression, feature text), `Species.json` + `Traits.json`, `Backgrounds.json`, `Feats.json`, `Equipment.json`, `Skills.json`, `Magic-Items.json` (262 magic items with their rarity, attunement requirement, charges and +N), `Weapon-Properties.json` + `Weapon-Mastery-Properties.json` (the 2024 weapon property and mastery text) |

Open5e's 2024 dataset has the spells and a paraphrase of the Playing-the-Game rules chapter (its `Rule.json`)
but not the 2024 Rules Glossary or the Spells-chapter rules, and no class progression tables; 5e-bits has the
class, species, background and equipment tables but no 2024 spell file. The official SRD PDF supplies the
missing rules chapters and the authoritative wording of the one Open5e paraphrases. Hence three sources.

`ClassFeature.json` is Open5e's class feature text, kept for the lists 5e-bits' `Features.json` only
refers to ("the options are presented later in this class's description"): the Metamagic options are
read out of it with their sorcery point costs. The Eldritch Invocation options are in it too, but the
choice pool stays the hand-written table in `src/srd/data.ts`, whose prerequisite levels the level-up
flow has used since R2.

Magic items come from 5e-bits rather than Open5e's `MagicItem.json`: it keeps the SRD's generic
"Weapon +1" / "Armor +2" / "Shield +3" entries instead of exploding them into one row per base item,
and it carries the attunement requirement text ("Paladin", "Spellcaster") that Open5e drops.
