# nextjs-agent-mcp

An **MCP server** that lets an AI agent **drive and inspect a running Next.js app** — no Playwright,
no headless Chromium. It works two ways:

- **Mode A — Headless introspection.** Reads the App Router route map and captures structured
  dev-server errors straight from the framework. No browser required.
- **Mode B — In-page bridge.** A tiny dev-only `<AgentBridge/>` component you mount in your app
  opens a WebSocket to the MCP. The agent can then click, fill, navigate, snapshot the page as a
  structured model, walk the React component tree, capture network calls, read/write storage, run
  JS, and screenshot — all via **real DOM events** in a real browser tab. A floating HUD lets you
  watch the agent work.

Multi-tab aware: every connected tab gets a stable `tabId`; tools target the most-recent tab by
default, a specific tab by `tabId`, or broadcast to `all`.

---

## Install

```bash
git clone git@github.com:zohaib3249/nextjs-agent-mcp.git
cd nextjs-agent-mcp
npm install        # builds the bridge automatically (prepare script)
```

## Run the MCP server

```bash
node src/index.js --project /path/to/your-next-app --ws-port 7333
```

- `--project` — path to the Next.js app you want to test (used by Mode A to read routes/errors).
- `--ws-port` — port the in-page bridge connects to (default `7333`). Must match
  `NEXT_PUBLIC_AGENT_BRIDGE_PORT` in your app if you change it.

## Wire it into your agent (`mcp.json`)

```json
{
  "mcpServers": {
    "nextjs-agent": {
      "command": "node",
      "args": [
        "/abs/path/to/nextjs-agent-mcp/src/index.js",
        "--project", "/path/to/your-next-app",
        "--ws-port", "7333"
      ],
      "cwd": "/abs/path/to/nextjs-agent-mcp",
      "transport": "stdio"
    }
  }
}
```

> Use **absolute paths** for `command`'s script arg and `cwd` — the launcher may not share your
> shell's working directory or `PATH`. Don't define the same server twice (two instances collide
> on the WS port; the second now exits with a clear message).

---

## Mode B: mount the bridge in your app

Add **one import + one dev-gated line** to your root layout:

```tsx
// app/layout.tsx (or src/app/layout.tsx)
import { AgentBridge } from 'nextjs-agent-mcp/bridge';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        {process.env.NODE_ENV === 'development' && <AgentBridge />}
      </body>
    </html>
  );
}
```

In dev you'll see a floating **nextjs-agent** HUD (bottom-right): connection status, the tab's id,
and a live feed of agent actions; the targeted element pulses when clicked/filled. It renders
nothing in production. The bridge port defaults to `7333`; override via
`NEXT_PUBLIC_AGENT_BRIDGE_PORT` (must match the MCP's `--ws-port`).

### Installing the package into your app

The bridge ships as **pre-built JS** (`bridge/index.js`, React kept external, `'use client'`
preserved). Install from npm and add it to `transpilePackages`:

```bash
npm install nextjs-agent-mcp
```

```js
// next.config.js
const nextConfig = { transpilePackages: ['nextjs-agent-mcp'] };
```

> **Local development of the package itself:** a `file:` install symlinks into `node_modules`, and
> Turbopack refuses to follow a symlink that points **outside** your app's filesystem root
> (*"Symlink … points out of the filesystem root"*). If you hit that, keep the package **inside**
> your app's repo root, or install a packed tarball (`npm pack` → `npm install ./that.tgz`) so it
> lands as real files. Published npm installs are unaffected.

---

## Tools

### Mode A — headless (no browser)
| Tool | What it does |
|---|---|
| `route_map` | All App Router routes from the filesystem; flags locale-prefixed routes. |
| `start_dev_server` | Spawns `npm run dev` and captures output as structured errors. |
| `attach_log` | Parse an existing dev-server log file instead of spawning. |
| `get_errors` | Structured compile / module-not-found / runtime / hydration errors (`since` for deltas). |
| `stop_dev_server` | Stop the spawned dev server. |

### Mode B — in-page bridge (needs a connected tab)
| Tool | What it does |
|---|---|
| `bridge_status` | Is the WS bridge listening? Any bind error? Which tabs are connected? |
| `list_tabs` | Every connected tab: `tabId`, url, pathname, title + the `defaultTabId`. |
| `open_tab` | An existing tab `window.open`s a new tab (which auto-connects with its own id). |
| `navigate` / `reload` | Navigate a tab to a URL / reload it. |
| `click` / `fill` | Real pointer+click / native-setter input so React & MUI handlers fire. |
| `snapshot` | Structured page model: `route`, `forms` (grouped + submit), `fields` (label/name/id/type/value/required/options/selector), `actions`, and a flat `values` map. |
| `page_context` | Lightweight "where am I": url, pathname, locale, title, page heading. |
| `find` | Search the page for fields/actions/components matching a query. |
| `components` | Walk the React fiber tree: component names, nesting, hook shape. |
| `component_for` | Which components render a given element (owner chain). |
| `rerender` | Force the component owning a selector to re-render. |
| `wait_for` | Poll until a selector appears or text is present. |
| `network_calls` | Captured fetch/XHR (method, status, type, timing, capped bodies) + resources; filter by `types`, `urlContains`, `since`. |
| `storage` | Read/modify `localStorage` / `sessionStorage` / cookies (get/set/delete/clear). |
| `cache` | Inspect or clear Cache Storage (PWA/Service Worker). |
| `console_messages` | All console output + uncaught errors / unhandled rejections (`since` for deltas). |
| `eval` | Run arbitrary JS in the page and return the serialized result (dev-only). |
| `screenshot` | In-page PNG capture via html2canvas (best-effort; needs network to load html2canvas). |

Most Mode-B tools accept an optional `tabId`; `navigate`/`reload`/`click`/`fill`/`storage`/`cache`
also accept `all: true` to broadcast to every connected tab.

### A typical agent loop
`page_context` → `snapshot` (or `find`) → `fill` a field by its selector → `click` submit →
`wait_for` the result → `network_calls` / `console_messages` to verify.

---

## Errors without letting the MCP own your server

If you run your own dev server, redirect its output and attach:

```bash
npm run dev > /tmp/dev.log 2>&1
# then, via the agent:  attach_log { "path": "/tmp/dev.log" }
```

## Test

```bash
node test/bridge.mjs                          # WS round-trip with a fake bridge (no real browser)
node test/smoke.mjs  /path/to/your-next-app   # boots over stdio, prints route_map
node test/live.mjs   /path/to/your-next-app   # drives a REAL connected tab (open one first)
```

## Notes & caveats

- The bridge needs a real browser tab open — "no headless browser", not "no browser".
- React 19: fibers expose component **names + hook shape**, but **not** source file/line or hook
  names (`_debugSource` was removed); `screenshot` has no headless fallback.
- `eval` and the bridge are **dev-only** — gate the `<AgentBridge/>` mount on `NODE_ENV`.

## License

MIT
