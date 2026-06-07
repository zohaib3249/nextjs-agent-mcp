// Shared message protocol for the Mode-B bridge.
// The MCP server (wsServer.js) and the in-page <AgentBridge/> both speak this.
//
// Frame shapes (JSON over WebSocket):
//   server -> bridge:  { kind: "command", id, op, args }
//   bridge -> server:  { kind: "result",  id, ok, value, error }
//   bridge -> server:  { kind: "hello",   url, userAgent }      (on connect)
//   bridge -> server:  { kind: "console", level, message }      (forwarded console errors)
//
// Supported ops:
//   click, fill, navigate, wait_for                       (interaction)
//   snapshot (rich page model w/ forms+fields+values), page_context   (DOM introspection)
//   components, component_for, rerender                    (React fiber introspection)
export const OPS = Object.freeze({
  CLICK: 'click',
  FILL: 'fill',
  FILL_FORM: 'fill_form',
  SNAPSHOT: 'snapshot',
  PAGE_CONTEXT: 'page_context',
  OVERVIEW: 'overview',
  COMPONENTS: 'components',
  COMPONENT_FOR: 'component_for',
  RERENDER: 'rerender',
  WAIT_FOR: 'wait_for',
  NAVIGATE: 'navigate',
  RELOAD: 'reload',
  OPEN_TAB: 'open_tab',
  NETWORK_CALLS: 'network_calls',
  STORAGE: 'storage',
  CACHE: 'cache',
  EVAL: 'eval',
  SCREENSHOT: 'screenshot',
  FIND: 'find',
  THINK: 'think',
  STATUS: 'status',
});

export const DEFAULT_WS_PORT = 7333;
