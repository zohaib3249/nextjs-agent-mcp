// AgentClient — the broker-client used by an MCP instance. Replaces the old in-process BridgeServer
// as the thing tools call. It connects to the Broker (spawning one if the port is free), registers
// as an agent with a unique id + name, and exposes claim/release/dispatch over the agent's BOUND tab.
//
// Tools call: client.claim({intent,tabId}), client.release(), client.listTabs(), client.dispatch(op,args).
import { WebSocket } from 'ws';
import { Broker } from './broker.js';

export class AgentClient {
  constructor({ port, agentId, name }) {
    this.port = port;
    this.agentId = agentId;
    this.name = name || agentId;
    this.ws = null;
    this.connected = false;
    this.boundTabId = null;
    this.tabs = [];
    this.pending = new Map(); // id -> {resolve, timer}
    this.claimWaiters = []; // resolvers awaiting a claim/needTab/error reply
    this.console = []; // forwarded browser console (from owned tab)
    this.broker = null; // set if THIS process spawned the broker
    this._seq = 0;
  }

  // Ensure a broker is reachable: try to BE the broker; if the port is busy, someone else is the
  // broker — just connect to it. Either way, connect as an agent.
  async start() {
    try {
      this.broker = new Broker({ port: this.port });
      await this.broker.start();
      console.error(`[agent] spawned broker on ${this.port}`);
    } catch (e) {
      if (e && e.code === 'EADDRINUSE') {
        console.error(`[agent] broker already running on ${this.port} — connecting as client`);
        this.broker = null;
      } else {
        console.error('[agent] broker start error:', e && e.message);
      }
    }
    this._connect();
  }

  _connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this._send({ t: 'register', role: 'agent', agentId: this.agentId, name: this.name });
    });
    ws.on('message', (raw) => this._onMessage(raw));
    ws.on('close', () => {
      this.connected = false;
      this.ws = null;
      setTimeout(() => this._connect(), 800); // reconnect (broker may restart)
    });
    ws.on('error', () => {
      /* close handler reconnects */
    });
  }

  _send(obj) {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }

  _onMessage(raw) {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.t === 'tabs') {
      this.tabs = m.tabs || [];
      // NOTE: do NOT clear boundTabId just because the tab is briefly absent from the list — a
      // reload/navigation drops the socket for a moment but the broker KEEPS our binding and will
      // send {t:'rebound'} when the tab reconnects. Clearing here is what made every reload/navigate
      // require a manual re-claim. We only drop the binding on an explicit {t:'released'}.
      return;
    }
    if (m.t === 'claimed') {
      this.boundTabId = m.tabId;
      this._resolveClaim({ ok: true, tabId: m.tabId });
      return;
    }
    if (m.t === 'rebound') {
      // Our tab reloaded/navigated and reconnected — the broker restored our binding.
      this.boundTabId = m.tabId;
      return;
    }
    if (m.t === 'needTab') {
      this._resolveClaim({ ok: false, needTab: true });
      return;
    }
    if (m.t === 'error') {
      this._resolveClaim({ ok: false, error: m.msg });
      return;
    }
    if (m.t === 'released') {
      if (m.tabId === this.boundTabId) this.boundTabId = null;
      return;
    }
    if (m.t === 'result' && this.pending.has(m.id)) {
      const { resolve, timer } = this.pending.get(m.id);
      clearTimeout(timer);
      this.pending.delete(m.id);
      resolve(m.ok ? { ok: true, value: m.value } : { ok: false, error: m.error });
      return;
    }
    if (m.t === 'event' && m.kind === 'console') {
      const p = m.payload || {};
      this.console.push({ ts: Date.now(), level: p.level, message: p.message, tabId: m.tabId });
      if (this.console.length > 500) this.console.shift();
      return;
    }
  }

  _resolveClaim(res) {
    const w = this.claimWaiters.shift();
    if (w) w(res);
  }

  // ---- public API used by tools --------------------------------------------

  agentInfo() {
    return { agentId: this.agentId, name: this.name, connected: this.connected, boundTabId: this.boundTabId, port: this.port };
  }

  listTabs() {
    this._send({ t: 'list' });
    return {
      count: this.tabs.length,
      boundTabId: this.boundTabId,
      tabs: this.tabs,
    };
  }

  // Claim a tab: a specific tabId, a free tab matching `match` (url/title substring), or the first
  // free one. Returns {ok, tabId} | {ok:false, needTab|error}.
  claim({ tabId = null, intent = '', match = null } = {}) {
    return new Promise((resolve) => {
      this.claimWaiters.push(resolve);
      this._send({ t: 'claim', tabId, intent, match });
      setTimeout(() => this._resolveClaim({ ok: false, error: 'claim timed out (is the broker up?)' }), 5000);
    });
  }

  release() {
    if (!this.boundTabId) return { ok: true, released: null };
    const tabId = this.boundTabId;
    this._send({ t: 'release', tabId });
    this.boundTabId = null;
    return { ok: true, released: tabId };
  }

  // Is our bound tab currently connected to the broker?
  _boundTabPresent() {
    return !!this.boundTabId && this.tabs.some((x) => x.tabId === this.boundTabId);
  }

  // Wait (up to ms) for our bound tab to (re)appear — covers the brief gap during a reload/navigate.
  async _awaitBoundTab(ms = 8000) {
    if (this._boundTabPresent()) return true;
    const start = Date.now();
    while (Date.now() - start < ms) {
      this._send({ t: 'list' }); // refresh tabs
      await new Promise((r) => setTimeout(r, 200));
      if (this._boundTabPresent()) return true;
    }
    return this._boundTabPresent();
  }

  // Send an op to the agent's BOUND tab and await the result. If the tab is momentarily gone
  // (mid reload/navigation), wait for it to reconnect rather than failing — so callers don't have
  // to re-claim after every navigate/reload.
  async dispatch(op, args = {}, { timeoutMs = 10000, message = null, intent = null } = {}) {
    if (!this.connected) return { ok: false, error: 'agent not connected to broker' };
    if (!this.boundTabId) {
      return { ok: false, error: 'No tab claimed. Call claim_tab first (it binds a free tab or opens a new one).' };
    }
    if (!this._boundTabPresent()) {
      const back = await this._awaitBoundTab(Math.min(timeoutMs, 8000));
      if (!back) return { ok: false, error: 'Bound tab is not connected (still loading?). Retry shortly or re-claim.' };
    }
    const send1 = () => this._once(op, args, { timeoutMs, message, intent });
    let res = await send1();
    // If the op timed out AND the tab (re)appeared meanwhile — likely a reload/navigation swallowed
    // the in-flight command — try ONCE more against the reconnected tab.
    if (!res.ok && /Timed out/.test(res.error || '') && (await this._awaitBoundTab(3000))) {
      res = await this._once(op, args, { timeoutMs, message, intent });
    }
    return res;
  }

  // One round-trip to the bound tab.
  _once(op, args, { timeoutMs, message, intent }) {
    const id = ++this._seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `Timed out after ${timeoutMs}ms waiting for bridge op "${op}".` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this._send({ t: 'cmd', id, tabId: this.boundTabId, op, args, message, intent });
    });
  }

  consoleMessages({ since } = {}) {
    const items = since ? this.console.slice(since) : this.console;
    return { count: items.length, total: this.console.length, messages: items };
  }

  status() {
    return {
      connected: this.connected,
      port: this.port,
      agentId: this.agentId,
      name: this.name,
      boundTabId: this.boundTabId,
      tabs: this.tabs,
    };
  }
}
