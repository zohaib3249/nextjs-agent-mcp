#!/usr/bin/env node
// nextjs-agent-mcp — MCP server for agent-driven testing of a Next.js app.
// Phase 1: Mode-A (headless) introspection — route_map + get_errors. No browser.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from 'node:http';
import { z } from 'zod';

import { loadConfig } from './config.js';
import { buildRouteMap } from './modeA/routes.js';
import { ErrorTracker } from './modeA/errors.js';
import { BridgeServer } from './modeB/wsServer.js';

const config = loadConfig();
const tracker = new ErrorTracker();
const bridge = new BridgeServer({ port: config.wsPort });
bridge.start();

// Optional local HTTP control endpoint — lets you drive the bridge via curl, independent of the
// stdio MCP session (handy for debugging/demo). Enabled only when --http-port is set.
//   GET  /status                      -> bridge.status()
//   GET  /tabs                        -> bridge.listTabs()
//   POST /op   {op,args,tabId,all}    -> bridge.dispatch(op,args,{tabId,all})
//   GET  /route_map                   -> buildRouteMap(project)
function startHttpControl(port) {
  const srv = createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(obj));
    };
    const url = req.url || '/';
    if (req.method === 'GET' && url === '/status') return send(200, bridge.status());
    if (req.method === 'GET' && url === '/tabs') return send(200, bridge.listTabs());
    if (req.method === 'GET' && url === '/route_map') {
      buildRouteMap(config.project).then((r) => send(200, r)).catch((e) => send(500, { error: String(e) }));
      return;
    }
    if (req.method === 'POST' && url === '/op') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const { op, args = {}, tabId = null, all = false, timeoutMs } = JSON.parse(body || '{}');
          if (!op) return send(400, { error: 'missing op' });
          const r = await bridge.dispatch(op, args, { tabId, all, timeoutMs: timeoutMs || 15000 });
          send(200, r);
        } catch (e) {
          send(400, { error: String(e) });
        }
      });
      return;
    }
    send(404, { error: 'not found', endpoints: ['GET /status', 'GET /tabs', 'GET /route_map', 'POST /op'] });
  });
  srv.on('error', (e) => console.error('[http-control] error:', e.message));
  srv.listen(port, '127.0.0.1', () => console.error(`[http-control] listening on http://127.0.0.1:${port}`));
}
if (config.httpPort) startHttpControl(config.httpPort);

const server = new McpServer({
  name: 'nextjs-agent-mcp',
  version: '0.1.0',
});

// Compact JSON text result helper.
const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

server.registerTool(
  'route_map',
  {
    title: 'Next.js route map',
    description:
      'List App Router routes (pages + route handlers) for the configured project, read from the filesystem — including DYNAMIC routes: `[id]`→`:id`, `[...slug]`→`*slug`, `[[...slug]]`→`*slug?`. Each route reports `dynamic` and its `params`. Reports whether routes are locale-prefixed (e.g. /:locale). ' +
      'Filter with: `type` ("page" | "route-handler"), `dynamic` (true=only dynamic, false=only static), `pathContains`, `pathPrefix` (e.g. "/:locale/admin"), and `includeStructural` (default true).',
    inputSchema: {
      type: z.enum(['page', 'route-handler']).optional(),
      dynamic: z.boolean().optional(),
      pathContains: z.string().optional(),
      pathPrefix: z.string().optional(),
      includeStructural: z.boolean().optional(),
    },
  },
  async (filters) => json(await buildRouteMap(config.project, filters))
);

server.registerTool(
  'get_errors',
  {
    title: 'Next.js dev errors',
    description:
      'Return structured errors captured from the Next.js dev server (compile, module-not-found, runtime, hydration). Pass `since` (an error id) to get only newer errors. Returns empty until the dev server is started via start_dev_server or attach_log.',
    inputSchema: { since: z.number().int().optional() },
  },
  async ({ since }) => json(tracker.list({ since }))
);

server.registerTool(
  'start_dev_server',
  {
    title: 'Start Next.js dev server',
    description:
      'Spawn `npm run dev` for the configured project and begin capturing its output as structured errors. Idempotent — returns alreadyRunning if active.',
    inputSchema: {},
  },
  async () => json(tracker.startDevServer(config.project))
);

server.registerTool(
  'attach_log',
  {
    title: 'Attach to a dev-server log file',
    description:
      'Instead of spawning the dev server, parse an existing log file the user redirects `npm run dev` into. Use when you run your own dev server.',
    inputSchema: { path: z.string() },
  },
  async ({ path }) => json(tracker.attachLogFile(path))
);

server.registerTool(
  'stop_dev_server',
  {
    title: 'Stop the spawned dev server',
    description: 'Terminate the dev server process started by start_dev_server.',
    inputSchema: {},
  },
  async () => json(tracker.stop())
);

// ---- Mode B (bridge) tools -------------------------------------------------

// Shared params for tab-aware tools.
//   tabId   — target a specific tab (from list_tabs); omit for the most-recently-connected tab
//   all     — broadcast to every connected tab
//   message — short (≤2 lines) narration of what you're doing in THIS call; typed into the on-page
//             toast so a human can follow along. Optional but encouraged.
const MSG = { message: z.string().optional() };
const TAB_TARGET = { tabId: z.string().optional(), all: z.boolean().optional(), ...MSG };
const targetOpts = ({ tabId, all, message }, extra = {}) => ({ tabId: tabId ?? null, all: all ?? false, message: message ?? null, ...extra });
// For tabId-only tools (no broadcast): build dispatch opts including message.
const tabOpts = ({ tabId, message }, extra = {}) => ({ tabId: tabId ?? null, message: message ?? null, ...extra });

server.registerTool(
  'bridge_status',
  {
    title: 'Bridge connection status',
    description:
      'Report whether the WebSocket bridge is listening, any bindError (e.g. port in use), and which browser tabs (tabId + url + title) are connected via <AgentBridge/>.',
    inputSchema: {},
  },
  async () => json(bridge.status())
);

server.registerTool(
  'list_tabs',
  {
    title: 'List connected tabs',
    description:
      'List every browser tab currently connected via <AgentBridge/>: each tab\'s `tabId`, url, pathname, and title, plus `activeTabId` (the pinned tab from switch_tab, if any) and `defaultTabId` (the tab that tab-aware tools target when no tabId is given). Use a tabId to target a specific tab, or switch_tab to pin one.',
    inputSchema: {},
  },
  async () => json(bridge.listTabs())
);

server.registerTool(
  'current_tab',
  {
    title: 'Current (active) tab',
    description:
      'Report which tab is currently active — the one tab-aware tools target by default. Returns `activeTabId` (set via switch_tab, or null), `defaultTabId` (effective default), `sticky` (whether an active tab is pinned), and the tab\'s url/pathname/title.',
    inputSchema: {},
  },
  async () => json(bridge.currentTab())
);

server.registerTool(
  'switch_tab',
  {
    title: 'Switch the active tab',
    description:
      'Set the sticky active tab so all subsequent tab-aware tools (click/fill/snapshot/etc.) target it by default — until you switch again. Pass `tabId` (from list_tabs) to pin it, or omit/clear to revert to the most-recently-connected tab. The newly-active tab shows a "Now controlling this tab" status so a human can see which one is active.',
    inputSchema: { tabId: z.string().optional() },
  },
  async ({ tabId }) => {
    const res = bridge.setActiveTab(tabId ?? null);
    // Visually mark the newly-active tab (best-effort; ignore if it can't be reached).
    if (res.ok && tabId) {
      try {
        await bridge.dispatch('status', { message: 'Now controlling this tab', kind: 'action' }, { tabId, timeoutMs: 4000 });
      } catch {
        /* non-fatal */
      }
    }
    return json(res);
  }
);

server.registerTool(
  'open_tab',
  {
    title: 'Open a new browser tab',
    description:
      'Open a new browser tab at `url` (path-only like "/en/..." is resolved against the current origin). An existing connected tab performs the window.open, and the new tab auto-connects with its own tabId — call list_tabs afterward to get it. Requires at least one tab already connected and popups allowed for the origin. Use `tabId` to choose which existing tab opens it.',
    inputSchema: { url: z.string(), tabId: z.string().optional(), ...MSG },
  },
  async ({ url, tabId, message }) => json(await bridge.dispatch('open_tab', { url }, tabOpts({ tabId, message })))
);

server.registerTool(
  'click',
  {
    title: 'Click (real DOM event)',
    description:
      'Click an element by CSS selector, firing a real pointer+mouse+click sequence so React/MUI handlers run. Targets the default tab unless `tabId` is given (or `all` to click in every tab). Requires a connected tab.',
    inputSchema: { selector: z.string(), ...TAB_TARGET },
  },
  async ({ selector, tabId, all, message }) => json(await bridge.dispatch('click', { selector }, targetOpts({ tabId, all, message })))
);

server.registerTool(
  'fill',
  {
    title: 'Fill any input (type-aware)',
    description:
      'Set the value of a form control, choosing the right strategy for its type: text/email/number/textarea (typed), `<select>` (match by option value OR visible label), checkbox/radio (true/false/on or value/label match), date/time (common formats normalized), contenteditable. Fires real input/change events so React & MUI register it. ' +
      'Note: native `<select>` only — JS/MUI custom dropdowns (div-based) need click-to-open then click the option. Targets the default tab unless `tabId` is given (or `all`). Requires a connected tab.',
    inputSchema: { selector: z.string(), value: z.string(), ...TAB_TARGET },
  },
  async ({ selector, value, tabId, all, message }) =>
    json(await bridge.dispatch('fill', { selector, value }, targetOpts({ tabId, all, message })))
);

server.registerTool(
  'fill_form',
  {
    title: 'Fill multiple fields in one call',
    description:
      'Fill an entire form in a SINGLE call: pass `fields` as an array of {selector, value}. The bridge fills them one-by-one (cursor travels to each field + types it), so it stays visibly "controlled" but avoids a round-trip per field. ' +
      'Get the selectors from snapshot/find (use each field\'s `selector`). Returns per-field results. Targets the default tab unless `tabId` is given.',
    inputSchema: {
      fields: z.array(z.object({ selector: z.string(), value: z.string() })),
      tabId: z.string().optional(),
      ...MSG,
    },
  },
  async ({ fields, tabId, message }) =>
    json(await bridge.dispatch('fill_form', { fields }, tabOpts({ tabId, message }, { timeoutMs: 60000 })))
);

server.registerTool(
  'snapshot',
  {
    title: 'Page snapshot (structured page model)',
    description:
      'Return a structured model of the current page so you know exactly what is on it: ' +
      '`route` (url, pathname, locale, page heading), ' +
      '`forms` (each form grouped with its fields and submit button), ' +
      '`fields` (every input/select/textarea with label, name, id, type, current value, required, options, and a stable `selector`), and ' +
      '`actions` (buttons/links you can click, with their visible text + selector). ' +
      'Always call this before fill/click — pass a field/action `selector` from here to fill/click, and address fields by their `name`/`label`. Targets the default tab unless `tabId` is given. Requires a connected tab.',
    inputSchema: { tabId: z.string().optional(), ...MSG },
  },
  async ({ tabId, message }) => json(await bridge.dispatch('snapshot', {}, tabOpts({ tabId, message })))
);

server.registerTool(
  'page_context',
  {
    title: 'Where am I (current route)',
    description:
      'Lightweight "what page am I on" for a tab: url, pathname, detected locale, document title, and the visible page heading. Cheaper than snapshot. Targets the default tab unless `tabId` is given. Requires a connected tab.',
    inputSchema: { tabId: z.string().optional(), ...MSG },
  },
  async ({ tabId, message }) => json(await bridge.dispatch('page_context', {}, tabOpts({ tabId, message })))
);

server.registerTool(
  'think',
  {
    title: 'Narrate intent (show in HUD)',
    description:
      'Send a short first-person message describing what you are about to do or your current reasoning (e.g. "Now I\'ll fill the login form and submit"). It is displayed in the in-page HUD and as a floating thought bubble so a human can follow along. Purely cosmetic — it performs no page action. Call it before a sequence of actions to make the run readable. Targets the default tab unless `tabId` is given.',
    inputSchema: { message: z.string(), tabId: z.string().optional() },
  },
  async ({ message, tabId }) => json(await bridge.dispatch('think', { message }, tabOpts({ tabId, message })))
);

server.registerTool(
  'status',
  {
    title: 'Show a status line (typed in the on-page bar)',
    description:
      'Type a short status into the persistent on-page status bar so a human can follow along. ' +
      '`kind` sets the icon/intent: "thinking" (💭 internal reasoning), "code" (⌘ checking/reading code), "net" (⇅ network), or "action" (✦, default). ' +
      'The message stays at least ~10s; if no newer status/action arrives it cycles gentle idle phrases. `dwellMs` overrides the hold time. Cosmetic only. Targets the default tab unless `tabId` is given.',
    inputSchema: {
      message: z.string(),
      kind: z.enum(['thinking', 'code', 'net', 'action']).optional(),
      dwellMs: z.number().int().optional(),
      tabId: z.string().optional(),
    },
  },
  async ({ message, kind, dwellMs, tabId }) =>
    json(await bridge.dispatch('status', { message, kind, dwellMs }, tabOpts({ tabId, message })))
);

server.registerTool(
  'overview',
  {
    title: 'Page overview (landmark map)',
    description:
      'Return the structural layout of the current page so you know the lay of the land: `header` (banner + its links/buttons), `nav` (navigation lists + items), `sidebars` (with items), `sections` (landmark regions by heading), `tabs` (tab lists + active tab), `headings` (h1–h3 outline), `footer` (+ items), and `openOverlays` (dialogs/menus currently open and possibly blocking). Use after navigating to understand where things are, then snapshot/find/click into a region. Targets the default tab unless `tabId` is given. Requires a connected tab.',
    inputSchema: { tabId: z.string().optional(), ...MSG },
  },
  async ({ tabId, message }) => json(await bridge.dispatch('overview', {}, tabOpts({ tabId, message })))
);

server.registerTool(
  'components',
  {
    title: 'Rendered React component tree',
    description:
      'Walk the React fiber tree of a tab and return the rendered components: a `summary` (each component name + instance count), a `tree` (name, nesting depth, and hook shape per instance), and totals. ' +
      'Pass `selector` to scope to one element\'s subtree. NOTE (React 19): source file/line and hook *names* are not available from fibers; hook shape (count, hasState, hasEffect) is inferred. Targets the default tab unless `tabId` is given. Requires a connected tab.',
    inputSchema: { selector: z.string().optional(), tabId: z.string().optional(), ...MSG },
  },
  async ({ selector, tabId, message }) =>
    json(await bridge.dispatch('components', selector ? { selector } : {}, tabOpts({ tabId, message })))
);

server.registerTool(
  'component_for',
  {
    title: 'Component owning an element',
    description:
      'Given a CSS selector, return the chain of React components that render that DOM element (nearest owner first), each with its hook shape. Targets the default tab unless `tabId` is given. Requires a connected tab.',
    inputSchema: { selector: z.string(), tabId: z.string().optional(), ...MSG },
  },
  async ({ selector, tabId, message }) => json(await bridge.dispatch('component_for', { selector }, tabOpts({ tabId, message })))
);

server.registerTool(
  'rerender',
  {
    title: 'Force a component to re-render',
    description:
      'Force the nearest function component owning `selector` to re-render (dispatches its existing state with the same value, which React still schedules as a render). Returns ok:false if the component has no state hook to nudge. Targets the default tab unless `tabId` is given. Requires a connected tab.',
    inputSchema: { selector: z.string(), tabId: z.string().optional(), ...MSG },
  },
  async ({ selector, tabId, message }) => json(await bridge.dispatch('rerender', { selector }, tabOpts({ tabId, message })))
);

server.registerTool(
  'wait_for',
  {
    title: 'Wait for selector/text',
    description:
      'Poll a tab until a CSS selector appears or visible text is present, or timeout. Use after navigation or an action that triggers async rendering. Targets the default tab unless `tabId` is given.',
    inputSchema: {
      selector: z.string().optional(),
      text: z.string().optional(),
      timeoutMs: z.number().int().optional(),
      tabId: z.string().optional(),
    },
  },
  async ({ selector, text, timeoutMs, tabId, message }) =>
    json(
      await bridge.dispatch(
        'wait_for',
        { selector, text, timeoutMs },
        tabOpts({ tabId, message }, { timeoutMs: (timeoutMs || 5000) + 2000 })
      )
    )
);

server.registerTool(
  'navigate',
  {
    title: 'Navigate the tab',
    description:
      'Navigate a tab to a URL and return a page `overview` (landmark map: header/nav/sidebars/sections/tabs/headings/footer/openOverlays). Remember locale prefix, e.g. /en/.... ' +
      'For a full-document load the overview reflects the page at call time — if it just unloaded, call `overview` again once it has loaded (use wait_for first). Targets the default tab unless `tabId` is given (or `all`).',
    inputSchema: { url: z.string(), ...TAB_TARGET },
  },
  async ({ url, tabId, all, message }) =>
    json(await bridge.dispatch('navigate', { url }, targetOpts({ tabId, all, message }, { timeoutMs: 8000 })))
);

server.registerTool(
  'console_messages',
  {
    title: 'Browser console logs',
    description:
      'Return ALL client-side console output (log, info, warn, error, debug) plus uncaught errors and unhandled promise rejections, forwarded by <AgentBridge/>. Each entry has {ts, level, message, tabId}. Pass `since` (an index) for deltas, or `tabId` to filter to one tab. Complements get_errors (server-side).',
    inputSchema: { since: z.number().int().optional(), tabId: z.string().optional(), ...MSG },
  },
  async ({ since, tabId }) => json(bridge.consoleMessages({ since, tabId }))
);

server.registerTool(
  'reload',
  {
    title: 'Reload the tab',
    description: 'Reload the current page in a tab. Pass `hard: true` to reload without the in-page hash. Targets the default tab unless `tabId` is given (or `all`).',
    inputSchema: { hard: z.boolean().optional(), ...TAB_TARGET },
  },
  async ({ hard, tabId, all, message }) => json(await bridge.dispatch('reload', { hard: !!hard }, targetOpts({ tabId, all, message })))
);

server.registerTool(
  'network_calls',
  {
    title: 'Captured network requests',
    description:
      'Return network requests captured in the tab since page load: fetch & XHR (with method, status, type, timing, and capped response bodies) plus browser-loaded resources (image/css/script/font — metadata only). ' +
      'Filter with `types` (e.g. ["xhr","fetch","image","css","script","font","document"]), `urlContains`, `limit`, `since` (an id, for deltas), and `includeBodies` (default true). Targets the default tab unless `tabId` is given.',
    inputSchema: {
      types: z.array(z.string()).optional(),
      urlContains: z.string().optional(),
      since: z.number().int().optional(),
      limit: z.number().int().optional(),
      includeBodies: z.boolean().optional(),
      tabId: z.string().optional(),
    },
  },
  async ({ types, urlContains, since, limit, includeBodies, tabId, message }) =>
    json(await bridge.dispatch('network_calls', { types, urlContains, since, limit, includeBodies }, tabOpts({ tabId, message })))
);

server.registerTool(
  'storage',
  {
    title: 'Browser storage (local/session/cookie)',
    description:
      'Read or modify browser storage in a tab. `area`: "local" | "session" | "cookie". `action`: "get" (all, or one `key`) | "set" (key+value) | "delete" (key) | "clear". Targets the default tab unless `tabId` is given (or `all`).',
    inputSchema: {
      area: z.enum(['local', 'session', 'cookie']).optional(),
      action: z.enum(['get', 'set', 'delete', 'clear']).optional(),
      key: z.string().optional(),
      value: z.string().optional(),
      ...TAB_TARGET,
    },
  },
  async ({ area, action, key, value, tabId, all, message }) =>
    json(await bridge.dispatch('storage', { area, action, key, value }, targetOpts({ tabId, all, message })))
);

server.registerTool(
  'cache',
  {
    title: 'Cache Storage (PWA/Service Worker caches)',
    description:
      'Inspect or clear the browser Cache Storage in a tab. `action`: "list" (names + entry counts + sample urls) | "clear" (all, or a specific `name`). Targets the default tab unless `tabId` is given (or `all`).',
    inputSchema: { action: z.enum(['list', 'clear']).optional(), name: z.string().optional(), ...TAB_TARGET },
  },
  async ({ action, name, tabId, all, message }) =>
    json(await bridge.dispatch('cache', { action, name }, targetOpts({ tabId, all, message })))
);

server.registerTool(
  'eval',
  {
    title: 'Run JS in the page (dev-only)',
    description:
      'Execute arbitrary JavaScript in the tab and return the serialized result. The snippet may `return` a value or be a single expression; promises are awaited. Result is JSON-serialized and size-capped. DEV-ONLY — use for inspecting app state, dispatching store actions, etc. Targets the default tab unless `tabId` is given.',
    inputSchema: { code: z.string(), tabId: z.string().optional(), ...MSG },
  },
  async ({ code, tabId, message }) => json(await bridge.dispatch('eval', { code }, tabOpts({ tabId, message }, { timeoutMs: 15000 })))
);

server.registerTool(
  'screenshot',
  {
    title: 'Screenshot the page (in-page capture)',
    description:
      'Capture a PNG screenshot of the tab (or an element via `selector`) using in-page html2canvas, returned as a data URL. Best-effort — there is no headless browser, so complex CSS may not render perfectly, and it needs network access to load html2canvas. Targets the default tab unless `tabId` is given.',
    inputSchema: { selector: z.string().optional(), scale: z.number().optional(), tabId: z.string().optional(), ...MSG },
  },
  async ({ selector, scale, tabId, message }) =>
    json(await bridge.dispatch('screenshot', { selector, scale }, tabOpts({ tabId, message }, { timeoutMs: 20000 })))
);

server.registerTool(
  'find',
  {
    title: 'Search the page',
    description:
      'Search the current page for things matching a `query` (case-insensitive substring): input fields (by label, name, id, placeholder, or current value), clickable actions (by text/href), and rendered React components (by name). Returns matches with stable selectors so you can act on them. Narrow with `in` (e.g. ["fields"], ["actions"], ["components"]). Use this instead of dumping a full snapshot when you know what you are looking for. Targets the default tab unless `tabId` is given.',
    inputSchema: {
      query: z.string(),
      in: z.array(z.enum(['fields', 'actions', 'components'])).optional(),
      tabId: z.string().optional(),
    },
  },
  async ({ query, in: scopes, tabId, message }) =>
    json(await bridge.dispatch('find', { query, in: scopes }, tabOpts({ tabId, message })))
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Diagnostics go to stderr so they never corrupt the stdio JSON-RPC channel.
  console.error(
    `[nextjs-agent-mcp] ready — project=${config.project} wsPort=${config.wsPort} (Phase 1: Mode A)`
  );
}

main().catch((err) => {
  console.error('[nextjs-agent-mcp] fatal:', err);
  process.exit(1);
});
