// Mode B — WebSocket server inside the MCP. Relays commands to the in-page <AgentBridge/>
// and awaits structured results. The agent's tools call dispatch(op, args, { tabId }).
//
// Multi-tab: every connected tab self-registers a stable `tabId` (sent in its hello). The agent
// can list tabs, target a specific tab by id, or broadcast to all. Default target = most-recent.
import { WebSocketServer } from 'ws';

export class BridgeServer {
  constructor({ port, portRange = 11 }) {
    this.basePort = port;
    this.port = port;
    this.portRange = portRange; // how many ports to try if the base is busy (port..port+range-1)
    this.wss = null;
    this.clients = new Set(); // active bridge sockets, newest last
    this.pending = new Map(); // commandId -> { resolve, reject, timer }
    this.consoleLog = []; // forwarded browser console errors
    this._seq = 0;
    this.bindError = null; // set if NO port in the range could be bound
    this.activeTabId = null; // sticky "current" tab; tab-aware tools default to it when set
  }

  // Try the base port; if busy, auto-advance through the range until one binds. The bridge in the
  // browser scans the same range, so a shifted port still connects (no manual --ws-port juggling).
  start() {
    if (this.wss) return { alreadyRunning: true, port: this.port };
    this._tryBind(this.basePort, 0);
    return { started: true, port: this.port, basePort: this.basePort };
  }

  _tryBind(port, attempt) {
    const wss = new WebSocketServer({ port });
    wss.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE' && attempt < this.portRange - 1) {
        const next = port + 1;
        console.error(`[bridge] port ${port} busy — trying ${next}…`);
        try {
          wss.close();
        } catch {
          /* ignore */
        }
        this._tryBind(next, attempt + 1);
      } else if (e && e.code === 'EADDRINUSE') {
        this.bindError = `No free WS port in ${this.basePort}–${this.basePort + this.portRange - 1}. Close other instances.`;
        console.error('[bridge] ' + this.bindError);
        this.wss = null;
      } else {
        console.error('[bridge] ws error:', e && e.message);
      }
    });
    wss.on('listening', () => {
      this.port = port;
      this.bindError = null;
      if (port !== this.basePort) console.error(`[bridge] listening on auto-selected port ${port} (base ${this.basePort} was busy)`);
    });
    wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.meta = { tabId: null, url: null, pathname: null, title: null, userAgent: null, connectedAt: Date.now() };
      ws.on('message', (raw) => this._onMessage(ws, raw));
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });
    this.wss = wss;
    this.port = port;
  }

  _onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.kind === 'hello') {
      // De-dupe: if another OPEN socket already claims this tabId (e.g. tabs that inherited the
      // same sessionStorage/window.name via duplicate-tab), assign this one a fresh unique id and
      // tell the bridge to adopt it. Guarantees every connected tab has a distinct tabId.
      let tabId = msg.tabId || ws.meta.tabId || this._mkTabId();
      if (this._tabIdInUse(tabId, ws)) {
        const fresh = this._mkTabId();
        tabId = fresh;
        try {
          ws.send(JSON.stringify({ kind: 'assignTabId', tabId: fresh }));
        } catch {
          /* ignore */
        }
      }
      ws.meta.tabId = tabId;
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

  // Is this tabId already claimed by a different open socket?
  _tabIdInUse(tabId, exceptWs) {
    return this._openClients().some((w) => w !== exceptWs && w.meta.tabId === tabId);
  }

  // Server-generated unique tab id (collision-checked).
  _mkTabId() {
    let id;
    do {
      id = 'tab-' + Math.random().toString(36).slice(2, 10) + (++this._seq).toString(36);
    } while (this._tabIdInUse(id, null));
    return id;
  }

  // Resolve a target socket. Priority: explicit tabId → sticky active tab → most-recently-connected.
  _target(tabId) {
    const open = this._openClients();
    if (tabId) return open.find((w) => w.meta.tabId === tabId) || null;
    if (this.activeTabId) {
      const active = open.find((w) => w.meta.tabId === this.activeTabId);
      if (active) return active;
    }
    return open.length ? open[open.length - 1] : null;
  }

  tabInfo(ws) {
    return { tabId: ws.meta.tabId, url: ws.meta.url, pathname: ws.meta.pathname, title: ws.meta.title, userAgent: ws.meta.userAgent };
  }

  // The effective default tab id (active if set & still connected, else most-recent).
  _defaultTabId() {
    const ws = this._target(null);
    return ws ? ws.meta.tabId : null;
  }

  // List every connected tab (id + url + title). Most-recent last.
  listTabs() {
    const tabs = this._openClients().map((w) => this.tabInfo(w));
    return { count: tabs.length, activeTabId: this.activeTabId, defaultTabId: this._defaultTabId(), tabs };
  }

  // Report the current/active tab (what tab-aware tools target by default).
  currentTab() {
    const ws = this._target(null);
    return {
      activeTabId: this.activeTabId,
      defaultTabId: this._defaultTabId(),
      sticky: !!this.activeTabId,
      tab: ws ? this.tabInfo(ws) : null,
    };
  }

  // Set the sticky active tab. Pass null to clear (revert to most-recent). Returns the new state.
  setActiveTab(tabId) {
    if (tabId === null || tabId === undefined) {
      this.activeTabId = null;
      return { ok: true, cleared: true, ...this.currentTab() };
    }
    const exists = this._openClients().some((w) => w.meta.tabId === tabId);
    if (!exists) {
      return { ok: false, error: `No connected tab with tabId "${tabId}". Call list_tabs to see connected tabs.` };
    }
    this.activeTabId = tabId;
    return { ok: true, ...this.currentTab() };
  }

  status() {
    return {
      listening: !!this.wss,
      port: this.port,
      bindError: this.bindError,
      connectedTabs: this._openClients().map((w) => this.tabInfo(w)),
    };
  }

  // Low-level: send one op to one socket and await its result. `message` (optional) is the agent's
  // human-readable narration for this call; the bridge types it into the on-page toast.
  _send(ws, op, args, timeoutMs, message) {
    const id = ++this._seq;
    const frame = JSON.stringify({ kind: 'command', id, op, args, message: message || null });
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
  async dispatch(op, args = {}, { timeoutMs = 10000, tabId = null, all = false, message = null } = {}) {
    if (this.bindError) return { ok: false, error: this.bindError };

    if (all) {
      const open = this._openClients();
      if (!open.length) return { ok: false, error: this._noTabMsg() };
      const results = await Promise.all(
        open.map(async (ws) => ({ tabId: ws.meta.tabId, ...(await this._send(ws, op, args, timeoutMs, message)) }))
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
    return this._send(ws, op, args, timeoutMs, message);
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
