---
name: usage-dashboard
description: Inspect local Antigravity token usage, KV-cache hit rates, model breakdown, daily trends, top tools, and conversation activity using the Usage Dashboard MCP App.
---

# Usage Dashboard

Use this skill when the user asks about their Antigravity usage, token consumption, prompt cache hit rate, model breakdown, tool usage, or session history.

## Available Tools

- **`open_usage_dashboard`**: Opens the interactive **Usage** dashboard (also accessible full-page in the main panel from **Plugins** in the left sidebar, or in the side pane `+` menu). Accepts optional `range` (`24h`, `7d`, `30d`, `all`), `model`, and `workspace` filters.
- **`get_usage_summary`**: Returns a concise text summary of token usage, KV-cache hit rate, model breakdown, and historical session counts for answering quick questions inline in chat.

## Notes

- All telemetry is read 100% locally from `~/.gemini/antigravity/brain/*/.system_generated/logs/transcript.jsonl` and `~/.gemini/antigravity/conversation_summaries.db`.
- Live account plan quota percentages and AI Credits balances are not exposed to local plugins — direct the user to **Settings → Models** when they ask about remaining plan quota or credits.
