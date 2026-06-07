# nextjs-agent-mcp — Design & Implementation Spec

> A standalone MCP server that lets an AI agent **test a running Next.js app** by talking
> to the framework directly (errors, routes, components, server state) and by firing
> **real DOM events** through a tiny in-page bridge — without spinning up Playwright/Chromium.
>
> Built and verified against a Next 16 / React 19 / App Router app (works with MUI, Redux, next-intl).

---

## 1. Goal & scope

**Goal:** Better agent-driven testing of a Next.js app than raw Playwright gives, by combining
framework-level introspection (which Playwright can't see) with lightweight real-event
interaction (which keeps tests honest).

**In scope**
- Structured Next.js errors (compile / SSR / runtime / hydration).
- Route map from the App Router file tree.
- Component → source-file/line mapping.
- Server-side state visibility (RSC, server actions, data fetches) — best-effort.
- Real-event interaction: `click`, `fill`, `select`, `upload` (caveated), `snapshot`, `wait_for`.
- Two transports, switchable per task: **Headless (Mode A)** and **Bridge (Mode B)**.

**Out of scope (v1)**
- Cross-browser interaction fidelity (bridge targets Chromium-family first).
- Production-mode testing (dev-mode only; bridge is dev-gated).
- Replacing CDP/Playwright for OS-level file pickers (see §7 caveats).

---

## 2. The core decision: why hybrid, why real events

A test is only meaningful if it exercises the same code path a user triggers:
`DOM event → React synthetic event → onChange → state → effects → re-render`.

- **Pure state injection** (calling React setters directly) skips validation, handlers,
  disabled-button logic, debounced effects, MUI's controlled-input wiring → **false confidence.**
- **Real DOM events** dispatched in a live tab go through React's real path → **honest tests**,
  with none of Playwright's Chromium overhead.

So interaction = real events via the bridge. Introspection = framework, no browser needed.

| Capability | Mode | Verdict |
|---|---|---|
| See Next.js errors | A (headless) | ✅ strictly better than scraping the error overlay |
| Route map | A | ✅ from file tree |
| Component → file | A+B | ✅ |
| Server state / RSC / server actions | A | ✅ browser can't see this |
| Trigger re-render (Fast Refresh) | A | ⚠️ "did it recompile cleanly" |
| `fill` / `click` / `select` | B (bridge) | ✅ real events |
| `upload` | B | ⚠️ Chromium-only via DataTransfer; OS picker not simulated |

---

## 3. Architecture

```
┌─────────────┐     MCP (stdio)      ┌──────────────────────────┐
│   Agent     │◄────────────────────►│   nextjs-agent-mcp        │  Node process
│  (Claude)   │                      │                           │
└─────────────┘                      │  Mode A: HEADLESS         │──► Next.js dev server
                                     │   - tail dev server output │    (HMR/error channel,
                                     │   - read App Router tree   │     RSC, server actions)
                                     │   - read source files      │──► filesystem (your-app/src)
                                     │                           │
                                     │  Mode B: BRIDGE (ws)      │◄═══ WebSocket ═══┐
                                     │   - relays event commands  │                  │
                                     └──────────────────────────┘          ┌────────▼─────────┐
                                                                           │ Browser tab       │
                                                                           │ your-app page +   │
                                                                           │ <AgentBridge/>    │
                                                                           │ (dev-only)        │
                                                                           └───────────────────┘
```

- **Mode A (Headless):** no tab required. Reads the Next dev server's structured error stream
  and the filesystem. Fully automated.
- **Mode B (Bridge):** a ~100-line dev-only client component (`<AgentBridge/>`) opens a
  WebSocket to the MCP and executes event commands in the real page. Needs a tab open;
  no headless browser.

Both modes live in one server; the agent picks per task. Tools that need the page return a
clear "bridge not connected — open a dev tab" error when Mode B isn't live.

---

## 4. MCP tool surface

| Tool | Mode | Input | Returns |
|---|---|---|---|
| `get_errors` | A | `{ since? }` | `[{type, message, file, line, component, stack}]` for compile/SSR/runtime/hydration |
| `route_map` | A | — | App Router routes incl. `[locale]` and dynamic segments |
| `list_components` | A | `{ dir? }` | Component inventory (file, exported names, "use client") |
| `component_for` | A+B | `{ selector }` | Source file/line for the rendered element (via fiber → source) |
| `get_file` | A | `{ path, range? }` | Source slice |
| `server_state` | A | `{ route }` | Best-effort RSC payload / fetch + server-action results |
| `rerender` | A | `{ component }` | Triggers Fast Refresh / HMR for a module |
| `snapshot` | B | — | Accessibility/DOM tree of current page (role+name+selector) |
| `click` | B | `{ selector }` | Fires real `MouseEvent` (pointerdown/up + click) |
| `fill` | B | `{ selector, value }` | React-19 native-setter + real `input`/`change` events |
| `select` | B | `{ selector, value }` | Real `change` on `<select>` / MUI Select |
| `upload` | B | `{ selector, path }` | `DataTransfer` file set (Chromium); caveated |
| `wait_for` | B | `{ selector? text? networkIdle? timeoutMs }` | Resolves when condition met |

**`fill` correctness note (React 19 + MUI):** set value via the native
`HTMLInputElement.prototype.value` setter, then dispatch `new Event('input', {bubbles:true})`
so React's `onChange` fires. This is the Testing-Library/Playwright technique — required for
MUI controlled inputs to register the change.

---

## 5. Package layout (standalone)

```
nextjs-agent-mcp/
├── package.json            # @modelcontextprotocol/sdk, ws, chokidar; bin: nextjs-agent-mcp
├── SPEC.md                 # this file
├── src/
│   ├── index.ts            # MCP server bootstrap (stdio), registers tools
│   ├── modeA/
│   │   ├── errors.ts       # tail/parse Next dev server error channel
│   │   ├── routes.ts       # walk App Router tree -> route map
│   │   ├── components.ts   # component inventory + component_for resolution
│   │   └── serverState.ts  # RSC / server-action introspection (best-effort)
│   ├── modeB/
│   │   ├── wsServer.ts     # WebSocket server; command<->ack protocol
│   │   └── protocol.ts     # shared message types (also imported by the bridge)
│   └── tools/              # one file per MCP tool, thin wrappers over modeA/modeB
└── bridge/
    └── agent-bridge.client.tsx   # the dev-only component (published as built bridge/index.js)
```

Only the bridge component (published as `bridge/index.js`) lands in the target app.

---

## 6. App integration (the only change in the app)

**Injection point:** `src/app/layout.tsx` `<body>`, dev-gated. Confirmed structure:

```tsx
// src/app/layout.tsx  (existing root layout)
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={routing.defaultLocale} suppressHydrationWarning>
      <body suppressHydrationWarning>
        {children}
        {process.env.NODE_ENV === 'development' && <AgentBridge />}
      </body>
    </html>
  );
}
```

- `<AgentBridge/>` is `"use client"`, renders nothing, opens `ws://localhost:<port>`,
  and executes `click/fill/select/upload/snapshot/wait_for` against the live DOM.
- Dev-gated by `NODE_ENV` so it never ships to production (`output: 'standalone'` build).
- No `next.config.js` change needed; `allowedDevOrigins` already permits localhost.

**Run order**
1. `npm run dev` in your Next.js app (Next 16, Turbopack).
2. Start `nextjs-agent-mcp` (registered in the agent's `mcp.json`).
3. Mode A works immediately. For Mode B, open a tab (e.g. `http://localhost:3000`)
   so `<AgentBridge/>` connects.

**Agent wiring (`mcp.json`)**
```json
{ "mcpServers": { "nextjs-agent": { "command": "nextjs-agent-mcp",
  "args": ["--project", "/path/to/your-next-app", "--ws-port", "7333"] } } }
```

---

## 7. Honest caveats

- **Bridge needs a real tab open** — it's "no headless browser," not "no browser."
- **`upload`**: setting `<input type=file>.files` via `DataTransfer` works in Chromium-family
  but is blocked in some browsers and never simulates the OS picker. If upload flows are
  test-critical, that one flow may still need CDP/Playwright. Flagged, not hidden.
- **`server_state`** is best-effort: RSC payload parsing and server-action result capture
  depend on dev-server internals that can change across Next versions (pinned to 16.2.x here).
- **Hydration/timing**: real-event tests need `wait_for` discipline, like any browser test.
- **Locale routing**: all routes are under `[locale]`; `route_map` and navigation must
  prefix `/en` (or default locale) — handled in `routes.ts`.

---

## 8. Comparison to what exists

- **Playwright MCP** (official) — solves the *interaction* half with Chromium; heavier.
- **Chrome DevTools MCP** — CDP console/network/perf.
- **`@vercel`/Next devtools** — moving toward structured dev introspection.
- **React DevTools protocol** — has the component-tree/re-render data but **no clean MCP wrapper
  exists yet** → this package's real value-add is the framework-introspection MCP plus a
  lightweight honest-event bridge (re-implements ~30% of Playwright's surface, no Chromium).

---

## 9. Build phases

1. **Skeleton** — MCP stdio server + `get_errors`, `route_map` (Mode A only). Prove value with zero browser.
2. **Bridge MVP** — `<AgentBridge/>` + `wsServer` + `click`, `fill`, `snapshot`, `wait_for`. End-to-end on one form.
3. **Introspection depth** — `component_for`, `list_components`, `server_state`, `rerender`.
4. **Edges** — `select`, `upload` (+caveat surfacing), `wait_for` network-idle.
5. **Harden** — reconnect logic, multi-tab handling, version-pinned server-state parsing, docs.

---

## 10. Open questions (defer to build time)

- Single tab vs. multiple tabs (which one receives `click`)? → v1: most-recently-connected tab.
- Should `get_errors` also capture browser console errors via the bridge? → yes in Phase 2, as a Mode-B augmentation of Mode A.
- Auth: if the app has `auth/` routes — does agent testing need a seeded session? → out of scope v1, document a manual-login-then-test flow.
