# Claude Desktop (stdio fallback)

Requires `npm run build` to have produced `dist/bin/stdio.js`. Add this server to Claude
Desktop's config, then fully restart the app:

```json
{
  "mcpServers": {
    "dnd-ai": {
      "command": "node",
      "args": ["C:\\Users\\Kornelijus.kvindt\\dnd-ai\\dist\\bin\\stdio.js"]
    }
  }
}
```

The stdio path runs a second process against the same SQLite file, and the event bus that feeds
the companion window lives inside one process, so a companion window served by `start.ps1
-NoTunnel` will not update live while you play through Claude Desktop - reload the page to see
the current state. Live updates need the ChatGPT/tunnel path for now.

Two Windows gotchas (from https://modelcontextprotocol.io/docs/develop/connect-local-servers):
the config file lives at `%APPDATA%\Claude\claude_desktop_config.json` (create it if missing);
connection logs live under `%APPDATA%\Claude\logs\` if the server does not show up.
