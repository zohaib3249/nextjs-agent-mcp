'use client';
// <AgentBridge/> — dev-only in-page bridge for nextjs-agent-mcp (Mode B), with a visible HUD.
//
// - Connects to the MCP's WebSocket and executes real-DOM-event commands.
// - Renders a floating HUD badge: connection status + a live feed of what the agent is doing.
// - Visually highlights the element each action targets (pulsing outline) so you can WATCH it.
//
// Keeps tests honest: fill uses React's native value setter + a real `input` event, so
// React onChange and MUI controlled inputs fire exactly as for a human.
//
// Drop into a Next.js root layout, dev-gated:
//   {process.env.NODE_ENV === 'development' && <AgentBridge />}
// Ships nothing to production. Port must match the MCP's --ws-port (default 7333).
import { useEffect, useState } from 'react';

const WS_PORT = Number(process.env.NEXT_PUBLIC_AGENT_BRIDGE_PORT) || 7333;

// Stable per-tab id: persisted in sessionStorage so it survives reloads of THIS tab but is unique
// per browser tab (sessionStorage is per-tab). Lets the agent target one tab among many.
function getTabId(): string {
  try {
    const k = '__agent_bridge_tab_id';
    let v = sessionStorage.getItem(k);
    if (!v) {
      v = 'tab-' + Math.random().toString(36).slice(2, 8) + '-' + (Date.now() % 100000);
      sessionStorage.setItem(k, v);
    }
    return v;
  } catch {
    return 'tab-' + Math.random().toString(36).slice(2, 8);
  }
}
const TAB_ID = typeof window !== 'undefined' ? getTabId() : 'tab-ssr';

// ---- Network recorder (module-level, installed once at import) -------------------------------
// Captures fetch + XHR (method, status, type, timing, and capped response bodies) plus
// browser-loaded resources (image/css/script/font) via PerformanceObserver (metadata only —
// the browser does not expose those bodies to page JS). Ring buffer, newest last.
type NetEntry = {
  id: number;
  ts: number;
  source: 'fetch' | 'xhr' | 'resource';
  type: string; // xhr | fetch | image | css | script | font | document | other
  method: string;
  url: string;
  status: number | null;
  ok: boolean | null;
  durationMs: number | null;
  size: number | null;
  body?: string; // capped response body for fetch/xhr only
  error?: string;
};

const NET: { seq: number; entries: NetEntry[]; max: number; bodyCap: number } = {
  seq: 0,
  entries: [],
  max: 500,
  bodyCap: 20000,
};

function netPush(e: Omit<NetEntry, 'id' | 'ts'>) {
  const entry: NetEntry = { id: ++NET.seq, ts: Date.now(), ...e };
  NET.entries.push(entry);
  if (NET.entries.length > NET.max) NET.entries.shift();
}

// Classify a resource entry by initiatorType / extension.
function resourceType(initiatorType: string, url: string): string {
  if (initiatorType === 'xmlhttprequest') return 'xhr';
  if (initiatorType === 'fetch') return 'fetch';
  if (initiatorType === 'img' || /\.(png|jpe?g|gif|webp|svg|avif|ico)(\?|$)/i.test(url)) return 'image';
  if (initiatorType === 'css' || initiatorType === 'link' || /\.css(\?|$)/i.test(url)) return 'css';
  if (initiatorType === 'script' || /\.m?js(\?|$)/i.test(url)) return 'script';
  if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url)) return 'font';
  if (initiatorType === 'navigation') return 'document';
  return 'other';
}

let netInstalled = false;
function installNetworkRecorder() {
  if (netInstalled || typeof window === 'undefined') return;
  netInstalled = true;

  // fetch
  const origFetch = window.fetch?.bind(window);
  if (origFetch) {
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const start = performance.now();
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = (init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
      try {
        const res = await origFetch(input as RequestInfo, init);
        let body: string | undefined;
        try {
          const ct = res.headers.get('content-type') || '';
          if (/json|text|xml|javascript|html/.test(ct)) {
            body = (await res.clone().text()).slice(0, NET.bodyCap);
          }
        } catch {
          /* body not readable */
        }
        netPush({
          source: 'fetch',
          type: 'fetch',
          method,
          url,
          status: res.status,
          ok: res.ok,
          durationMs: Math.round(performance.now() - start),
          size: body ? body.length : null,
          body,
        });
        return res;
      } catch (err) {
        netPush({
          source: 'fetch',
          type: 'fetch',
          method,
          url,
          status: null,
          ok: false,
          durationMs: Math.round(performance.now() - start),
          size: null,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };
  }

  // XHR
  const XP = XMLHttpRequest.prototype as unknown as {
    open: (m: string, u: string, ...r: unknown[]) => void;
    send: (b?: unknown) => void;
  };
  const origOpen = XP.open;
  const origSend = XP.send;
  XP.open = function (this: XMLHttpRequest & { __net?: { method: string; url: string; start: number } }, method: string, url: string, ...rest: unknown[]) {
    this.__net = { method: (method || 'GET').toUpperCase(), url, start: 0 };
    return origOpen.call(this, method, url, ...(rest as []));
  };
  XP.send = function (this: XMLHttpRequest & { __net?: { method: string; url: string; start: number } }, bodyArg?: unknown) {
    const meta = this.__net;
    if (meta) {
      meta.start = performance.now();
      this.addEventListener('loadend', () => {
        let body: string | undefined;
        try {
          if (this.responseType === '' || this.responseType === 'text') body = String(this.responseText).slice(0, NET.bodyCap);
        } catch {
          /* opaque */
        }
        netPush({
          source: 'xhr',
          type: 'xhr',
          method: meta.method,
          url: meta.url,
          status: this.status || null,
          ok: this.status >= 200 && this.status < 400,
          durationMs: Math.round(performance.now() - meta.start),
          size: body ? body.length : null,
          body,
        });
      });
    }
    return origSend.call(this, bodyArg as Document | XMLHttpRequestBodyInit | null | undefined);
  };

  // Browser-loaded resources (images/css/scripts/fonts) — metadata only.
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) {
        const type = resourceType(e.initiatorType, e.name);
        // fetch/xhr are already captured above with bodies; skip dupes here.
        if (type === 'fetch' || type === 'xhr') continue;
        netPush({
          source: 'resource',
          type,
          method: 'GET',
          url: e.name,
          status: null,
          ok: null,
          durationMs: Math.round(e.duration),
          size: e.transferSize || e.encodedBodySize || null,
        });
      }
    });
    po.observe({ type: 'resource', buffered: true });
  } catch {
    /* PerformanceObserver unavailable */
  }
}

// Install as early as the module loads on the client so we don't miss initial requests.
if (typeof window !== 'undefined') installNetworkRecorder();

type Command = { kind: 'command'; id: number; op: string; args: Record<string, unknown> };
type Status = 'connecting' | 'connected' | 'disconnected';
type FeedItem = { id: number; op: string; detail: string; state: 'running' | 'ok' | 'error'; ts: number };

export default function AgentBridge() {
  const [status, setStatus] = useState<Status>('connecting');
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let feedSeq = 0;

    const pushFeed = (op: string, detail: string): number => {
      const fid = ++feedSeq;
      const item: FeedItem = { id: fid, op, detail, state: 'running', ts: Date.now() };
      setFeed((f) => [item, ...f].slice(0, 8));
      return fid;
    };
    const settleFeed = (fid: number, state: 'ok' | 'error') =>
      setFeed((f) => f.map((it) => (it.id === fid ? { ...it, state } : it)));

    const connect = () => {
      if (closed) return;
      setStatus('connecting');
      try {
        ws = new WebSocket(`ws://localhost:${WS_PORT}`);
      } catch {
        retry = setTimeout(connect, 1500);
        return;
      }

      ws.onopen = () => {
        setStatus('connected');
        ws!.send(
          JSON.stringify({
            kind: 'hello',
            tabId: TAB_ID,
            url: location.href,
            pathname: location.pathname,
            title: document.title,
            userAgent: navigator.userAgent,
          })
        );
      };

      ws.onmessage = async (ev) => {
        let cmd: Command;
        try {
          cmd = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (cmd.kind !== 'command') return;
        const fid = pushFeed(cmd.op, describe(cmd));
        setBusy(true);
        try {
          highlight(cmd);
          const value = await run(cmd.op, cmd.args);
          settleFeed(fid, 'ok');
          send({ kind: 'result', id: cmd.id, ok: true, value });
        } catch (err: unknown) {
          settleFeed(fid, 'error');
          send({ kind: 'result', id: cmd.id, ok: false, error: errMsg(err) });
        } finally {
          setBusy(false);
        }
      };

      ws.onclose = () => {
        ws = null;
        setStatus('disconnected');
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws?.close();
    };

    const send = (obj: unknown) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    // Forward ALL browser console output (and uncaught errors) so the agent sees client-side activity.
    const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const orig: Partial<Record<(typeof levels)[number], (...a: unknown[]) => void>> = {};
    const fmt = (a: unknown[]) =>
      a
        .map((v) => {
          if (typeof v === 'string') return v;
          try {
            return JSON.stringify(v);
          } catch {
            return String(v);
          }
        })
        .join(' ')
        .slice(0, 2000);
    for (const lvl of levels) {
      orig[lvl] = console[lvl];
      console[lvl] = (...a: unknown[]) => {
        send({ kind: 'console', level: lvl, message: fmt(a) });
        orig[lvl]!.apply(console, a as []);
      };
    }
    const onError = (e: ErrorEvent) =>
      send({ kind: 'console', level: 'error', message: `Uncaught ${e.message} @ ${e.filename}:${e.lineno}` });
    const onRejection = (e: PromiseRejectionEvent) =>
      send({ kind: 'console', level: 'error', message: `Unhandled rejection: ${String(e.reason)}`.slice(0, 2000) });
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      for (const lvl of levels) if (orig[lvl]) console[lvl] = orig[lvl]!;
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      ws?.close();
    };
  }, []);

  return <Hud status={status} feed={feed} busy={busy} />;
}

// ---- HUD (visible overlay) -------------------------------------------------

function Hud({ status, feed, busy }: { status: Status; feed: FeedItem[]; busy: boolean }) {
  const color = status === 'connected' ? '#22c55e' : status === 'connecting' ? '#eab308' : '#ef4444';
  const label = status === 'connected' ? 'Agent connected' : status === 'connecting' ? 'Connecting…' : 'Agent offline';
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        zIndex: 2147483647,
        font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#e5e7eb',
        background: 'rgba(17,24,39,0.92)',
        border: `1px solid ${color}`,
        borderRadius: 10,
        padding: '8px 10px',
        width: 280,
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        backdropFilter: 'blur(6px)',
        pointerEvents: 'none',
        userSelect: 'none',
      }}
      data-agent-bridge-hud
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: feed.length ? 6 : 0 }}>
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: color,
            boxShadow: busy ? `0 0 0 0 ${color}` : 'none',
            animation: busy ? 'agentPulse 1s infinite' : 'none',
          }}
        />
        <strong style={{ color: '#fff', fontWeight: 600 }}>nextjs-agent</strong>
        <span style={{ marginLeft: 'auto', color }}>{label}</span>
      </div>
      <div style={{ color: '#6b7280', fontSize: 10, marginBottom: feed.length ? 6 : 0 }}>{TAB_ID}</div>
      {feed.map((it) => (
        <div key={it.id} style={{ display: 'flex', gap: 6, opacity: it.state === 'running' ? 1 : 0.7, marginTop: 3 }}>
          <span style={{ width: 12 }}>{it.state === 'running' ? '▸' : it.state === 'ok' ? '✓' : '✗'}</span>
          <span style={{ color: it.state === 'error' ? '#fca5a5' : '#93c5fd' }}>{it.op}</span>
          <span style={{ color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {it.detail}
          </span>
        </div>
      ))}
      <style>{`@keyframes agentPulse{0%{box-shadow:0 0 0 0 ${color}80}70%{box-shadow:0 0 0 6px ${color}00}100%{box-shadow:0 0 0 0 ${color}00}}
        @keyframes agentRing{0%{box-shadow:0 0 0 2px #38bdf8,0 0 0 6px #38bdf855}100%{box-shadow:0 0 0 2px #38bdf800,0 0 0 14px #38bdf800}}`}</style>
    </div>
  );
}

// Briefly outline the element an action targets, so the user can see WHERE the agent acted.
function highlight(cmd: Command) {
  const sel = cmd.args?.selector as string | undefined;
  if (!sel) return;
  const node = document.querySelector(sel) as HTMLElement | null;
  if (!node) return;
  const prev = node.style.animation;
  node.style.animation = 'agentRing 0.8s ease-out';
  setTimeout(() => {
    node.style.animation = prev;
  }, 800);
}

function describe(cmd: Command): string {
  const a = cmd.args || {};
  if (cmd.op === 'fill') return `${a.selector} = "${String(a.value).slice(0, 20)}"`;
  if (cmd.op === 'navigate') return String(a.url);
  if (cmd.op === 'wait_for') return (a.selector as string) || (a.text ? `text:"${a.text}"` : '');
  if (cmd.op === 'snapshot') return 'reading page…';
  if (cmd.op === 'page_context') return location.pathname;
  if (cmd.op === 'open_tab') return `open ${String(a.url)}`;
  if (cmd.op === 'reload') return a.hard ? 'hard reload' : 'reload';
  if (cmd.op === 'network_calls') return Array.isArray(a.types) ? (a.types as string[]).join(',') : 'all calls';
  if (cmd.op === 'storage') return `${a.area || 'local'} ${a.action || 'get'}${a.key ? ' ' + a.key : ''}`;
  if (cmd.op === 'cache') return `cache ${a.action || 'list'}`;
  if (cmd.op === 'eval') return String(a.code).slice(0, 28);
  if (cmd.op === 'screenshot') return 'capturing…';
  if (cmd.op === 'find') return `find "${String(a.query)}"`;
  if (cmd.op === 'overview') return 'page overview…';
  if (a.selector) return String(a.selector);
  return '';
}

// ---- op implementations (run in the page) ---------------------------------

async function run(op: string, args: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case 'click':
      return doClick(String(args.selector));
    case 'fill':
      return doFill(String(args.selector), String(args.value ?? ''));
    case 'snapshot':
      return doSnapshot();
    case 'page_context':
      return doPageContext();
    case 'components':
      return doComponents(args);
    case 'component_for':
      return doComponentFor(String(args.selector));
    case 'rerender':
      return doRerender(String(args.selector));
    case 'open_tab':
      return doOpenTab(String(args.url));
    case 'wait_for':
      return doWaitFor(args);
    case 'overview':
      return doOverview();
    case 'navigate': {
      const url = String(args.url);
      // SPA route changes keep the page alive (history API) — we can return the new overview after
      // a short settle. A cross-document load unloads the page, so the overview reflects the
      // CURRENT page; the agent should call `overview` again once the new page has loaded.
      const before = location.href;
      location.assign(url);
      // Give SPA navigations a brief moment to re-render, then snapshot the overview.
      await new Promise((r) => setTimeout(r, 350));
      const navigatedWithinDoc = location.href !== before && document.readyState === 'complete';
      return { navigated: url, sameDocument: navigatedWithinDoc, overview: doOverview() };
    }
    case 'reload':
      // location.reload() can't force-bypass cache portably; navigate to self with a buster for hard.
      if (args.hard) location.replace(location.href.split('#')[0]);
      else location.reload();
      return { reloaded: true, hard: !!args.hard };
    case 'network_calls':
      return doNetworkCalls(args);
    case 'storage':
      return doStorage(args);
    case 'cache':
      return doCache(args);
    case 'eval':
      return doEval(String(args.code));
    case 'screenshot':
      return doScreenshot(args);
    case 'find':
      return doFind(args);
    default:
      throw new Error(`Unknown op: ${op}`);
  }
}

// ---- find: search the page for fields/actions/components matching a query -------------------
// Searches across input labels, names, placeholders, current values; clickable action text;
// and rendered React component names. `in` narrows the scope: ["fields","actions","components"].
function doFind(args: Record<string, unknown>) {
  const qRaw = String(args.query || '').trim();
  if (!qRaw) throw new Error('find requires a non-empty `query`.');
  const q = qRaw.toLowerCase();
  const scopes: string[] = Array.isArray(args.in) ? (args.in as string[]) : ['fields', 'actions', 'components'];
  const has = (v: unknown) => typeof v === 'string' && v.toLowerCase().includes(q);

  const result: Record<string, unknown> = { query: qRaw };
  const snap = doSnapshot();

  if (scopes.includes('fields')) {
    result.fields = (snap.fields as Array<Record<string, unknown>>)
      .filter((f) => has(f.label) || has(f.name) || has(f.id) || has(f.placeholder) || has(f.value))
      .map((f) => ({
        label: f.label,
        name: f.name,
        id: f.id,
        type: f.type,
        value: f.value,
        placeholder: f.placeholder,
        selector: f.selector,
        formName: f.formName,
        matchedOn: ['label', 'name', 'id', 'placeholder', 'value'].filter((k) => has(f[k])),
      }));
  }

  if (scopes.includes('actions')) {
    result.actions = (snap.actions as Array<Record<string, unknown>>).filter((a) => has(a.text) || has(a.href));
  }

  if (scopes.includes('components')) {
    try {
      const comp = doComponents({}) as { tree?: Array<{ name: string; depth: number; hooks: unknown; key: unknown }> };
      const seen = new Set<string>();
      result.components = (comp.tree || [])
        .filter((c) => has(c.name))
        .filter((c) => {
          if (seen.has(c.name)) return false;
          seen.add(c.name);
          return true;
        })
        .slice(0, 50)
        .map((c) => ({ name: c.name, depth: c.depth, hooks: c.hooks }));
    } catch {
      result.components = [];
    }
  }

  const counts: Record<string, number> = {};
  for (const k of ['fields', 'actions', 'components']) if (Array.isArray(result[k])) counts[k] = (result[k] as unknown[]).length;
  result.counts = counts;
  return result;
}

// ---- network_calls: read the recorder's ring buffer, with filtering -------------------------
async function doNetworkCalls(args: Record<string, unknown>) {
  const since = typeof args.since === 'number' ? (args.since as number) : 0;
  const types = Array.isArray(args.types) ? (args.types as string[]) : null; // e.g. ["xhr","fetch"]
  const urlContains = typeof args.urlContains === 'string' ? (args.urlContains as string) : null;
  const includeBodies = args.includeBodies !== false; // default true
  const limit = typeof args.limit === 'number' ? (args.limit as number) : 100;

  let items = NET.entries.filter((e) => e.id > since);
  if (types) items = items.filter((e) => types.includes(e.type));
  if (urlContains) items = items.filter((e) => e.url.includes(urlContains));
  const total = items.length;
  items = items.slice(-limit);
  const out = items.map((e) => (includeBodies ? e : { ...e, body: e.body ? `[${e.body.length} chars omitted]` : undefined }));
  return {
    lastId: NET.seq,
    matched: total,
    returned: out.length,
    typesSeen: [...new Set(NET.entries.map((e) => e.type))],
    calls: out,
  };
}

// ---- storage: localStorage / sessionStorage / cookies --------------------------------------
function readCookies(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of document.cookie.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[decodeURIComponent(part.slice(0, i).trim())] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function dumpStore(s: Storage): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k != null) o[k] = s.getItem(k) ?? '';
  }
  return o;
}
function doStorage(args: Record<string, unknown>) {
  const area = String(args.area || 'local'); // local | session | cookie
  const action = String(args.action || 'get'); // get | set | delete | clear
  const key = args.key as string | undefined;
  const value = args.value as string | undefined;

  if (area === 'cookie') {
    if (action === 'get') return { area, cookies: readCookies() };
    if (action === 'set') {
      if (!key) throw new Error('storage set cookie requires key');
      document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(value ?? '')}; path=/`;
      return { area, set: key };
    }
    if (action === 'delete') {
      if (!key) throw new Error('storage delete cookie requires key');
      document.cookie = `${encodeURIComponent(key)}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
      return { area, deleted: key };
    }
    if (action === 'clear') {
      for (const k of Object.keys(readCookies()))
        document.cookie = `${encodeURIComponent(k)}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
      return { area, cleared: true };
    }
  }

  const store = area === 'session' ? sessionStorage : localStorage;
  if (action === 'get') return key != null ? { area, key, value: store.getItem(key) } : { area, items: dumpStore(store) };
  if (action === 'set') {
    if (!key) throw new Error('storage set requires key');
    store.setItem(key, value ?? '');
    return { area, set: key };
  }
  if (action === 'delete') {
    if (!key) throw new Error('storage delete requires key');
    store.removeItem(key);
    return { area, deleted: key };
  }
  if (action === 'clear') {
    store.clear();
    return { area, cleared: true };
  }
  throw new Error(`Unknown storage action: ${action}`);
}

// ---- cache: Cache Storage (Service Worker / PWA caches) -------------------------------------
async function doCache(args: Record<string, unknown>) {
  const action = String(args.action || 'list'); // list | clear
  if (typeof caches === 'undefined') return { supported: false, reason: 'Cache Storage API unavailable.' };
  const names = await caches.keys();
  if (action === 'clear') {
    const name = args.name as string | undefined;
    if (name) {
      const ok = await caches.delete(name);
      return { cleared: ok ? [name] : [], notFound: ok ? [] : [name] };
    }
    await Promise.all(names.map((n) => caches.delete(n)));
    return { cleared: names };
  }
  // list: names + entry counts
  const detail = await Promise.all(
    names.map(async (n) => {
      const c = await caches.open(n);
      const reqs = await c.keys();
      return { name: n, entries: reqs.length, urls: reqs.slice(0, 50).map((r) => r.url) };
    })
  );
  return { caches: detail };
}

// ---- eval: run arbitrary JS in the page (dev-only) ------------------------------------------
async function doEval(code: string) {
  // Wrapped so the snippet can `return` a value or be an expression. Awaits promises.
  // eslint-disable-next-line no-new-func
  const fn = new Function(`"use strict"; return (async () => { ${/\breturn\b/.test(code) ? code : 'return (' + code + ')'} })();`);
  let value: unknown;
  try {
    value = await fn();
  } catch (e) {
    throw new Error(`eval error: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Serialize safely (cap size, handle non-JSON).
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (serialized && serialized.length > 20000) serialized = serialized.slice(0, 20000) + '…[truncated]';
  return { type: typeof value, value: serialized === undefined ? null : JSON.parse(serialized ?? 'null') };
}

// ---- screenshot: in-page capture via html2canvas (lazy-loaded) ------------------------------
async function doScreenshot(args: Record<string, unknown>) {
  const selector = args.selector as string | undefined;
  const target = (selector ? document.querySelector(selector) : document.body) as HTMLElement | null;
  if (!target) throw new Error(`No element matches selector: ${selector}`);
  let html2canvas: ((el: HTMLElement, opts?: unknown) => Promise<HTMLCanvasElement>) | undefined;
  try {
    // Lazy import so it's only pulled when a screenshot is actually requested.
    const mod = await import(/* webpackIgnore: true */ 'https://esm.sh/html2canvas@1.4.1' as string);
    html2canvas = (mod as { default: typeof html2canvas }).default as never;
  } catch (e) {
    return {
      supported: false,
      reason: 'Could not load html2canvas (needs network access to esm.sh). In-page capture has no headless fallback.',
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const canvas = await html2canvas!(target, { logging: false, scale: Number(args.scale) || 1 });
  const dataUrl = canvas.toDataURL('image/png');
  return { format: 'png', width: canvas.width, height: canvas.height, dataUrl };
}

function el(selector: string): HTMLElement {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`No element matches selector: ${selector}`);
  return node as HTMLElement;
}

// Open a new browser tab from THIS tab. The new tab loads the app, mounts <AgentBridge/>, and
// auto-connects with its own tabId. Returns immediately; poll list_tabs for the new tab to appear.
// Same-origin URLs (or path-only, e.g. "/en/...") open reliably; popups must be allowed for localhost.
function doOpenTab(url: string) {
  const target = url.startsWith('http') ? url : location.origin + (url.startsWith('/') ? url : '/' + url);
  const w = window.open(target, '_blank');
  if (!w) {
    return {
      opened: false,
      url: target,
      error: 'window.open was blocked (popup blocker). Allow popups for this origin, or open the tab manually.',
    };
  }
  return { opened: true, url: target, note: 'New tab opening; call list_tabs to get its tabId once connected.' };
}

function doClick(selector: string) {
  const node = el(selector);
  node.scrollIntoView({ block: 'center' });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  return { clicked: selector };
}

function doFill(selector: string, value: string) {
  const node = el(selector) as HTMLInputElement | HTMLTextAreaElement;
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  node.focus();
  // The native setter bypasses React's value-shadowing so the 'input' event is treated as a real change.
  if (setter) setter.call(node, value);
  else node.value = value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
  return { filled: selector, value };
}

function cssPath(node: Element): string {
  if (node.id) return `#${CSS.escape(node.id)}`;
  const parts: string[] = [];
  let cur: Element | null = node;
  while (cur && cur.nodeType === 1 && parts.length < 5) {
    let part = cur.tagName.toLowerCase();
    const parent: HTMLElement | null = cur.parentElement;
    const self: Element = cur;
    if (parent) {
      const sibs = Array.from(parent.children).filter((c) => c.tagName === self.tagName);
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(self) + 1})`;
    }
    parts.unshift(part);
    if (cur.id) {
      parts[0] = `#${CSS.escape(cur.id)}`;
      break;
    }
    cur = parent;
  }
  return parts.join(' > ');
}

// Known locale prefixes — first path segment is treated as a locale if it matches.
const LOCALES = new Set(['en', 'fr', 'es', 'de', 'ar', 'zh', 'hi', 'pt', 'ru', 'ja']);

// "Where am I" — cheap route/page context without the full element dump.
function doPageContext() {
  const segs = location.pathname.split('/').filter(Boolean);
  const locale = segs[0] && LOCALES.has(segs[0]) ? segs[0] : null;
  const h1 = document.querySelector('h1, [role="heading"][aria-level="1"]') as HTMLElement | null;
  return {
    url: location.href,
    pathname: location.pathname,
    locale,
    title: document.title,
    heading: (h1?.textContent || '').trim().slice(0, 120) || null,
  };
}

// Resolve the human-facing label for a form control, in priority order:
//   <label for=id>  ->  aria-labelledby  ->  aria-label  ->  wrapping <label>  ->  placeholder  ->  name
function labelFor(e: HTMLElement): string | null {
  const id = e.getAttribute('id');
  if (id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (lbl?.textContent?.trim()) return lbl.textContent.trim();
  }
  const labelledby = e.getAttribute('aria-labelledby');
  if (labelledby) {
    const txt = labelledby
      .split(/\s+/)
      .map((lid) => document.getElementById(lid)?.textContent?.trim() || '')
      .filter(Boolean)
      .join(' ');
    if (txt) return txt;
  }
  const aria = e.getAttribute('aria-label');
  if (aria?.trim()) return aria.trim();
  const wrap = e.closest('label');
  if (wrap?.textContent?.trim()) return wrap.textContent.trim();
  const ph = (e as HTMLInputElement).placeholder;
  if (ph?.trim()) return ph.trim();
  const nm = e.getAttribute('name');
  return nm || null;
}

// Stable selector: #id -> [name="..."] -> structural cssPath.
function stableSelector(e: HTMLElement): string {
  if (e.id) return `#${CSS.escape(e.id)}`;
  const name = e.getAttribute('name');
  if (name) {
    const tag = e.tagName.toLowerCase();
    const sameName = document.querySelectorAll(`${tag}[name="${CSS.escape(name)}"]`);
    if (sameName.length === 1) return `${tag}[name="${CSS.escape(name)}"]`;
  }
  return cssPath(e);
}

const FIELD_SEL = 'input, textarea, select';

// Describe one form control as an agent-addressable field.
function describeField(e: HTMLElement, formName: string | null) {
  const tag = e.tagName.toLowerCase();
  const input = e as HTMLInputElement;
  const type = tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : input.type || 'text';
  const field: Record<string, unknown> = {
    label: labelFor(e),
    name: e.getAttribute('name') || null,
    id: e.getAttribute('id') || null,
    type,
    required: input.required || e.getAttribute('aria-required') === 'true',
    disabled: input.disabled || e.getAttribute('aria-disabled') === 'true',
    selector: stableSelector(e),
    formName,
  };
  if (type === 'checkbox' || type === 'radio') {
    field.value = input.value;
    field.checked = input.checked;
  } else {
    field.value = input.value ?? '';
  }
  if ((input.placeholder ?? '').trim()) field.placeholder = input.placeholder.trim();
  if (tag === 'select') {
    const sel = e as unknown as HTMLSelectElement;
    field.options = Array.from(sel.options).map((o) => ({ value: o.value, label: o.text.trim() }));
    field.value = sel.value;
  }
  return field;
}

// Flatten field objects into { identifier: currentValue }. Identifier preference: name -> id -> label.
// For checkbox/radio the value is the boolean `checked`; for select it's the selected value.
function valuesMap(fields: Array<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = (f.name as string) || (f.id as string) || (f.label as string);
    if (!key) continue;
    out[key] = f.type === 'checkbox' || f.type === 'radio' ? f.checked : f.value;
  }
  return out;
}

// Is this element a meaningful clickable action?
function describeAction(e: HTMLElement) {
  const tag = e.tagName.toLowerCase();
  const role = e.getAttribute('role') || (tag === 'a' ? 'link' : 'button');
  const text =
    (e.getAttribute('aria-label') || e.textContent || (e as HTMLInputElement).value || '').trim().slice(0, 80);
  const action: Record<string, unknown> = {
    text,
    role,
    selector: stableSelector(e),
    disabled: (e as HTMLButtonElement).disabled || e.getAttribute('aria-disabled') === 'true',
  };
  if (tag === 'a') action.href = (e as HTMLAnchorElement).getAttribute('href');
  const t = (e as HTMLButtonElement).type;
  if (t) action.type = t; // submit | button | reset
  return action;
}

// ---- React fiber introspection (Phase 3) ----------------------------------
// React 19: a DOM node carries its fiber under a `__reactFiber$<random>` property.
// `_debugSource` (file/line) was REMOVED in React 19, so we report component NAMES and
// hook *shape* (count, has-state, has-effect) — not source locations and not hook names
// (fiber hooks are anonymous; only React DevTools infers names via source maps).

function fiberOf(node: Element): any | null {
  for (const key in node) {
    if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
      return (node as any)[key];
    }
  }
  return null;
}

function componentName(fiber: any): string | null {
  const t = fiber?.type;
  if (!t) return null;
  if (typeof t === 'string') return null; // host element (div, input…)
  if (typeof t === 'function') return t.displayName || t.name || 'Anonymous';
  // memo/forwardRef/context wrappers
  if (t.displayName) return t.displayName;
  if (t.render) return t.render.displayName || t.render.name || 'ForwardRef';
  if (t.type) return componentName({ type: t.type });
  return 'Anonymous';
}

// Inspect a fiber's hook linked list (memoizedState) and summarize its shape.
function hookShape(fiber: any): { count: number; hasState: boolean; hasEffect: boolean } {
  let count = 0;
  let hasState = false;
  let hasEffect = false;
  // Only function components have a hook list shaped like { memoizedState, next, queue }.
  let hook = fiber?.memoizedState;
  // Guard: class components store instance state here, not a hook list.
  if (typeof fiber?.type !== 'function') return { count: 0, hasState: false, hasEffect: false };
  let guard = 0;
  while (hook && typeof hook === 'object' && 'next' in hook && guard < 200) {
    count++;
    if (hook.queue) hasState = true; // useState/useReducer have a dispatch queue
    if (hook.memoizedState && hook.memoizedState.tag !== undefined && hook.memoizedState.create) hasEffect = true; // effect
    hook = hook.next;
    guard++;
  }
  return { count, hasState, hasEffect };
}

// Walk DOWN the fiber tree from a root fiber, collecting component fibers (depth-limited).
function collectComponents(root: any, maxNodes = 600) {
  const out: Array<{ name: string; depth: number; hooks: ReturnType<typeof hookShape>; key: string | null }> = [];
  const stack: Array<{ fiber: any; depth: number }> = [{ fiber: root, depth: 0 }];
  let seen = 0;
  while (stack.length && seen < maxNodes) {
    const { fiber, depth } = stack.pop()!;
    seen++;
    const name = componentName(fiber);
    let childDepth = depth;
    if (name) {
      out.push({ name, depth, hooks: hookShape(fiber), key: fiber.key ?? null });
      childDepth = depth + 1;
    }
    if (fiber.sibling) stack.push({ fiber: fiber.sibling, depth });
    if (fiber.child) stack.push({ fiber: fiber.child, depth: childDepth });
  }
  return out;
}

// Find the React root fiber by reading the fiber off <body>'s first child or any mounted node.
function rootFiber(): any | null {
  const probe =
    document.querySelector('#__next, [data-reactroot], main, body > div') || document.body.firstElementChild;
  let f = probe ? fiberOf(probe) : null;
  if (!f) {
    // fall back: any element with a fiber
    const any = [...document.querySelectorAll('*')].slice(0, 50).map(fiberOf).find(Boolean);
    f = any || null;
  }
  while (f && f.return) f = f.return; // climb to the top
  return f;
}

// `components` op: the rendered React component tree (names + nesting + hook shape).
function doComponents(args: Record<string, unknown>) {
  // Scoped to a selector's subtree if provided, else the whole app.
  const sel = args.selector as string | undefined;
  let start: any | null = null;
  if (sel) {
    const node = document.querySelector(sel);
    if (!node) throw new Error(`No element matches selector: ${sel}`);
    start = fiberOf(node);
  } else {
    start = rootFiber();
  }
  if (!start) {
    return { supported: false, reason: 'No React fiber found (production build or pre-hydration).', components: [] };
  }
  const list = collectComponents(start);
  // Roll up duplicate component names with instance counts for a compact overview.
  const byName: Record<string, number> = {};
  for (const c of list) byName[c.name] = (byName[c.name] || 0) + 1;
  return {
    supported: true,
    note: 'React 19: source file/line and hook names are unavailable from fibers; hook shape is inferred.',
    total: list.length,
    unique: Object.keys(byName).length,
    summary: Object.entries(byName)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count })),
    tree: list.slice(0, 300),
  };
}

// `component_for` op: which component renders a given DOM element (nearest named ancestor + its chain).
function doComponentFor(selector: string) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`No element matches selector: ${selector}`);
  let f = fiberOf(node);
  if (!f) return { supported: false, reason: 'No React fiber on this element.', chain: [] };
  const chain: Array<{ name: string; hooks: ReturnType<typeof hookShape> }> = [];
  let guard = 0;
  while (f && guard < 80) {
    const name = componentName(f);
    if (name) chain.push({ name, hooks: hookShape(f) });
    f = f.return;
    guard++;
  }
  return { supported: true, selector, owner: chain[0]?.name || null, chain: chain.slice(0, 25) };
}

// `rerender` op: force the nearest component owning `selector` to re-render by toggling a state hook.
// We can't call its setState directly (anonymous hooks), so we dispatch a React-visible no-op:
// re-fire React's internal scheduling by touching the fiber's first state queue if present.
function doRerender(selector: string) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`No element matches selector: ${selector}`);
  let f = fiberOf(node);
  while (f && typeof f.type !== 'function') f = f.return; // nearest function component
  if (!f) return { ok: false, reason: 'No function component owns this element.' };
  const name = componentName(f);
  // Find a useState/useReducer dispatch on its hook list and dispatch the SAME value (forces a render pass).
  let hook = f.memoizedState;
  let guard = 0;
  while (hook && guard < 200) {
    if (hook.queue && typeof hook.queue.dispatch === 'function') {
      const cur = hook.memoizedState;
      hook.queue.dispatch(cur); // identical value — React still schedules a re-render of this fiber
      return { ok: true, component: name, via: 'state-dispatch' };
    }
    hook = hook.next;
    guard++;
  }
  return { ok: false, component: name, reason: 'Component has no state hook to nudge; cannot force rerender safely.' };
}

// Rich page model: route + forms (grouped) + every field (by name/label/type) + clickable actions.
// This is what lets the agent KNOW the page instead of guessing selectors.
function doSnapshot() {
  const inHud = (n: Element) => !!n.closest('[data-agent-bridge-hud]');

  // --- forms (grouped) ---
  const formEls = [...document.querySelectorAll('form')].filter((f) => !inHud(f));
  const seenInForm = new Set<Element>();
  const forms = formEls.map((f, i) => {
    const formName = f.getAttribute('name') || f.getAttribute('id') || f.getAttribute('aria-label') || `form#${i + 1}`;
    const ctrls = [...f.querySelectorAll(FIELD_SEL)].filter((n) => !inHud(n)) as HTMLElement[];
    ctrls.forEach((c) => seenInForm.add(c));
    const submitEl =
      (f.querySelector('button[type="submit"], input[type="submit"], [role="button"][type="submit"]') as HTMLElement) ||
      (f.querySelector('button:not([type])') as HTMLElement) ||
      null;
    const fieldObjs = ctrls.map((c) => describeField(c, formName));
    return {
      name: formName,
      selector: stableSelector(f),
      submit: submitEl ? describeAction(submitEl) : null,
      fields: fieldObjs,
      // Flat current-state map: { identifier: currentValue }. Identifier is name||id||label.
      values: valuesMap(fieldObjs),
    };
  });

  // --- all fields (incl. those outside any <form>) ---
  const allCtrls = [...document.querySelectorAll(FIELD_SEL)].filter((n) => !inHud(n)).slice(0, 400) as HTMLElement[];
  const fields = allCtrls.map((c) => {
    const owner = c.closest('form');
    const formName = owner
      ? owner.getAttribute('name') || owner.getAttribute('id') || owner.getAttribute('aria-label') || null
      : null;
    return describeField(c, formName);
  });

  // --- actions (clickables) ---
  const ACTION_SEL = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"]';
  const actionEls = ([...document.querySelectorAll(ACTION_SEL)].filter((n) => !inHud(n)) as HTMLElement[]).slice(0, 200);
  const actions = actionEls.map(describeAction).filter((a) => a.text || a.href);

  // Top-level flat values keyed by form name (loose fields under "_") — quick current-state view.
  const values: Record<string, Record<string, unknown>> = {};
  for (const f of forms) values[f.name] = f.values;
  const loose = fields.filter((f) => !f.formName);
  if (loose.length) values._ = valuesMap(loose);

  return {
    route: doPageContext(),
    counts: { fields: fields.length, forms: forms.length, actions: actions.length },
    forms,
    fields,
    actions,
    values,
  };
}

// ---- overview: structural landmark map of the page ----------------------------------------
// Header + nav + footer, sidebars + sections, tabs + heading outline, and any open dialogs/menus.
// Gives the agent a "lay of the land" without dumping every element (that's snapshot's job).
function inHudEl(n: Element) {
  return !!n.closest('[data-agent-bridge-hud]');
}
function visible(e: Element) {
  const el = e as HTMLElement;
  if (inHudEl(e)) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0 || el.offsetParent !== null;
}
// Links + buttons inside a region, as compact {text, href?, selector} items.
function regionItems(root: Element, cap = 40) {
  const els = [...root.querySelectorAll('a[href], button, [role="link"], [role="button"], [role="menuitem"], [role="tab"]')]
    .filter((n) => !inHudEl(n))
    .slice(0, cap) as HTMLElement[];
  return els
    .map((e) => {
      const text = (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 60);
      const item: Record<string, unknown> = { text, selector: stableSelector(e) };
      const href = (e as HTMLAnchorElement).getAttribute?.('href');
      if (href) item.href = href;
      return item;
    })
    .filter((i) => i.text || i.href);
}
function regionFor(sel: string, root: Element | null) {
  if (!root || !visible(root)) return null;
  return { selector: stableSelector(root as HTMLElement), items: regionItems(root) };
}

function doOverview() {
  // Header (banner)
  const headerEl = document.querySelector('header, [role="banner"]');
  const header = regionFor('header', headerEl);

  // Footer (contentinfo) — group its links
  const footerEl = document.querySelector('footer, [role="contentinfo"]');
  const footer = regionFor('footer', footerEl);

  // Primary navigations (<nav>, role=navigation)
  const navs = [...document.querySelectorAll('nav, [role="navigation"]')]
    .filter(visible)
    .slice(0, 6)
    .map((n) => ({
      label: (n.getAttribute('aria-label') || '').trim() || null,
      selector: stableSelector(n as HTMLElement),
      items: regionItems(n, 30),
    }));

  // Sidebars (complementary / aside / common sidebar hooks)
  const sidebarEls = [
    ...document.querySelectorAll('aside, [role="complementary"], [class*="sidebar" i], [data-sidebar], [class*="drawer" i]'),
  ]
    .filter(visible)
    .slice(0, 4);
  const sidebars = sidebarEls.map((s) => ({
    selector: stableSelector(s as HTMLElement),
    label: (s.getAttribute('aria-label') || '').trim() || null,
    items: regionItems(s, 40),
  }));

  // Sections / landmark regions, summarized by their heading
  const sections = [...document.querySelectorAll('section, [role="region"], main [aria-labelledby], main > div[class*="section" i]')]
    .filter(visible)
    .slice(0, 20)
    .map((s) => {
      const h = s.querySelector('h1, h2, h3, [role="heading"]');
      return {
        heading: (h?.textContent || s.getAttribute('aria-label') || '').trim().slice(0, 80) || null,
        selector: stableSelector(s as HTMLElement),
      };
    })
    .filter((s) => s.heading);

  // Tab lists
  const tabLists = [...document.querySelectorAll('[role="tablist"]')].filter(visible).slice(0, 6).map((tl) => {
    const tabs = [...tl.querySelectorAll('[role="tab"]')].filter((t) => !inHudEl(t)).map((t) => ({
      text: (t.textContent || '').trim().slice(0, 50),
      selected: t.getAttribute('aria-selected') === 'true',
      selector: stableSelector(t as HTMLElement),
    }));
    return { selector: stableSelector(tl as HTMLElement), activeTab: tabs.find((x) => x.selected)?.text || null, tabs };
  });

  // Heading outline (h1–h3)
  const headings = [...document.querySelectorAll('h1, h2, h3')]
    .filter(visible)
    .slice(0, 40)
    .map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent || '').trim().slice(0, 90) }))
    .filter((h) => h.text);

  // Open overlays right now (dialogs/menus/popovers) — these may block interaction
  const openOverlays = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], dialog[open], [aria-modal="true"]')]
    .filter(visible)
    .slice(0, 8)
    .map((o) => ({
      role: o.getAttribute('role') || o.tagName.toLowerCase(),
      label: (o.getAttribute('aria-label') || o.querySelector('h1,h2,h3,[role="heading"]')?.textContent || '').trim().slice(0, 80) || null,
      selector: stableSelector(o as HTMLElement),
    }));

  return {
    route: doPageContext(),
    header,
    nav: navs,
    sidebars,
    sections,
    tabs: tabLists,
    headings,
    footer,
    openOverlays,
    counts: {
      nav: navs.length,
      sidebars: sidebars.length,
      sections: sections.length,
      tabLists: tabLists.length,
      headings: headings.length,
      openOverlays: openOverlays.length,
    },
  };
}

async function doWaitFor(args: Record<string, unknown>) {
  const timeoutMs = Number(args.timeoutMs) || 5000;
  const selector = args.selector as string | undefined;
  const text = args.text as string | undefined;
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (selector && document.querySelector(selector)) return { matched: 'selector', selector };
    if (text && document.body.innerText.includes(text)) return { matched: 'text', text };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`wait_for timed out after ${timeoutMs}ms (${selector ? `selector=${selector}` : ''}${text ? ` text=${text}` : ''})`);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
