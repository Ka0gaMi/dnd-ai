# Self-playtest

`scripts/playtest/run.mts` plays a short session with no human at the table: headless Claude Code
is the DM against a throwaway server, and a scripted or Claude player answers it. Every run gets its
own port, database and folder, so `data/dnd-ai.sqlite` is never touched.

```powershell
node --import tsx scripts/playtest/run.mts                       # 12 scripted turns, Sonnet DM
node --import tsx scripts/playtest/run.mts --turns 2             # a smoke run
node --import tsx scripts/playtest/run.mts --player claude --player-model haiku --dm-model sonnet
node --import tsx scripts/playtest/run.mts --window               # watch it in the companion window, with screenshots
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--scenario` | `first-session` | The scripted player's lines and the Claude player's goal (`scripts/playtest/scenarios.mts`). |
| `--turns` | `12` | Player turns; a scripted run also stops when its lines run out. |
| `--dm-model` | `sonnet` | Model alias or full name for the DM. |
| `--player` | `scripted` | `scripted`, or `claude` for a novice-player persona with no tools. |
| `--player-model` | `haiku` | Model for `--player claude`. |
| `--window` | off | Opens the companion window (`scripts/playtest/window.mts`), which clicks the roll cards and takes a screenshot per turn. Needs `web/dist`. |

## Scenarios

| Scenario | Starts | Aims at |
| --- | --- | --- |
| `first-session` | From nothing: session zero and character creation. | The whole onboarding path. |
| `ambush` | Mid-story: level 3 human Fighter Bram and cleric companion Sister Elowen on a forest road at dusk, carrying a tithe to Ashford. | A bandit or wolf fight to the end, a short rest, a checkpoint save. |
| `dungeon` | Mid-story: the same pair at level 5 in the Sunken Chapel (locked door, hidden trap, a lair). | Exploration, a skill check, a fight, a long rest, a save. |

A scenario with a `seed(db)` step gets its campaign built through the core functions in the run's own
database after the server is up and before the DM's first turn; `meta.json` records the seeded
`campaign_id`. The first player line resumes the story, so the DM loads the campaign instead of
asking session-zero questions. The scenario name is part of the published folder
(`<stamp>-<scenario>-claude-<model>`) and has its own column in `playtest-reports/index.md`.

A combat-heavy run with a Claude player:

```powershell
node --import tsx scripts/playtest/run.mts --scenario ambush --turns 12 --player claude --player-model haiku
```

Ctrl-C stops the run cleanly: the DM process, the window and the server are shut down and
`meta.json` records `"error": "interrupted"`.

## What it costs

Each turn is one `claude -p` call on this machine's Claude login, so it draws on the subscription's
usage limits, not an API bill. The DM's context is about 110k tokens before the first word (the
dnd-ai tool list is most of it); it is cached after the first turn, but a 12-turn Sonnet run is
still a noticeable share of a 5-hour window. `--player claude` adds one small Haiku call per turn.
`total_cost_usd` in the run folder is Claude Code's list-price figure, useful for comparing runs. A
resumed session reports its running cost and API time, so the runner stores each turn's own share.

## How the DM is set up

- `claude -p <player text> --model <dm-model> --mcp-config <run>/mcp.json --strict-mcp-config
  --append-system-prompt-file docs/dm-instructions.md --tools "" --allowedTools mcp__dnd-ai
  --setting-sources "" --disable-slash-commands --output-format stream-json --verbose`, plus
  `--resume <session>` from the second turn. It runs in the empty `<run>/dm` folder.
- With `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in its environment
  and `--setting-sources ""`, the DM sees no CLAUDE.md or AGENTS.md, no auto-memory, and none of the
  user, project or local settings (hooks, plugins, their MCP servers). `--bare` would be stricter
  but refuses OAuth logins, and `--safe-mode` also drops `--mcp-config`.
- The first turn's init event is checked: the DM must see only `mcp__dnd-ai__*` tools, one
  connected `dnd-ai` server, no skills and no memory path, or the run stops. What it saw is kept in
  `meta.json` as `dm_init`.
- The server takes its MCP secret from `tunnel/secret.txt` (creating it if missing); the run only
  reads that file, so the run folder holds the real secret. `logs/` is gitignored.
- Player rolls: without `--window`, the runner polls `/api/campaigns/<id>/pending-rolls` every
  second while the DM works and resolves each card through `/api/rolls/<id>/resolve`, as the
  window's Roll button does. With `--window` the window clicks them.
- Each run leaves Claude Code sessions under `~/.claude/projects/` named after the run folder;
  `claude purge <path>` removes them.

## The run folder

`logs/playtest/<YYYYMMDD-HHMMSS>/`:

| File | Holds |
| --- | --- |
| `meta.json` | Times, port, secret, DB path, `campaign_id` once one exists, models, player, scenario, `turns_played`, `dm_session_id`, `dm_init`, `totals` (DM usage sums and `wall_ms`), `player_totals`, `error`. |
| `transcript.jsonl` | One line per message: `{ turn, role, text, tool_calls?, at }`; Claude turns add `started_at`, `finished_at` and `usage` (`duration_ms`, `duration_api_ms`, `num_turns`, token counts, `total_cost_usd`). |
| `server.log` | The server's stdout and stderr, including the `tools/call` and `tools/result` lines `scripts/toolstats.mts` reads. |
| `game.sqlite` | The run's database. |
| `streams/` | The raw stream-json of every `claude` call. |
| `mcp.json`, `dm/`, `player/` | The DM's MCP config and the empty working folders. |
| `backups/`, `portraits/` | The server's start-up backup and any portraits, kept out of `data/`. |
| `screenshots/` | Written by the window with `--window`. |
| `report.md` | Written by `scripts/playtest/report.mts` at the end of the run, when present. |

## Published reports

After `report.md` is written, the runner publishes the run to `playtest-reports/` in the **main checkout**
(gitignored; override with `DND_AI_PLAYTEST_REPORTS`), whichever worktree it ran from. Each run gets
`<YYYYMMDD-HHMMSS>-<scenario>-scripted` or `...-claude-<player-model>/` holding `report.md` (first line
names the player kind), `screenshots/`, `transcript.jsonl`, `toolstats.json` and a `meta.json` without
`secret`, `port` and `db_path`. The database, `mcp.json`, `server.log` and `streams/` are never copied.

`playtest-reports/index.md` is rebuilt on every publish: one table of Claude-player runs and one of
scripted runs, each newest first, with branch @ commit, turns, wall and model time, hops, list-price
cost, calls per turn, refusals, tools/list tokens and leaks.

```powershell
node --import tsx scripts/playtest/publish.mts <runDir> [<runDir>...]   # (re)publish given runs
node --import tsx scripts/playtest/publish.mts --all                    # every logs/playtest/* in the main checkout and its worktrees
```

Republishing overwrites only that run's folder. Runs made before the branch and commit were recorded in
`meta.json` show the branch and commit currently checked out in the checkout that holds them.
