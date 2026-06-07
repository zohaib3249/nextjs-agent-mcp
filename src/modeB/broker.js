// Broker — the single WebSocket hub that owns the bridge port (default 7333).
//
// Why: multiple MCP instances + multiple browser tabs used to collide on one port; tabs attached
// to whichever MCP grabbed the port, so an agent often talked to the WRONG instance. The broker
// fixes that: ONE process owns the port; every MCP connects to it as an AGENT (unique agentId),
// every <AgentBridge/> connects as a TAB. The broker routes commands by an exclusive
// tabId↔agentId binding. A tab is INERT until an agent claims it.
//
// Protocol (JSON frames, field `t` = type):
//   agent→broker:  {t:'register', role:'agent', agentId, name}
//   tab→broker:    {t:'register', role:'tab', tabId, url, pathname, title, userAgent}
//   agent→broker:  {t:'list'}                                  → {t:'tabs', tabs:[...]}
//   agent→broker:  {t:'claim', tabId?}                         → {t:'claimed', tabId} | {t:'error'}
//   agent→broker:  {t:'release', tabId}                        → {t:'released', tabId}
//   agent→broker:  {t:'cmd', id, tabId, op, args, message, intent}
//   broker→tab:    {t:'cmd', id, op, args, message, agentName, intent}
//   tab→broker:    {t:'result', id, ok, value, error}          → relayed to owning agent
//   tab→broker:    {t:'console'|'net', ...}                    → relayed to owning agent
//   broker→tab:    {t:'claimed', agentId, agentName, intent} | {t:'released'} | {t:'assignTabId', tabId}
//   broker→agent:  {t:'result', id, ...} | {t:'tabs', tabs} | {t:'event', kind, ...} | {t:'error', msg}
import { WebSocketServer } from 'ws';

export class Broker {
  constructor({ port }) {
    this.port = port;
    this.wss = null;
    this.agents = new Map(); // agentId -> ws
    this.tabs = new Map(); // tabId -> ws (only currently-connected tabs)
    this.binding = new Map(); // tabId -> { agentId, intent } (survives a tab reload)
    this._seq = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.port });
      wss.on('error', (e) => {
        if (!this.wss) reject(e); // bind failure (port busy) → caller decides to connect instead
        else console.error('[broker] ws error:', e && e.message);
      });
      wss.on('listening', () => {
        this.wss = wss;
        console.error(`[broker] listening on ${this.port}`);
        resolve({ started: true, port: this.port });
      });
      wss.on('connection', (ws) => {
        ws._meta = { role: null, id: null };
        ws.on('message', (raw) => this._onMessage(ws, raw));
        ws.on('close', () => this._onClose(ws));
        ws.on('error', () => this._onClose(ws));
      });
    });
  }

  _send(ws, obj) {
    try {
      if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }

  _onMessage(ws, raw) {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (m.t) {
      case 'register':
        return this._register(ws, m);
      case 'list':
        return this._send(ws, { t: 'tabs', tabs: this.tabList() });
      case 'claim':
        return this._claim(ws, m);
      case 'release':
        return this._release(ws, m.tabId);
      case 'cmd':
        return this._cmd(ws, m);
      case 'result': {
        // From a tab → relay to the agent that owns it.
        const owner = this.binding.get(ws._meta.id);
        const ag = owner && this.agents.get(owner.agentId);
        if (ag) this._send(ag, { t: 'result', id: m.id, ok: m.ok, value: m.value, error: m.error });
        return;
      }
      case 'console':
      case 'net': {
        const owner = this.binding.get(ws._meta.id);
        const ag = owner && this.agents.get(owner.agentId);
        if (ag) this._send(ag, { t: 'event', kind: m.t, tabId: ws._meta.id, payload: m });
        return;
      }
      default:
        return;
    }
  }

  _register(ws, m) {
    if (m.role === 'agent') {
      ws._meta = { role: 'agent', id: m.agentId, name: m.name || m.agentId };
      this.agents.set(m.agentId, ws);
      this._send(ws, { t: 'registered', role: 'agent', agentId: m.agentId });
      return;
    }
    // tab — de-dupe id (duplicated-tab inheritance), then register UNBOUND.
    let tabId = m.tabId || this._mkTabId();
    if (this.tabs.has(tabId) && this.tabs.get(tabId) !== ws) {
      tabId = this._mkTabId();
      this._send(ws, { t: 'assignTabId', tabId });
    }
    ws._meta = { role: 'tab', id: tabId, url: m.url, pathname: m.pathname, title: m.title, userAgent: m.userAgent };
    this.tabs.set(tabId, ws);
    this._send(ws, { t: 'registered', role: 'tab', tabId });
    // If this tabId was already bound (e.g. the tab just RELOADED), restore ownership so the page
    // doesn't go back to "unclaimed". Re-notify the tab AND the owning agent.
    const b = this.binding.get(tabId);
    if (b) {
      const ag = this.agents.get(b.agentId);
      if (ag) {
        this._send(ws, { t: 'claimed', agentId: b.agentId, agentName: ag._meta.name, intent: b.intent || '' });
      } else {
        // Owner gone while the tab was away → free it.
        this.binding.delete(tabId);
      }
    }
    this._broadcastTabsToAgents();
  }

  _claim(ws, m) {
    if (ws._meta.role !== 'agent') return this._send(ws, { t: 'error', msg: 'only agents can claim' });
    const agentId = ws._meta.id;
    let tabId = m.tabId;
    if (tabId) {
      const b = this.binding.get(tabId);
      if (b && b.agentId !== agentId) return this._send(ws, { t: 'error', msg: `tab ${tabId} is owned by ${b.agentId}` });
      if (!this.tabs.has(tabId)) return this._send(ws, { t: 'error', msg: `no tab ${tabId}` });
    } else {
      // Pick a FREE (connected + unbound) tab. If `match` is given, prefer a free tab whose url or
      // title contains it — so an agent can claim "the tab on /checkout" rather than any free one.
      const free = [...this.tabs.entries()].filter(([id]) => !this.binding.has(id));
      const match = (m.match || '').toLowerCase();
      const pick =
        (match && free.find(([, w]) => `${w._meta.url || ''} ${w._meta.title || ''}`.toLowerCase().includes(match))) ||
        free[0];
      tabId = pick ? pick[0] : undefined;
      if (!tabId) return this._send(ws, { t: 'needTab', msg: 'no free tab — open one' });
    }
    this.binding.set(tabId, { agentId, intent: m.intent || '' });
    this._send(ws, { t: 'claimed', tabId });
    const tab = this.tabs.get(tabId);
    this._send(tab, { t: 'claimed', agentId, agentName: ws._meta.name, intent: m.intent || '' });
    this._broadcastTabsToAgents();
  }

  _release(ws, tabId) {
    const b = this.binding.get(tabId);
    if (b && b.agentId === ws._meta.id) {
      this.binding.delete(tabId);
      const tab = this.tabs.get(tabId);
      if (tab) this._send(tab, { t: 'released' });
      this._send(ws, { t: 'released', tabId });
      this._broadcastTabsToAgents();
    }
  }

  _cmd(ws, m) {
    if (ws._meta.role !== 'agent') return;
    const agentId = ws._meta.id;
    const tabId = m.tabId;
    if (this.binding.get(tabId)?.agentId !== agentId) {
      return this._send(ws, { t: 'result', id: m.id, ok: false, error: `tab ${tabId} is not claimed by you (call claim_tab)` });
    }
    const tab = this.tabs.get(tabId);
    if (!tab) return this._send(ws, { t: 'result', id: m.id, ok: false, error: `tab ${tabId} disconnected` });
    this._send(tab, { t: 'cmd', id: m.id, op: m.op, args: m.args, message: m.message, agentName: ws._meta.name, intent: m.intent });
  }

  _onClose(ws) {
    const { role, id } = ws._meta || {};
    if (role === 'agent') {
      this.agents.delete(id);
      // free any tabs this agent owned (agent is truly gone)
      for (const [tabId, b] of [...this.binding]) {
        if (b.agentId === id) {
          this.binding.delete(tabId);
          const tab = this.tabs.get(tabId);
          if (tab) this._send(tab, { t: 'released' });
        }
      }
      this._broadcastTabsToAgents();
    } else if (role === 'tab') {
      // A tab disconnect is often just a RELOAD/navigation. Remove it from the live set, but KEEP
      // its binding so the same tabId restores ownership when it reconnects a moment later.
      // (The binding is cleared only if the OWNING AGENT disconnects, above.)
      this.tabs.delete(id);
      this._broadcastTabsToAgents();
    }
  }

  _broadcastTabsToAgents() {
    const tabs = this.tabList();
    for (const ag of this.agents.values()) this._send(ag, { t: 'tabs', tabs });
  }

  tabList() {
    return [...this.tabs.entries()].map(([tabId, ws]) => {
      const b = this.binding.get(tabId);
      return {
        tabId,
        url: ws._meta.url,
        pathname: ws._meta.pathname,
        title: ws._meta.title,
        boundAgentId: b ? b.agentId : null,
        boundAgentName: b ? this.agents.get(b.agentId)?._meta.name || b.agentId : null,
        free: !b,
      };
    });
  }

  _mkTabId() {
    let id;
    do {
      id = 'tab-' + Math.random().toString(36).slice(2, 10) + (++this._seq).toString(36);
    } while (this.tabs.has(id));
    return id;
  }
}
