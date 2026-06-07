#!/usr/bin/env node
// nextjs-agent-mcp — MCP server for agent-driven testing of a Next.js app.
// Phase 1: Mode-A (headless) introspection — route_map + get_errors. No browser.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadConfig } from './config.js';
import { buildRouteMap } from './modeA/routes.js';
import { ErrorTracker } from './modeA/errors.js';
import { BridgeServer } from './modeB/wsServer.js';

const config = loadConfig();
const tracker = new ErrorTracker();
const bridge = new BridgeServer({ port: config.wsPort });
bridge.start();

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
      'List all App Router routes (pages + route handlers) for the configured Next.js project, read from the filesystem. Reports whether routes are locale-prefixed (e.g. /:locale).',
    inputSchema: {},
  },
  async () => json(await buildRouteMap(config.project))
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

// Shared targeting params for tab-aware tools. `tabId` targets a specific tab (from list_tabs);
// omit it to target the most-recently-connected tab. `all: true` broadcasts to every tab.
const TAB_TARGET = { tabId: z.string().optional(), all: z.boolean().optional() };
const targetOpts = ({ tabId, all }, extra = {}) => ({ tabId: tabId ?? null, all: all ?? false, ...extra });

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
      'List every browser tab currently connected via <AgentBridge/>: each tab\'s `tabId`, url, pathname, and title, plus the `defaultTabId` (the most-recently-connected tab that tab-aware tools target when no tabId is given). Use the tabId to target a specific tab in click/fill/snapshot/etc.',
    inputSchema: {},
  },
  async () => json(bridge.listTabs())
);

server.registerTool(
  'open_tab',
  {
    title: 'Open a new browser tab',
    description:
      'Open a new browser tab at `url` (path-only like "/en/..." is resolved against the current origin). An existing connected tab performs the window.open, and the new tab auto-connects with its own tabId — call list_tabs afterward to get it. Requires at least one tab already connected and popups allowed for the origin. Use `tabId` to choose which existing tab opens it.',
    inputSchema: { url: z.string(), tabId: z.string().optional() },
  },
  async ({ url, tabId }) => json(await bridge.dispatch('open_tab', { url }, { tabId: tabId ?? null }))
);

server.registerTool(
  'click',
  {
    title: 'Click (real DOM event)',
    description:
      'Click an element by CSS selector, firing a real pointer+mouse+click sequence so React/MUI handlers run. Targets the default tab unless `tabId` is given (or `all` to click in every tab). Requires a connected tab.',
    inputSchema: { selector: z.string(), ...TAB_TARGET },
  },
  async ({ selector, tabId, all }) => json(await bridge.dispatch('click', { selector }, targetOpts({ tabId, all })))
);

server.registerTool(
  'fill',
  {
    title: 'Fill input (real input event)',
    description:
      'Set the value of an input/textarea via the native value setter + a real `input` event, so React onChange and MUI controlled inputs register the change. Targets the default tab unless `tabId` is given (or `all`). Requires a connected tab.',
    inputSchema: { selector: z.string(), value: z.string(), ...TAB_TARGET },
  },
  async ({ selector, value, tabId, all }) =>
    json(await bridge.dispatch('fill', { selector, value }, targetOpts({ tabId, all })))
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
    inputSchema: { tabId: z.string().optional() },
  },
  async ({ tabId }) => json(await bridge.dispatch('snapshot', {}, { tabId: tabId ?? null }))
);

server.registerTool(
  'page_context',
  {
    title: 'Where am I (current route)',
    description:
      'Lightweight "what page am I on" for a tab: url, pathname, detected locale, document title, and the visible page heading. Cheaper than snapshot. Targets the default tab unless `tabId` is given. Requires a connected tab.',
    inputSchema: { tabId: z.string().optional() },
  },
  async ({ tabId }) => json(await bridge.dispatch('page_context', {}, { tabId: tabId ?? null }))
);

server.registerTool(
  'components',
  {
    title: 'Rendered React component tree',
    description:
      'Walk the React fiber tree of a tab and return the rendered components: a `summary` (each component name + instance count), a `tree` (name, nesting depth, and hook shape per instance), and totals. ' +
      'Pass `selector` to scope to one element\'s subtree. NOTE (React 19): source file/line and hook *names* are not available from fibers; hook shape (count, hasState, hasEffect) is inferred. Targets the default tab unless `tabId` is given. Requires a connected tab.',
    inputSchema: { selector: z.string().optional(), tabId: z.string().optional() },
  },
  async ({ selector, tabId }) =>
    json(await bridge.dispatch('components', selector ? { selector } : {}, { tabId: tabId ?? null }))
);

server.registerTool(
  'component_for',
  {
    title: 'Component owning an element',
    description:
      'Given a CSS selector, return the chain of React components that render that DOM element (nearest owner first), each with its hook shape. Targets the default tab unless `tabId` is given. Requires a connected tab.',
    inputSchema: { selector: z.string(), tabId: z.string().optional() },
  },
  async ({ selector, tabId }) => json(await bridge.dispatch('component_for', { selector }, { tabId: tabId ?? null }))
);

server.registerTool(
  'rerender',
  {
    title: 'Force a component to re-render',
    description:
      'Force the nearest function component owning `selector` to re-render (dispatches its existing state with the same value, which React still schedules as a render). Returns ok:false if the component has no state hook to nudge. Targets the default tab unless `tabId` is given. Requires a connected tab.',
    inputSchema: { selector: z.string(), tabId: z.string().optional() },
  },
  async ({ selector, tabId }) => json(await bridge.dispatch('rerender', { selector }, { tabId: tabId ?? null }))
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
  async ({ selector, text, timeoutMs, tabId }) =>
    json(
      await bridge.dispatch(
        'wait_for',
        { selector, text, timeoutMs },
        { timeoutMs: (timeoutMs || 5000) + 2000, tabId: tabId ?? null }
      )
    )
);

server.registerTool(
  'navigate',
  {
    title: 'Navigate the tab',
    description:
      'Navigate a tab to a URL (full-page assign). Remember locale prefix, e.g. /en/.... Targets the default tab unless `tabId` is given (or `all` to navigate every tab).',
    inputSchema: { url: z.string(), ...TAB_TARGET },
  },
  async ({ url, tabId, all }) => json(await bridge.dispatch('navigate', { url }, targetOpts({ tabId, all })))
);

server.registerTool(
  'console_messages',
  {
    title: 'Browser console logs',
    description:
      'Return ALL client-side console output (log, info, warn, error, debug) plus uncaught errors and unhandled promise rejections, forwarded by <AgentBridge/>. Each entry has {ts, level, message, tabId}. Pass `since` (an index) for deltas, or `tabId` to filter to one tab. Complements get_errors (server-side).',
    inputSchema: { since: z.number().int().optional(), tabId: z.string().optional() },
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
  async ({ hard, tabId, all }) => json(await bridge.dispatch('reload', { hard: !!hard }, targetOpts({ tabId, all })))
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
  async ({ types, urlContains, since, limit, includeBodies, tabId }) =>
    json(await bridge.dispatch('network_calls', { types, urlContains, since, limit, includeBodies }, { tabId: tabId ?? null }))
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
  async ({ area, action, key, value, tabId, all }) =>
    json(await bridge.dispatch('storage', { area, action, key, value }, targetOpts({ tabId, all })))
);

server.registerTool(
  'cache',
  {
    title: 'Cache Storage (PWA/Service Worker caches)',
    description:
      'Inspect or clear the browser Cache Storage in a tab. `action`: "list" (names + entry counts + sample urls) | "clear" (all, or a specific `name`). Targets the default tab unless `tabId` is given (or `all`).',
    inputSchema: { action: z.enum(['list', 'clear']).optional(), name: z.string().optional(), ...TAB_TARGET },
  },
  async ({ action, name, tabId, all }) =>
    json(await bridge.dispatch('cache', { action, name }, targetOpts({ tabId, all })))
);

server.registerTool(
  'eval',
  {
    title: 'Run JS in the page (dev-only)',
    description:
      'Execute arbitrary JavaScript in the tab and return the serialized result. The snippet may `return` a value or be a single expression; promises are awaited. Result is JSON-serialized and size-capped. DEV-ONLY — use for inspecting app state, dispatching store actions, etc. Targets the default tab unless `tabId` is given.',
    inputSchema: { code: z.string(), tabId: z.string().optional() },
  },
  async ({ code, tabId }) => json(await bridge.dispatch('eval', { code }, { tabId: tabId ?? null, timeoutMs: 15000 }))
);

server.registerTool(
  'screenshot',
  {
    title: 'Screenshot the page (in-page capture)',
    description:
      'Capture a PNG screenshot of the tab (or an element via `selector`) using in-page html2canvas, returned as a data URL. Best-effort — there is no headless browser, so complex CSS may not render perfectly, and it needs network access to load html2canvas. Targets the default tab unless `tabId` is given.',
    inputSchema: { selector: z.string().optional(), scale: z.number().optional(), tabId: z.string().optional() },
  },
  async ({ selector, scale, tabId }) =>
    json(await bridge.dispatch('screenshot', { selector, scale }, { tabId: tabId ?? null, timeoutMs: 20000 }))
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
  async ({ query, in: scopes, tabId }) =>
    json(await bridge.dispatch('find', { query, in: scopes }, { tabId: tabId ?? null }))
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
