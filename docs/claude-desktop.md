# Claude Desktop (stdio, tools only)

Claude Desktop over plain stdio works for the game's tools, but it has no companion window: the
stdio process starts only the MCP server, so roll cards never appear and rolls the player should
make auto-resolve when `roll_timeout_s` runs out. For a real session use Claude Code over local
HTTP, described under "Playing" in the README. A stdio-to-HTTP bridge that would give Claude
Desktop the window is planned, not built.

Requires `npm run build` to have produced `dist/bin/stdio.js`. Add this server to Claude
Desktop's config, then fully restart the app:

```json
{
  "mcpServers": {
    "dnd-ai": {
      "command": "node",
      "args": ["C:\path\to\dnd-ai\dist\bin\stdio.js"]
    }
  }
}
```

The stdio path runs a second process against the same SQLite file, and the event bus that feeds
the companion window lives inside one process, so a companion window served by `start.ps1
-NoTunnel` will not update live while you play through Claude Desktop - reload the page to see
the current state.

Two Windows gotchas (from https://modelcontextprotocol.io/docs/develop/connect-local-servers):
the config file lives at `%APPDATA%\Claude\claude_desktop_config.json` (create it if missing);
connection logs live under `%APPDATA%\Claude\logs\` if the server does not show up.
