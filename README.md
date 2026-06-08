# nextjs-agent-mcp

An **MCP server** that lets an AI agent **drive and inspect a running Next.js app**. It works three
ways:

- **Mode A — Headless introspection.** Reads the App Router route map and captures structured
  dev-server errors straight from the framework. No browser required.
- **Mode B — In-page bridge.** A tiny dev-only `<AgentBridge/>` component you mount in your app
  connects to a small **broker** and the agent drives the page via **real DOM events** — click,
  fill, navigate, snapshot the page as a structured model, walk the React component tree, capture
  network calls, read/write storage, run JS, screenshot. A floating HUD lets you watch it work
  (status bar with typed narration, traveling cursor, spotlight).
- **Mode C — Chrome control (CDP).** Optionally manage the real browser via the DevTools Protocol:
  launch Chrome with a chosen **profile**, list **all** open tabs, open/activate/close tabs. No
  Playwright/puppeteer — just Node + Chrome's debug endpoint. Tabs that load your app + the bridge
  then connect to the broker for claim/drive as usual.

### Connection model (broker + claim)
Multiple agents and multiple tabs coexist cleanly:
- A single **broker** owns the WS port (default `7333`). The first MCP to start spawns it; others
  connect to it. (Fixes the old "two MCPs on different ports, agent drives the wrong tab" problem.)
- Each MCP registers as an **agent** with a unique id + name.
- Each browser tab connects but stays **inert ("unclaimed")** — no agent controls it until one
  **claims** it. On claim, the tab's HUD shows the controlling agent's name + intent.
- An agent controls **one tab at a time** (the one it claimed) and **cannot** touch a tab owned by
  another agent. `claim_tab` binds a free tab — or opens a new one if none are free.

**Agent loop:** `claim_tab({intent})` → `snapshot`/`find` → `fill`/`fill_form`/`click` →
`wait_for` → `network_calls` → `release_tab`.

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

### Mode B — in-page bridge (claim a tab first)
| Tool | What it does |
|---|---|
| `agent_info` | This agent's id/name, broker connection, and the tab it controls (`boundTabId`). |
| `list_tabs` | All connected tabs: `tabId`, url, title, `free`, and `boundAgentName` if owned. |
| `claim_tab` | **Call first.** Bind a free tab (or open one if none free). `intent` shows in the tab's HUD. |
| `release_tab` | Unbind the tab → back to "unclaimed" for a human/other agent. |
| `bridge_status` | This agent's broker status: connected?, port, bound tab, all tabs + owners. |
| `open_tab` | Open a new browser tab (then claim it). |
| `navigate` / `reload` | Navigate the bound tab to a URL / reload it. |
| `click` / `fill` | Real pointer+click / **type-aware** input: text, `<select>` (value or label), checkbox/radio, date/time, contenteditable. |
| `fill_form` | Fill MANY fields in one call (`[{selector,value}]`) — cursor walks each field. |
| `snapshot` | Structured page model: `route`, `forms` (grouped + submit), `fields` (label/name/id/type/value/required/options/selector), `actions`, and a flat `values` map. |
| `page_context` | Lightweight "where am I": url, pathname, locale, title, page heading. |
| `overview` | Page landmark map: header / nav / sidebars / sections / tabs / footer / open dialogs. |
| `find` | Search the page for fields/actions/components matching a query. |
| `components` | Walk the React fiber tree: component names, nesting, hook shape. |
| `component_for` | Which components render a given element (owner chain). |
| `rerender` | Force the component owning a selector to re-render. |
| `wait_for` | Poll until a selector appears or text is present. |
| `network_calls` | Captured fetch/XHR (method, status, type, timing, capped bodies) + resources; filter by `types`, `urlContains`, `since`. |
| `storage` | Read/modify `localStorage` / `sessionStorage` / cookies (get/set/delete/clear). |
| `cache` | Inspect or clear Cache Storage (PWA/Service Worker). |
| `console_messages` | All console output + uncaught errors / unhandled rejections (`since` for deltas). |
| `think` / `status` | Narrate intent in the on-page status bar (kinds: 💭 thinking · ⌘ code · ⇅ net · ✦ action). |
| `eval` | Run arbitrary JS in the page and return the serialized result (dev-only). |
| `screenshot` | In-page PNG capture via html2canvas (best-effort; needs network to load html2canvas). |

Every Mode-B tool acts on the agent's **bound tab** and accepts an optional `message` (typed into
the on-page status bar). Claim a tab with `claim_tab` before using them.

`navigate` also returns the page's **failed network requests** (4xx/5xx) — top 20 `{url, status,
type}` by default; pass `return_error_urls: N` for more (or `0` to skip).

### Mode C — Chrome control (CDP, real browser)
| Tool | What it does |
|---|---|
| `chrome_launch` | Launch Chrome with `--remote-debugging` + a `profile` dir (or attach if already up). `url`, `headless` optional. |
| `chrome_tabs` | List **all** open browser tabs (id, title, url, active) — not just bridge-connected ones. |
| `chrome_open_tab` | Open a new real browser tab at `url`. |
| `chrome_activate_tab` / `chrome_close_tab` | Focus / close a tab by `id`. |

Run the MCP with `--chrome-port` (default 9222) and optionally `--chrome-path`. Different `profile`
dirs keep separate logins/sessions.

### A typical agent loop
`claim_tab({intent})` → `page_context`/`overview` → `snapshot` (or `find`) → `fill_form` /
`fill` / `click` → `wait_for` → `network_calls` / `console_messages` to verify → `release_tab`.

---

## Errors without letting the MCP own your server

If you run your own dev server, redirect its output and attach:

```bash
npm run dev > /tmp/dev.log 2>&1
# then, via the agent:  attach_log { "path": "/tmp/dev.log" }
```

## Test

```bash
npm test                                      # broker isolation test (agents+tabs, no browser)
node test/smoke.mjs  /path/to/your-next-app   # boots over stdio, prints route_map (Mode A)
```

## Notes & caveats

- The bridge needs a real browser tab open — "no headless browser", not "no browser".
- React 19: fibers expose component **names + hook shape**, but **not** source file/line or hook
  names (`_debugSource` was removed); `screenshot` has no headless fallback.
- `eval` and the bridge are **dev-only** — gate the `<AgentBridge/>` mount on `NODE_ENV`.

## License

MIT
