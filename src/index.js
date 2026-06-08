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
import { AgentClient } from './modeB/agentClient.js';
import { ChromeController } from './modeB/chrome.js';

const config = loadConfig();
const tracker = new ErrorTracker();
// Optional real-browser control via CDP (open profiles, list/open/close/activate tabs).
const chrome = new ChromeController({ port: config.chromePort, chromePath: config.chromePath });
// `bridge` is now a broker CLIENT (registers this MCP as an agent; binds one tab at a time).
const bridge = new AgentClient({ port: config.wsPort, agentId: config.agentId, name: config.agentName });

// Claim a tab for this agent: bind the first FREE tab; if none free, open a new tab (via any
// existing tab) and bind that. `intent` is shown in the claimed tab's HUD. Returns the binding.
async function claimTab({ intent = '', tabId = null, match = null } = {}) {
  let res = await bridge.claim({ intent, tabId, match });
  if (res.ok) {
    if (intent) bridge.dispatch('status', { message: intent, kind: 'action' }, { timeoutMs: 4000 }).catch(() => {});
    return { ok: true, claimed: res.tabId, ...bridge.agentInfo() };
  }
  if (res.needTab && !tabId) {
    // No free tab — open a new one via any connected tab, wait for it to register, then claim free.
    const list = bridge.listTabs();
    const opener = list.tabs[0];
    if (!opener) {
      return { ok: false, error: 'No browser tab is connected at all. Open the app (e.g. http://localhost:3000) first.' };
    }
    // Ask the broker to relay an open_tab to the opener tab — but we can only cmd tabs we own.
    // Temporarily claim the opener, open a tab, release, then claim the freshly-opened free tab.
    const tmp = await bridge.claim({ tabId: opener.tabId, intent: 'opening a new tab…' });
    if (!tmp.ok) return { ok: false, error: tmp.error || 'could not open a new tab' };
    await bridge.dispatch('open_tab', { url: config.openUrl || '/' }, { timeoutMs: 6000 }).catch(() => {});
    bridge.release();
    // Wait briefly for the new tab to connect & register as free.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      bridge.listTabs();
      await new Promise((r) => setTimeout(r, 50));
      if (bridge.tabs.some((t) => t.free)) break;
    }
    res = await bridge.claim({ intent });
    if (res.ok) {
      if (intent) bridge.dispatch('status', { message: intent, kind: 'action' }, { timeoutMs: 4000 }).catch(() => {});
      return { ok: true, claimed: res.tabId, opened: true, ...bridge.agentInfo() };
    }
    return { ok: false, error: res.error || 'opened a tab but could not claim it' };
  }
  return { ok: false, error: res.error || 'could not claim a tab' };
}

// Optional local HTTP control endpoint — drive THIS agent via curl (debug/automation).
//   GET  /status   GET /tabs   GET /route_map
//   POST /claim {intent}   POST /release   POST /op {op,args}
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
    const readBody = (cb) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => cb(JSON.parse(body || '{}')));
    };
    if (req.method === 'POST' && url === '/claim') return readBody(async (b) => send(200, await claimTab(b)));
    if (req.method === 'POST' && url === '/release') return send(200, bridge.release());
    if (req.method === 'POST' && url === '/op') {
      readBody(async (b) => {
        try {
          if (!b.op) return send(400, { error: 'missing op' });
          send(200, await bridge.dispatch(b.op, b.args || {}, { message: b.message || null, timeoutMs: b.timeoutMs || 15000 }));
        } catch (e) {
          send(400, { error: String(e) });
        }
      });
      return;
    }
    send(404, { error: 'not found', endpoints: ['GET /status', 'GET /tabs', 'GET /route_map', 'POST /claim', 'POST /release', 'POST /op'] });
  });
  srv.on('error', (e) => console.error('[http-control] error:', e.message));
  srv.listen(port, '127.0.0.1', () => console.error(`[http-control] listening on http://127.0.0.1:${port}`));
}

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
//
// Connection model: this MCP is ONE agent connected to the shared broker. It controls exactly ONE
// browser tab at a time — the tab it has CLAIMED. Call `claim_tab` first; then all tools below act
// on that bound tab. A tab is inert (shows "unclaimed") until an agent claims it; an agent cannot
// touch a tab claimed by another agent.
//
//   message — short (≤2 lines) narration typed into the tab's on-page status bar.
const MSG = { message: z.string().optional() };
// All Mode-B tools now share the same opts: just message (+ optional timeoutMs via extra).
const opts = ({ message }, extra = {}) => ({ message: message ?? null, ...extra });

server.registerTool(
  'agent_info',
  {
    title: 'This agent + its bound tab',
    description:
      'Report this MCP agent\'s identity (agentId, name), whether it is connected to the broker, and which tab it currently controls (boundTabId, or null if none claimed yet).',
    inputSchema: {},
  },
  async () => json(bridge.agentInfo())
);

server.registerTool(
  'claim_tab',
  {
    title: 'Claim a tab to control',
    description:
      'Bind a browser tab to THIS agent so you can drive it. Choose the tab per your need: pass `tabId` for a specific one (from list_tabs), or `match` to claim a free tab whose url/title contains that text (e.g. "checkout"), or neither to take the first free tab. If none are free, a new tab is opened and claimed. `intent` (shown in the tab\'s HUD) tells a human what you\'re doing. Ownership SURVIVES a page reload (the tab re-binds to you automatically). **Call this before snapshot/click/fill/etc.**',
    inputSchema: { intent: z.string().optional(), tabId: z.string().optional(), match: z.string().optional() },
  },
  async ({ intent, tabId, match }) => json(await claimTab({ intent: intent || '', tabId: tabId ?? null, match: match ?? null }))
);

server.registerTool(
  'release_tab',
  {
    title: 'Release the bound tab',
    description:
      'Unbind the tab this agent currently controls, returning it to "unclaimed" so a human or another agent can take it. Safe to call when nothing is bound.',
    inputSchema: {},
  },
  async () => json(bridge.release())
);

server.registerTool(
  'list_tabs',
  {
    title: 'List all connected tabs',
    description:
      'List every browser tab connected to the broker: each tab\'s `tabId`, url, pathname, title, whether it is `free`, and `boundAgentName` if another agent owns it. `boundTabId` shows the tab THIS agent controls. Use a free tab\'s id with claim_tab to bind it.',
    inputSchema: {},
  },
  async () => json(bridge.listTabs())
);

server.registerTool(
  'bridge_status',
  {
    title: 'Bridge / broker status',
    description:
      'Report this agent\'s broker connection: connected?, port, agentId/name, the bound tab, and all connected tabs (with their owner). Use to check the setup before driving.',
    inputSchema: {},
  },
  async () => json(bridge.status())
);

server.registerTool(
  'open_tab',
  {
    title: 'Open a new browser tab',
    description:
      'Open a new browser tab at `url` (path-only like "/en/..." is resolved against the current origin). An existing connected tab performs the window.open, and the new tab auto-connects with its own tabId — call list_tabs afterward to get it. Requires at least one tab already connected and popups allowed for the origin. Use `tabId` to choose which existing tab opens it.',
    inputSchema: { url: z.string(), ...MSG },
  },
  async ({ url, message }) => json(await bridge.dispatch('open_tab', { url }, opts({ message })))
);

server.registerTool(
  'click',
  {
    title: 'Click (real DOM event)',
    description:
      'Click an element by CSS selector, firing a real pointer+mouse+click sequence so React/MUI handlers run. Requires a connected tab.',
    inputSchema: { selector: z.string(), ...MSG },
  },
  async ({ selector, message }) => json(await bridge.dispatch('click', { selector }, opts({ message })))
);

server.registerTool(
  'fill',
  {
    title: 'Fill any input (type-aware)',
    description:
      'Set the value of a form control, choosing the right strategy automatically: text/email/number/textarea (typed via React native setter), `<select>` (match by value or visible label), checkbox/radio, date/time, contenteditable — AND composed widgets (MUI Select/Autocomplete, Radix/shadcn dropdowns) which it opens-and-picks. Fires real input/change events so React & MUI register the change. Requires a connected tab.',
    inputSchema: { selector: z.string(), value: z.string(), ...MSG },
  },
  async ({ selector, value, message }) =>
    json(await bridge.dispatch('fill', { selector, value }, opts({ message })))
);

server.registerTool(
  'fill_form',
  {
    title: 'Fill multiple fields in one call',
    description:
      'Fill an entire form in a SINGLE call: pass `fields` as an array of {selector, value}. The bridge fills them one-by-one (cursor travels to each field + types it), so it stays visibly "controlled" but avoids a round-trip per field. ' +
      'Each field is filled type-aware — text/number, native select/checkbox/radio/date, AND composed widgets (MUI Select/Autocomplete, Radix/shadcn dropdowns) are auto-detected and opened-then-picked. ' +
      'Get the selectors from snapshot/find. Returns per-field results.',
    inputSchema: {
      fields: z.array(z.object({ selector: z.string(), value: z.string() })),
      ...MSG,
    },
  },
  async ({ fields, message }) =>
    json(await bridge.dispatch('fill_form', { fields }, opts({ message }, { timeoutMs: 60000 })))
);

server.registerTool(
  'select_option',
  {
    title: 'Pick an option in a dropdown/combobox',
    description:
      'Open a composed dropdown/combobox and select the option matching `value` (by visible text — exact then contains — or its data-value/value). Handles MUI `Select` & `Autocomplete`, Radix/shadcn comboboxes, and any role=combobox/listbox — i.e. the dropdowns that are NOT a native `<select>`. For Autocomplete it types `value` to filter first. (`fill`/`fill_form` auto-route here when the target is such a widget, so you usually don\'t need to call this directly — but use it when you want to be explicit.) Returns the selected option text, or lists available options if none matched.',
    inputSchema: { selector: z.string(), value: z.string(), ...MSG },
  },
  async ({ selector, value, message }) =>
    json(await bridge.dispatch('select_option', { selector, value }, opts({ message }, { timeoutMs: 12000 })))
);

server.registerTool(
  'set_field',
  {
    title: 'Set a field via React state (not just DOM)',
    description:
      'Fill a controlled input by BOTH the DOM native setter (input/change events — covers React Hook Form, MUI, uncontrolled) AND by invoking the element\'s React `onChange` prop directly (covers Formik and custom controlled handlers that read e.target.value). Use this when a normal `fill` does not "stick" because the component is heavily controlled. Returns which paths fired (`dom-native-setter`, `react-onChange`). For app stores (Redux) or form-lib APIs not on the element, use `eval` to call them directly.',
    inputSchema: { selector: z.string(), value: z.string(), ...MSG },
  },
  async ({ selector, value, message }) =>
    json(await bridge.dispatch('set_field', { selector, value }, opts({ message })))
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
      'Always call this before fill/click — pass a field/action `selector` from here to fill/click, and address fields by their `name`/`label`. Requires a connected tab.',
    inputSchema: { ...MSG },
  },
  async ({ message }) => json(await bridge.dispatch('snapshot', {}, opts({ message })))
);

server.registerTool(
  'page_context',
  {
    title: 'Where am I (current route)',
    description:
      'Lightweight "what page am I on" for a tab: url, pathname, detected locale, document title, and the visible page heading. Cheaper than snapshot. Requires a connected tab.',
    inputSchema: { ...MSG },
  },
  async ({ message }) => json(await bridge.dispatch('page_context', {}, opts({ message })))
);

server.registerTool(
  'think',
  {
    title: 'Narrate intent (show in HUD)',
    description:
      'Send a short first-person message describing what you are about to do or your current reasoning (e.g. "Now I\'ll fill the login form and submit"). It is displayed in the in-page HUD and as a floating thought bubble so a human can follow along. Purely cosmetic — it performs no page action. Call it before a sequence of actions to make the run readable.',
    inputSchema: { message: z.string() },
  },
  async ({ message }) => json(await bridge.dispatch('think', { message }, opts({ message })))
);

server.registerTool(
  'status',
  {
    title: 'Show a status line (typed in the on-page bar)',
    description:
      'Type a short status into the persistent on-page status bar so a human can follow along. ' +
      '`kind` sets the icon/intent: "thinking" (💭 internal reasoning), "code" (⌘ checking/reading code), "net" (⇅ network), or "action" (✦, default). ' +
      'The message stays at least ~10s; if no newer status/action arrives it cycles gentle idle phrases. `dwellMs` overrides the hold time. Cosmetic only.',
    inputSchema: {
      message: z.string(),
      kind: z.enum(['thinking', 'code', 'net', 'action']).optional(),
      dwellMs: z.number().int().optional(),
    },
  },
  async ({ message, kind, dwellMs }) =>
    json(await bridge.dispatch('status', { message, kind, dwellMs }, opts({ message })))
);

server.registerTool(
  'overview',
  {
    title: 'Page overview (landmark map)',
    description:
      'Return the structural layout of the current page so you know the lay of the land: `header` (banner + its links/buttons), `nav` (navigation lists + items), `sidebars` (with items), `sections` (landmark regions by heading), `tabs` (tab lists + active tab), `headings` (h1–h3 outline), `footer` (+ items), and `openOverlays` (dialogs/menus currently open and possibly blocking). Use after navigating to understand where things are, then snapshot/find/click into a region. Requires a connected tab.',
    inputSchema: { ...MSG },
  },
  async ({ message }) => json(await bridge.dispatch('overview', {}, opts({ message })))
);

server.registerTool(
  'components',
  {
    title: 'Rendered React component tree',
    description:
      'Walk the React fiber tree of a tab and return the rendered components: a `summary` (each component name + instance count), a `tree` (name, nesting depth, and hook shape per instance), and totals. ' +
      'Pass `selector` to scope to one element\'s subtree. NOTE (React 19): source file/line and hook *names* are not available from fibers; hook shape (count, hasState, hasEffect) is inferred. Requires a connected tab.',
    inputSchema: { selector: z.string().optional(), ...MSG },
  },
  async ({ selector, message }) =>
    json(await bridge.dispatch('components', selector ? { selector } : {}, opts({ message })))
);

server.registerTool(
  'component_for',
  {
    title: 'Component owning an element',
    description:
      'Given a CSS selector, return the chain of React components that render that DOM element (nearest owner first), each with its hook shape. Requires a connected tab.',
    inputSchema: { selector: z.string(), ...MSG },
  },
  async ({ selector, message }) => json(await bridge.dispatch('component_for', { selector }, opts({ message })))
);

server.registerTool(
  'rerender',
  {
    title: 'Force a component to re-render',
    description:
      'Force the nearest function component owning `selector` to re-render (dispatches its existing state with the same value, which React still schedules as a render). Returns ok:false if the component has no state hook to nudge. Requires a connected tab.',
    inputSchema: { selector: z.string(), ...MSG },
  },
  async ({ selector, message }) => json(await bridge.dispatch('rerender', { selector }, opts({ message })))
);

server.registerTool(
  'wait_for',
  {
    title: 'Wait for selector/text',
    description:
      'Poll a tab until a CSS selector appears or visible text is present, or timeout. Use after navigation or an action that triggers async rendering.',
    inputSchema: {
      selector: z.string().optional(),
      text: z.string().optional(),
      timeoutMs: z.number().int().optional(),
    },
  },
  async ({ selector, text, timeoutMs, message }) =>
    json(
      await bridge.dispatch(
        'wait_for',
        { selector, text, timeoutMs },
        opts({ message }, { timeoutMs: (timeoutMs || 5000) + 2000 })
      )
    )
);

server.registerTool(
  'navigate',
  {
    title: 'Navigate the tab',
    description:
      'Navigate a tab to a URL and return: a page `overview` (landmark map: header/nav/sidebars/sections/tabs/headings/footer/openOverlays) AND `errorUrls` — the page\'s FAILED network requests as `{url, status, type}` (4xx/5xx like 404/401/403/500/502), newest first. ' +
      'By default the top 20 error urls are returned; pass `return_error_urls` to get more (or 0 to skip). Remember locale prefix, e.g. /en/.... For a full-document load, the overview reflects the page at call time — if it just unloaded, call `overview`/`network_calls` again once it has loaded.',
    inputSchema: { url: z.string(), return_error_urls: z.number().int().optional(), ...MSG },
  },
  async ({ url, return_error_urls, message }) =>
    json(await bridge.dispatch('navigate', { url, return_error_urls }, opts({ message }, { timeoutMs: 8000 })))
);

server.registerTool(
  'console_messages',
  {
    title: 'Browser console logs',
    description:
      'Return ALL client-side console output (log, info, warn, error, debug) plus uncaught errors and unhandled promise rejections, forwarded by <AgentBridge/>. Each entry has {ts, level, message, tabId}. Pass `since` (an index) for deltas, or `tabId` to filter to one tab. Complements get_errors (server-side).',
    inputSchema: { since: z.number().int().optional(), ...MSG },
  },
  async ({ since }) => json(bridge.consoleMessages({ since }))
);

server.registerTool(
  'reload',
  {
    title: 'Reload the tab',
    description: 'Reload the current page in a tab. Pass `hard: true` to reload without the in-page hash.',
    inputSchema: { hard: z.boolean().optional(), ...MSG },
  },
  async ({ hard, message }) => json(await bridge.dispatch('reload', { hard: !!hard }, opts({ message })))
);

server.registerTool(
  'network_calls',
  {
    title: 'Captured network requests',
    description:
      'Return network requests captured in the tab since page load: fetch & XHR (with method, status, type, timing, and capped response bodies) plus browser-loaded resources (image/css/script/font — metadata only). ' +
      'Filter with `types` (e.g. ["xhr","fetch","image","css","script","font","document"]), `urlContains`, `limit`, `since` (an id, for deltas), and `includeBodies` (default true).',
    inputSchema: {
      types: z.array(z.string()).optional(),
      urlContains: z.string().optional(),
      since: z.number().int().optional(),
      limit: z.number().int().optional(),
      includeBodies: z.boolean().optional(),
    },
  },
  async ({ types, urlContains, since, limit, includeBodies, message }) =>
    json(await bridge.dispatch('network_calls', { types, urlContains, since, limit, includeBodies }, opts({ message })))
);

server.registerTool(
  'storage',
  {
    title: 'Browser storage (local/session/cookie)',
    description:
      'Read or modify browser storage in a tab. `area`: "local" | "session" | "cookie". `action`: "get" (all, or one `key`) | "set" (key+value) | "delete" (key) | "clear".',
    inputSchema: {
      area: z.enum(['local', 'session', 'cookie']).optional(),
      action: z.enum(['get', 'set', 'delete', 'clear']).optional(),
      key: z.string().optional(),
      value: z.string().optional(),
      ...MSG,
    },
  },
  async ({ area, action, key, value, message }) =>
    json(await bridge.dispatch('storage', { area, action, key, value }, opts({ message })))
);

server.registerTool(
  'cache',
  {
    title: 'Cache Storage (PWA/Service Worker caches)',
    description:
      'Inspect or clear the browser Cache Storage in a tab. `action`: "list" (names + entry counts + sample urls) | "clear" (all, or a specific `name`).',
    inputSchema: { action: z.enum(['list', 'clear']).optional(), name: z.string().optional(), ...MSG },
  },
  async ({ action, name, message }) =>
    json(await bridge.dispatch('cache', { action, name }, opts({ message })))
);

server.registerTool(
  'eval',
  {
    title: 'Run JS in the page (dev-only)',
    description:
      'Execute arbitrary JavaScript in the tab and return the serialized result. The snippet may `return` a value or be a single expression; promises are awaited. Result is JSON-serialized and size-capped. DEV-ONLY — use for inspecting app state, dispatching store actions, etc.',
    inputSchema: { code: z.string(), ...MSG },
  },
  async ({ code, message }) => json(await bridge.dispatch('eval', { code }, opts({ message }, { timeoutMs: 15000 })))
);

server.registerTool(
  'screenshot',
  {
    title: 'Screenshot the page (in-page capture)',
    description:
      'Capture a PNG screenshot of the tab (or an element via `selector`) using in-page html2canvas, returned as a data URL. Best-effort — there is no headless browser, so complex CSS may not render perfectly, and it needs network access to load html2canvas.',
    inputSchema: { selector: z.string().optional(), scale: z.number().optional(), ...MSG },
  },
  async ({ selector, scale, message }) =>
    json(await bridge.dispatch('screenshot', { selector, scale }, opts({ message }, { timeoutMs: 20000 })))
);

server.registerTool(
  'find',
  {
    title: 'Search the page',
    description:
      'Search the current page for things matching a `query` (case-insensitive substring): input fields (by label, name, id, placeholder, or current value), clickable actions (by text/href), and rendered React components (by name). Returns matches with stable selectors so you can act on them. Narrow with `in` (e.g. ["fields"], ["actions"], ["components"]). Use this instead of dumping a full snapshot when you know what you are looking for.',
    inputSchema: {
      query: z.string(),
      in: z.array(z.enum(['fields', 'actions', 'components'])).optional(),
    },
  },
  async ({ query, in: scopes, message }) =>
    json(await bridge.dispatch('find', { query, in: scopes }, opts({ message })))
);

// ---- Chrome control (CDP) — real browser profiles + tabs ------------------
// These manage the actual browser process, beyond the in-page bridge: open a profile, see every
// open tab, open/close/activate tabs. Launch Chrome via chrome_launch (with the app's dev URL),
// then the in-page <AgentBridge/> on those tabs connects to the broker as usual for claim/drive.

server.registerTool(
  'chrome_launch',
  {
    title: 'Launch / attach Chrome (with a profile)',
    description:
      'Launch Chrome with remote debugging and a chosen profile directory (`profile` = a --user-data-dir path; different dirs keep separate logins/sessions). If a debuggable Chrome is already on the port, attaches instead. Pass `url` to open initially (e.g. your app), `headless` for no window. After this you can chrome_tabs / chrome_open_tab, and tabs that load your app + <AgentBridge/> will connect to the broker for claim/drive.',
    inputSchema: { profile: z.string().optional(), url: z.string().optional(), headless: z.boolean().optional() },
  },
  async ({ profile, url, headless }) => json(await chrome.launch({ profile: profile ?? null, url: url ?? null, headless: !!headless }))
);

server.registerTool(
  'chrome_tabs',
  {
    title: 'List ALL browser tabs (CDP)',
    description:
      'List every open tab in the controlled Chrome (id, title, url, active) — the real browser, not just bridge-connected tabs. Requires chrome_launch first (or an already-debuggable Chrome on --chrome-port).',
    inputSchema: {},
  },
  async () => json(await chrome.tabs())
);

server.registerTool(
  'chrome_open_tab',
  {
    title: 'Open a browser tab (CDP)',
    description: 'Open a new real browser tab at `url` in the controlled Chrome. Returns its id/url. Use chrome_tabs to see all tabs.',
    inputSchema: { url: z.string() },
  },
  async ({ url }) => json(await chrome.openTab(url))
);

server.registerTool(
  'chrome_activate_tab',
  {
    title: 'Focus a browser tab (CDP)',
    description: 'Bring a browser tab to the foreground by its `id` (from chrome_tabs).',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => json(await chrome.activateTab(id))
);

server.registerTool(
  'chrome_close_tab',
  {
    title: 'Close a browser tab (CDP)',
    description: 'Close a browser tab by its `id` (from chrome_tabs).',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => json(await chrome.closeTab(id))
);

async function main() {
  // Connect to the broker (spawning one if the port is free) and register this agent.
  await bridge.start();
  if (config.httpPort) startHttpControl(config.httpPort);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Diagnostics go to stderr so they never corrupt the stdio JSON-RPC channel.
  console.error(
    `[nextjs-agent-mcp] ready — project=${config.project} broker=${config.wsPort} agent="${config.agentName}" (${config.agentId})`
  );
}

main().catch((err) => {
  console.error('[nextjs-agent-mcp] fatal:', err);
  process.exit(1);
});
