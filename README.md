# Antigravity Usage Dashboard (`agy-usage-dashboard`)

An **MCP App** plugin for **Google Antigravity** that renders a local usage analytics dashboard directly in the **main panel** (full-page from **Plugins** in the left sidebar) and the **side pane** (`+` menu).

## Features

- **Main Panel & Side Pane Entrypoints**: Uses Antigravity's official `com.google.antigravity/ui` MCP App entrypoints (`global` + `aux_pane`) with responsive layout and automatic light/dark theme syncing.
- **On-Demand Live Account Quota %**: One-click **Check Live Quota** button runs the official local Antigravity CLI (`agy --print /usage --output-format json`, 0 tokens consumed) to show 5-hour and weekly used/remaining percentages and reset countdowns across all model groups.
- **Token Breakdown**: Tracks total tokens across fresh input, KV-cache reads, and output tokens.
- **KV-Cache Hit Rate**: Overall, per-model, and per-conversation prompt cache efficiency (`cache_read_tokens / (input_tokens + cache_read_tokens)`).
- **Interactive Usage Over Time**: Stacked SVG chart (hourly for `24h`, daily for `7d` / `30d` / `All`) with hover tooltips and mode switching (**Token Split**, **By Model**, **Turns**).
- **Model & Tool Breakdown**: Click any model to filter the dashboard; view most-invoked agent tools.
- **Conversations Table**: Searchable and sortable per-conversation telemetry enriched with titles and workspace names from `conversation_summaries.db`.
- **All-Time Session History**: Displays historical session and step counts by workspace (requires Node.js 22.5+ for built-in `node:sqlite`; gracefully skipped on Node 18/20).
- **Chat Skill Included**: Ask Antigravity directly in chat to summarize your usage or open the dashboard.

## Installation

### Option 1: Install via Antigravity CLI (Recommended)

```bash
agy plugin install https://github.com/garymabin/agy-usage-dashboard
```

### Option 2: Manual Clone (Zero Build Required)

Clone directly into Antigravity's global plugins directory — pre-built `dist/server.mjs` and `dist/app.html` are included so no `npm install` is needed:

**macOS / Linux:**
```bash
git clone https://github.com/garymabin/agy-usage-dashboard.git ~/.gemini/config/plugins/usage-dashboard
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/garymabin/agy-usage-dashboard.git "$env:USERPROFILE\.gemini\config\plugins\usage-dashboard"
```

Antigravity automatically discovers plugins in `~/.gemini/config/plugins/`.

## Opening the Dashboard

- **Main panel (full-page)**: Click **Plugins** in the left sidebar → **Usage**.
- **Side pane**: Click **`+`** in the side pane → **Usage**.
- **From chat**: Ask *"Open my Antigravity usage dashboard"* or *"Summarize my token usage this week"*.

## Requirements

- **Node.js 18+** on your `PATH` (Node.js **22.5+** recommended to also read conversation titles and historical session counts from `conversation_summaries.db` via built-in `node:sqlite`).
- **Antigravity CLI (`agy`)** *(optional)*: Required only if you use the on-demand **Check Live Quota** button (`agy --print /usage --output-format json`). All other local token/cache/conversation analytics work without it.

## Privacy & Security

- **100% Local & Read-Only Telemetry**: Reads local files already on your machine (`~/.gemini/*/brain/*/.system_generated/logs/transcript.jsonl` and `~/.gemini/*/conversation_summaries.db` opened with `readOnly: true`).
- **Official CLI Only for Quota**: Clicking **Check Live Quota** invokes the official `agy --print /usage --output-format json` binary on demand (0 model tokens used, no background polling, no reverse proxy, no undocumented RPCs, and no credential scraping).
- **Strict CSP Sandbox**: The UI is a single self-contained HTML file rendered under Antigravity's default `default-src 'none'` iframe policy.

## Development & Building from Source

```bash
npm install
npm run build
```

This bundles `src/ui/*` into `dist/app.html` and `src/server.mjs` + `src/usage.mjs` into `dist/server.mjs`.

## License

[MIT](./LICENSE)
