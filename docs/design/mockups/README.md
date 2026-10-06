# Companion window redesign: mockups (2026-10-06)

Static, self-contained HTML. Open a file in a browser; the black strip at the top switches views
(it is mockup chrome, not part of the design). Only Google Fonts are fetched; everything else is inline.
Each follows the OS light/dark preference and has a Theme button. Checked at 1440×900 and 1280×720.

| File | Direction | Views (hash) |
|---|---|---|
| `a-adventurers-desk.html` | A. Adventurer's Desk: party rail, play stage, reference drawer | `#home` `#combat` `#sheet` `#shop` `#phone` `#index` (+ combat state: enemy turn / your turn; Aa panel for text size, contrast, readable font, motion) |
| `b-illuminated-journal.html` | B. Illuminated Journal: a two-page book, ribbon chapters, a battle plate | `#home` `#combat` `#sheet` `#letters` `#index` |
| `c-tactical-theatre.html` | C. Tactical Theatre: full-bleed stage, hotbar, glass overlays | `#home` `#combat` `#sheet` `#board` `#index` (+ mood: day/dusk/night/storm; combat: enemy turn / your turn; command wheel on Q) |

Sample content: Sera (Elf Ranger 5), Borin (Dwarf Fighter 5), Runa (Human Cleric 5), the ford fight on the
Mill Road, Westmarch. All numbers are illustrative; the dice results shown are fixed, not rolled.

**Chosen (2026-10-06):** A as the shell, with B's drop-cap recap, sealed roll card and letters, and C's hotbar turn bar, command wheel and full-map battle focus. Migration is incremental, shell first.
