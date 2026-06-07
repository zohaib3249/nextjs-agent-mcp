// Mode B — WebSocket server inside the MCP. Relays commands to the in-page <AgentBridge/>
// and awaits structured results. The agent's tools call dispatch(op, args, { tabId }).
//
// Multi-tab: every connected tab self-registers a stable `tabId` (sent in its hello). The agent
// can list tabs, target a specific tab by id, or broadcast to all. Default target = most-recent.
import { WebSocketServer } from 'ws';

export class BridgeServer {
  constructor({ port, exitOnBindError = true }) {
    this.port = port;
    this.exitOnBindError = exitOnBindError;
    this.wss = null;
    this.clients = new Set(); // active bridge sockets, newest last
    this.pending = new Map(); // commandId -> { resolve, reject, timer }
    this.consoleLog = []; // forwarded browser console errors
    this._seq = 0;
    this.bindError = null; // set if the port could not be bound (e.g. EADDRINUSE)
  }

  start() {
    if (this.wss) return { alreadyRunning: true, port: this.port };
    const wss = new WebSocketServer({ port: this.port });
    // CRITICAL: surface bind failures. Two MCP instances on the same --ws-port collide here;
    // without this the bridge silently never listens and every tool reports "no tab connected".
    wss.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE') {
        this.bindError = `Port ${this.port} already in use — another nextjs-agent MCP is likely running on this --ws-port. ` +
          `Stop the other instance or pass a different --ws-port (and set NEXT_PUBLIC_AGENT_BRIDGE_PORT to match).`;
        console.error('[bridge] ' + this.bindError);
        this.wss = null;
        // Fail fast: a second instance with a dead bridge is useless and confusing. Exit so the
        // launcher (IDE / MCP host) clearly reports a failed start instead of a half-alive server.
        if (this.exitOnBindError) {
          console.error('[bridge] exiting because the WS port is unavailable.');
          process.exit(1);
        }
      } else {
        console.error('[bridge] ws error:', e && e.message);
      }
    });
    wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.meta = { tabId: null, url: null, pathname: null, title: null, userAgent: null, connectedAt: Date.now() };
      ws.on('message', (raw) => this._onMessage(ws, raw));
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });
    this.wss = wss;
    return { started: true, port: this.port };
  }

  _onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.kind === 'hello') {
      ws.meta.tabId = msg.tabId || ws.meta.tabId;
      ws.meta.url = msg.url;
      ws.meta.pathname = msg.pathname || null;
      ws.meta.title = msg.title || null;
      ws.meta.userAgent = msg.userAgent;
      return;
    }
    if (msg.kind === 'console') {
      this.consoleLog.push({ ts: Date.now(), level: msg.level, message: msg.message, tabId: ws.meta.tabId });
      if (this.consoleLog.length > 500) this.consoleLog.shift();
      return;
    }
    if (msg.kind === 'result' && this.pending.has(msg.id)) {
      const { resolve, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      resolve(msg.ok ? { ok: true, value: msg.value } : { ok: false, error: msg.error });
    }
  }

  _openClients() {
    return [...this.clients].filter((w) => w.readyState === w.OPEN);
  }

  // Resolve a target socket: by explicit tabId, else most-recently-connected open socket.
  _target(tabId) {
    const open = this._openClients();
    if (tabId) return open.find((w) => w.meta.tabId === tabId) || null;
    return open.length ? open[open.length - 1] : null;
  }

  tabInfo(ws) {
    return { tabId: ws.meta.tabId, url: ws.meta.url, pathname: ws.meta.pathname, title: ws.meta.title, userAgent: ws.meta.userAgent };
  }

  // List every connected tab (id + url + title). Most-recent last.
  listTabs() {
    const tabs = this._openClients().map((w) => this.tabInfo(w));
    return { count: tabs.length, defaultTabId: tabs.length ? tabs[tabs.length - 1].tabId : null, tabs };
  }

  status() {
    return {
      listening: !!this.wss,
      port: this.port,
      bindError: this.bindError,
      connectedTabs: this._openClients().map((w) => this.tabInfo(w)),
    };
  }

  // Low-level: send one op to one socket and await its result.
  _send(ws, op, args, timeoutMs) {
    const id = ++this._seq;
    const frame = JSON.stringify({ kind: 'command', id, op, args });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `Timed out after ${timeoutMs}ms waiting for bridge op "${op}".` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        ws.send(frame);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: `Failed to send op "${op}": ${e && e.message}` });
      }
    });
  }

  // Send an op to the target tab (or a specific tabId) and await its result.
  // Pass { all: true } to broadcast to every connected tab and get an array of per-tab results.
  async dispatch(op, args = {}, { timeoutMs = 10000, tabId = null, all = false } = {}) {
    if (this.bindError) return { ok: false, error: this.bindError };

    if (all) {
      const open = this._openClients();
      if (!open.length) return { ok: false, error: this._noTabMsg() };
      const results = await Promise.all(
        open.map(async (ws) => ({ tabId: ws.meta.tabId, ...(await this._send(ws, op, args, timeoutMs)) }))
      );
      return { ok: true, value: { broadcast: true, count: results.length, results } };
    }

    const ws = this._target(tabId);
    if (!ws) {
      return {
        ok: false,
        error: tabId
          ? `No connected tab with tabId "${tabId}". Call list_tabs to see connected tabs.`
          : this._noTabMsg(),
      };
    }
    return this._send(ws, op, args, timeoutMs);
  }

  _noTabMsg() {
    return 'No browser tab connected. Open a dev page (e.g. http://localhost:3000/en) so <AgentBridge/> can connect, or use open_tab once a tab is connected.';
  }

  consoleMessages({ since, tabId } = {}) {
    let items = since ? this.consoleLog.slice(since) : this.consoleLog;
    if (tabId) items = items.filter((m) => m.tabId === tabId);
    return { count: items.length, total: this.consoleLog.length, messages: items };
  }
}
