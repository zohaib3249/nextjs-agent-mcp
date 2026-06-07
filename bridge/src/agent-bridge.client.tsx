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
import { useEffect, useRef, useState } from 'react';

const WS_PORT = Number(process.env.NEXT_PUBLIC_AGENT_BRIDGE_PORT) || 7333;
// The MCP auto-advances its WS port if the base is busy; the bridge scans the same range so it
// still finds the server without manual reconfiguration.
const WS_PORT_RANGE = 11;

// Stable per-tab id that survives reloads of THIS tab but is unique per browser tab.
//
// IMPORTANT: sessionStorage is per-tab BUT a tab opened via "Duplicate tab" or a `target=_blank`
// link inherits a COPY of the opener's sessionStorage — so multiple tabs can start with the same
// id. To guarantee uniqueness we anchor the id to `window.name` (which is per-tab and is NOT
// duplicated the way sessionStorage is). We also generate a strong random suffix. The MCP server
// independently de-dupes on connect as a final guarantee (see wsServer assignUniqueTabId).
function rand(): string {
  try {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return a[0].toString(36) + a[1].toString(36);
  } catch {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
}
function getTabId(): string {
  try {
    // window.name persists across reloads of this exact tab and is not shared with other tabs.
    if (window.name && window.name.startsWith('agbid:')) return window.name.slice(6);
    const id = 'tab-' + rand().slice(0, 10);
    window.name = 'agbid:' + id;
    return id;
  } catch {
    return 'tab-' + rand().slice(0, 10);
  }
}
// Mutable: the MCP server may reassign a unique id on connect if it detects a duplicate.
let TAB_ID = typeof window !== 'undefined' ? getTabId() : 'tab-ssr';
function adoptTabId(id: string) {
  TAB_ID = id;
  try {
    window.name = 'agbid:' + id;
  } catch {
    /* ignore */
  }
}

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

type Command = { kind: 'command'; id: number; op: string; args: Record<string, unknown>; message?: string | null };
type Status = 'connecting' | 'connected' | 'disconnected';

// User-controllable HUD preferences, persisted per browser.
// `pos` is the panel's top-left corner; null = default (anchored bottom-right).
type Prefs = { fx: boolean; collapsed: boolean; speed: number; pos: { x: number; y: number } | null };
const PREFS_KEY = '__agent_bridge_prefs';
const DEFAULT_PREFS: Prefs = { fx: true, collapsed: false, speed: 1, pos: null };
function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return DEFAULT_PREFS;
  }
}
function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

// FX engine handle, set by the component so op implementations (run elsewhere) can drive visuals.
let FX: AgentFx | null = null;

export default function AgentBridge() {
  const [status, setStatus] = useState<Status>('connecting');
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [tabIdState, setTabIdState] = useState<string>(TAB_ID);
  // Start from deterministic defaults so SSR and the first client render match (no hydration
  // mismatch); load the real persisted prefs only after mount.
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setPrefs(loadPrefs());
    setMounted(true);
  }, []);

  const fxLayer = useRef<HTMLDivElement | null>(null);
  const pausedRef = useRef(paused);
  const prefsRef = useRef(prefs);
  const resumeWaiters = useRef<Array<() => void>>([]);
  pausedRef.current = paused;
  prefsRef.current = prefs;

  // Persist prefs (only after mount, so we don't overwrite stored prefs with defaults pre-load).
  useEffect(() => {
    if (mounted) savePrefs(prefs);
  }, [prefs, mounted]);
  useEffect(() => {
    if (!paused) {
      const w = resumeWaiters.current;
      resumeWaiters.current = [];
      w.forEach((r) => r());
    }
  }, [paused]);

  // Build the FX engine once we have the overlay node + prefs accessor.
  useEffect(() => {
    FX = new AgentFx(() => fxLayer.current, () => prefsRef.current);
    // Always show the persistent bottom status bar once the FX layer is mounted (after a tick so
    // the overlay div exists), provided FX is enabled.
    const t = setTimeout(() => {
      if (prefsRef.current.fx) FX?.showBar(status === 'connected' ? 'Agent connected — ready' : 'Waiting for the agent…');
    }, 50);
    return () => {
      clearTimeout(t);
      FX = null;
    };
  }, []);

  // Reflect connection state + FX toggle on the persistent bar.
  useEffect(() => {
    if (!FX) return;
    if (!prefs.fx) FX.hideBar();
    else FX.showBar(status === 'connected' ? 'Agent connected — ready' : status === 'connecting' ? 'Connecting…' : 'Agent offline');
  }, [status, prefs.fx]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    // Gate command execution while paused.
    const waitWhilePaused = () =>
      pausedRef.current ? new Promise<void>((r) => resumeWaiters.current.push(r)) : Promise.resolve();

    let portOffset = 0; // scans WS_PORT .. WS_PORT+RANGE-1, then wraps
    const connect = () => {
      if (closed) return;
      setStatus('connecting');
      const port = WS_PORT + (portOffset % WS_PORT_RANGE);
      let opened = false;
      try {
        ws = new WebSocket(`ws://localhost:${port}`);
      } catch {
        portOffset++;
        retry = setTimeout(connect, 400);
        return;
      }
      // If this port doesn't open quickly, advance to the next one in the range.
      const tryNext = setTimeout(() => {
        if (!opened) {
          portOffset++;
          try {
            ws?.close();
          } catch {
            /* ignore */
          }
        }
      }, 700);

      ws.onopen = () => {
        opened = true;
        clearTimeout(tryNext);
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
        // Show the persistent bottom status bar as soon as we connect.
        if (prefsRef.current.fx) FX?.showBar('Agent connected — ready');
      };

      ws.onmessage = async (ev) => {
        let cmd: Command;
        try {
          cmd = JSON.parse(ev.data);
        } catch {
          return;
        }
        // Server resolved a duplicate id → adopt the unique one it assigned.
        if ((cmd as { kind?: string }).kind === 'assignTabId') {
          const newId = (cmd as unknown as { tabId?: string }).tabId;
          if (newId) {
            adoptTabId(newId);
            setTabIdState(newId);
          }
          return;
        }
        if (cmd.kind !== 'command') return;

        // The agent's narration for this call: explicit `message`, else the think arg, else a label.
        const narration = String(cmd.message ?? cmd.args?.message ?? '').slice(0, 300);

        // `think` / `status` are narration-only ops: type into the bar, run nothing in the page.
        // `kind`: 'thinking' (💭 internal reasoning) | 'code' (⌘ checking code) | 'action' (✦).
        if (cmd.op === 'think' || cmd.op === 'status') {
          const msg = narration;
          const kind = (cmd.args?.kind as string) || (cmd.op === 'think' ? 'thinking' : 'action');
          const dwellMs = typeof cmd.args?.dwellMs === 'number' ? (cmd.args.dwellMs as number) : undefined;
          setThinking(msg);
          if (prefsRef.current.fx) FX?.say(msg, dwellMs, kind);
          send({ kind: 'result', id: cmd.id, ok: true, value: { acknowledged: true } });
          return;
        }

        // Honor a pause: hold the command until the user resumes.
        if (pausedRef.current) {
          await waitWhilePaused();
        }

        setThinking(narration || actionLabel(cmd));
        setBusy(true);
        try {
          let value: unknown;
          if (prefsRef.current.fx) {
            // Type the agent's narration (or a friendly phrase) in the unified toast, then act.
            FX?.say(narration || actionLabel(cmd));
            // fill_form: walk each field like a person — cursor travels, spotlight, fast typewriter.
            if (cmd.op === 'fill_form' && FX) {
              value = await FX.fillForm(
                (cmd.args.fields as Array<{ selector: string; value: string }>) || [],
                narration
              );
            } else {
              await FX?.before(cmd);
              if (cmd.op === 'fill' && FX) {
                value = await FX.typeFill(String(cmd.args.selector), String(cmd.args.value ?? ''));
              } else {
                value = await run(cmd.op, cmd.args);
              }
            }
          } else {
            // FX off: fill_form still fills every field, just without animation.
            if (cmd.op === 'fill_form') {
              value = await run('fill_form', cmd.args);
            } else {
              value = await run(cmd.op, cmd.args);
            }
          }
          if (prefsRef.current.fx) FX?.after(cmd);
          send({ kind: 'result', id: cmd.id, ok: true, value });
        } catch (err: unknown) {
          if (prefsRef.current.fx) FX?.fail(cmd);
          send({ kind: 'result', id: cmd.id, ok: false, error: errMsg(err) });
        } finally {
          setBusy(false);
        }
      };

      ws.onclose = () => {
        clearTimeout(tryNext);
        ws = null;
        setStatus('disconnected');
        // If we never connected, advance through the range quickly; once we had a connection,
        // back off a bit before rescanning from the same offset.
        const delay = opened ? 1200 : 250;
        if (!closed) retry = setTimeout(connect, delay);
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

  // Render nothing on the server / first hydration pass — the HUD depends on browser-only state
  // (sessionStorage tab id, localStorage prefs), so SSR output would never match the client.
  if (!mounted) return null;

  return (
    <>
      {/* Full-screen, non-interactive FX layer (cursor, spotlight, tooltip, ripples, toasts). */}
      <div
        ref={fxLayer}
        data-agent-bridge-hud
        style={{ position: 'fixed', inset: 0, zIndex: 2147483646, pointerEvents: 'none', overflow: 'hidden' }}
      />
      <Hud
        status={status}
        busy={busy}
        thinking={thinking}
        paused={paused}
        tabId={tabIdState}
        prefs={prefs}
        onTogglePause={() => setPaused((p) => !p)}
        onToggleFx={() => setPrefs((p) => ({ ...p, fx: !p.fx }))}
        onToggleCollapsed={() => setPrefs((p) => ({ ...p, collapsed: !p.collapsed }))}
        onSpeed={(v) => setPrefs((p) => ({ ...p, speed: v }))}
        onMove={(pos) => setPrefs((p) => ({ ...p, pos }))}
      />
    </>
  );
}

// ---- Fancy FX engine -------------------------------------------------------
// Drives the visible "controlled agent" effects on the page: a traveling cursor, click ripple,
// element spotlight with a labeled tooltip, typewriter fill caret, and thinking toasts.
// All effects are gated by the user's `fx` pref and paced by `speed`.
class AgentFx {
  private getLayer: () => HTMLDivElement | null;
  private getPrefs: () => Prefs;
  private cursor: HTMLDivElement | null = null;
  private spot: HTMLDivElement | null = null;
  private tip: HTMLDivElement | null = null;
  private cx = -100;
  private cy = -100;
  // Persistent "speech" toast that types out the agent's narration (Claude-Code style).
  private sayBox: HTMLDivElement | null = null;
  private sayText: HTMLSpanElement | null = null;
  private sayDot: HTMLSpanElement | null = null;
  private sayToken = 0; // cancels an in-flight typing animation when a newer one starts
  private sayHideTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleIdx = 0;
  private static IDLE_PHRASES = [
    'Thinking…',
    'Planning the next step…',
    'Looking around the page…',
    'Waiting for the agent…',
    'Working on it…',
    'Reading the layout…',
    'Reasoning about what to do next…',
    'Scanning for the right element…',
    'Checking the page state…',
    'Considering the options…',
    'Mapping out the form…',
    'Reviewing the DOM…',
    'Inspecting the components…',
    'Figuring out the next action…',
    'Gathering context…',
    'Analyzing the structure…',
    'Locating the controls…',
    'Double-checking the selectors…',
    'Tracing the data flow…',
    'Looking for the submit button…',
    'Parsing the response…',
    'Verifying the result…',
    'Waiting for the page to settle…',
    'Hold on, almost there…',
    'Lining things up…',
    'Cross-referencing the routes…',
    'Reading the network activity…',
    'Checking for errors…',
    'Making sure everything loaded…',
    'Deciding where to click…',
    'Composing the next move…',
    'Sizing up the page…',
    'Looking for the right field…',
    'Re-reading the requirements…',
    'Connecting the dots…',
    'Evaluating the state…',
    'Preparing the next step…',
    'Sketching a plan…',
    'Picking the best approach…',
    'Confirming the route…',
    'Sweeping the interface…',
    'Reading labels and inputs…',
    'Watching for changes…',
    'Letting the UI catch up…',
    'Tidying up the plan…',
    'Queuing the next action…',
    'Checking the form values…',
    'Looking at what changed…',
    'Re-orienting on the page…',
    'Thinking it through…',
    'Almost ready…',
    'Just a moment…',
    'Processing…',
  ];
  private static MIN_DWELL_MS = 10000; // a message stays at least this long before idle phrases

  constructor(getLayer: () => HTMLDivElement | null, getPrefs: () => Prefs) {
    this.getLayer = getLayer;
    this.getPrefs = getPrefs;
  }

  private speed() {
    return this.getPrefs().speed || 1;
  }
  // Pace by speed, but floor so a high speed setting can never make effects invisible.
  private ms(base: number) {
    return Math.max(220, base / this.speed());
  }

  private ensureCursor() {
    const layer = this.getLayer();
    if (!layer) return null;
    if (!this.cursor) {
      const c = document.createElement('div');
      // Big glowing pointer + a pulsing halo ring so the travel is unmistakable.
      c.style.cssText =
        'position:absolute;width:30px;height:30px;left:0;top:0;transform:translate(-200px,-200px);' +
        'transition:transform .55s cubic-bezier(.22,1,.36,1);z-index:6;will-change:transform;' +
        "background:no-repeat center/contain url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M3 2l7 18 2.5-7.5L20 10z' fill='%2338bdf8' stroke='white' stroke-width='1.5' stroke-linejoin='round'/></svg>\");" +
        'filter:drop-shadow(0 0 8px rgba(56,189,248,.95)) drop-shadow(0 2px 4px rgba(0,0,0,.5));';
      const halo = document.createElement('div');
      halo.style.cssText =
        'position:absolute;left:-9px;top:-9px;width:30px;height:30px;border-radius:50%;' +
        'background:radial-gradient(circle,rgba(56,189,248,.45),rgba(56,189,248,0) 70%);' +
        'animation:agentCursorPulse 1.4s ease-out infinite;';
      c.appendChild(halo);
      layer.appendChild(c);
      this.cursor = c;
    }
    return this.cursor;
  }

  private rectOf(sel?: string): DOMRect | null {
    if (!sel) return null;
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return el.getBoundingClientRect();
  }

  // Glide the cursor to a point and resolve when it arrives.
  private moveTo(x: number, y: number): Promise<void> {
    const c = this.ensureCursor();
    if (!c) return Promise.resolve();
    this.cx = x;
    this.cy = y;
    c.style.transitionDuration = `${this.ms(500)}ms`;
    c.style.transform = `translate(${x}px, ${y}px)`;
    return new Promise((r) => setTimeout(r, this.ms(520)));
  }

  // Spotlight + labeled tooltip around a rect.
  private spotlight(rect: DOMRect, label: string) {
    const layer = this.getLayer();
    if (!layer) return;
    if (!this.spot) {
      this.spot = document.createElement('div');
      // Strong cyan ring + a heavy page-dim + glow, with a pulse so it's impossible to miss.
      this.spot.style.cssText =
        'position:absolute;border-radius:10px;z-index:3;pointer-events:none;' +
        'box-shadow:0 0 0 3px #38bdf8, 0 0 0 100000px rgba(2,6,23,.6), 0 0 30px 6px rgba(56,189,248,.85);' +
        'transition:all .4s cubic-bezier(.22,1,.36,1);animation:agentSpotPulse 1.1s ease-in-out infinite;';
      layer.appendChild(this.spot);
    }
    const pad = 6;
    this.spot.style.left = `${rect.left - pad}px`;
    this.spot.style.top = `${rect.top - pad}px`;
    this.spot.style.width = `${rect.width + pad * 2}px`;
    this.spot.style.height = `${rect.height + pad * 2}px`;
    this.spot.style.opacity = '1';

    if (!this.tip) {
      this.tip = document.createElement('div');
      this.tip.style.cssText =
        'position:absolute;z-index:5;pointer-events:none;max-width:300px;padding:6px 11px;border-radius:8px;' +
        'font:700 13px/1.3 ui-sans-serif,system-ui,sans-serif;color:#fff;background:#0ea5e9;' +
        'box-shadow:0 8px 22px rgba(0,0,0,.45);transition:all .3s ease;white-space:nowrap;' +
        'overflow:hidden;text-overflow:ellipsis;';
      layer.appendChild(this.tip);
    }
    this.tip.style.background = '#0ea5e9';
    this.tip.textContent = label;
    const top = rect.top - 36 < 8 ? rect.bottom + 10 : rect.top - 36;
    this.tip.style.left = `${Math.max(8, rect.left)}px`;
    this.tip.style.top = `${top}px`;
    this.tip.style.opacity = '1';
  }

  private clearSpotlight() {
    if (this.spot) this.spot.style.opacity = '0';
    if (this.tip) this.tip.style.opacity = '0';
  }

  // Click ripple at the current cursor position.
  private ripple() {
    const layer = this.getLayer();
    if (!layer) return;
    const r = document.createElement('div');
    r.style.cssText =
      `position:absolute;left:${this.cx}px;top:${this.cy}px;width:8px;height:8px;border-radius:50%;` +
      'background:rgba(56,189,248,.55);z-index:3;transform:translate(-50%,-50%);' +
      `animation:agentRipple ${this.ms(550)}ms ease-out forwards;`;
    layer.appendChild(r);
    setTimeout(() => r.remove(), this.ms(600));
  }

  // A floating toast at top-center (like a navigation toast). Used for thinking + notices.
  // Both kinds use the dark/black style the user prefers; thinking gets a 💭 and an accent bar.
  toast(text: string, kind: 'think' | 'info' = 'info') {
    const layer = this.getLayer();
    if (!layer || !text) return;
    const t = document.createElement('div');
    t.style.cssText =
      'position:absolute;left:50%;top:18px;transform:translateX(-50%) translateY(-12px);z-index:7;' +
      'display:flex;align-items:center;gap:9px;max-width:min(640px,90vw);padding:11px 16px;border-radius:12px;' +
      'color:#f1f5f9;font:600 14px/1.4 ui-sans-serif,system-ui,sans-serif;background:rgba(15,23,42,.97);' +
      'border:1px solid ' + (kind === 'think' ? '#8b5cf6' : '#334155') + ';' +
      'box-shadow:0 14px 40px rgba(0,0,0,.55);opacity:0;transition:all .4s cubic-bezier(.22,1,.36,1);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    if (kind === 'think') {
      const dot = document.createElement('span');
      dot.style.cssText = 'flex:0 0 auto;font-size:16px;';
      dot.textContent = '💭';
      t.appendChild(dot);
    }
    const span = document.createElement('span');
    span.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
    span.textContent = text;
    t.appendChild(span);
    layer.appendChild(t);
    requestAnimationFrame(() => {
      t.style.opacity = '1';
      t.style.transform = 'translateX(-50%) translateY(0)';
    });
    const life = kind === 'think' ? this.ms(4200) : this.ms(2800);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transform = 'translateX(-50%) translateY(-12px)';
      setTimeout(() => t.remove(), 420);
    }, life);
  }

  // A persistent status bar fixed to the BOTTOM-CENTER of the screen (not page-anchored). Created
  // once and kept visible from connection onward; say() retypes its text.
  private ensureSayBox() {
    const layer = this.getLayer();
    if (!layer) return null;
    if (!this.sayBox) {
      const box = document.createElement('div');
      box.style.cssText =
        'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483646;' +
        'display:flex;align-items:center;gap:10px;max-width:min(760px,94vw);min-width:240px;padding:12px 18px;border-radius:14px;' +
        'color:#f1f5f9;font:600 14px/1.4 ui-sans-serif,system-ui,sans-serif;background:rgba(12,18,32,.97);' +
        'border:1px solid #334155;box-shadow:0 18px 50px rgba(0,0,0,.6);opacity:0;' +
        'transition:opacity .3s ease;white-space:nowrap;pointer-events:none;';
      const dot = document.createElement('span');
      dot.textContent = '✦';
      dot.style.cssText = 'flex:0 0 auto;color:#a78bfa;font-size:16px;animation:agentThink 1.6s ease-in-out infinite;';
      const txt = document.createElement('span');
      txt.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
      const caret = document.createElement('span');
      caret.textContent = '▌';
      caret.style.cssText = 'color:#a78bfa;animation:agentCaret 1s step-end infinite;margin-left:1px;flex:0 0 auto;';
      box.appendChild(dot);
      box.appendChild(txt);
      box.appendChild(caret);
      layer.appendChild(box);
      this.sayBox = box;
      this.sayText = txt;
      this.sayDot = dot;
    }
    return this.sayBox;
  }

  // Show the status bar (call on connect) with idle text. Stays visible.
  showBar(idle = 'Agent connected — ready') {
    const box = this.ensureSayBox();
    if (!box || !this.sayText) return;
    box.style.opacity = '1';
    if (!this.sayText.textContent) this.sayText.textContent = idle;
  }
  hideBar() {
    if (this.sayBox) this.sayBox.style.opacity = '0';
  }

  private clearTimers() {
    if (this.sayHideTimer) clearTimeout(this.sayHideTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.sayHideTimer = null;
    this.idleTimer = null;
  }

  // After a message has been shown for its dwell time with nothing new, cycle gentle idle phrases
  // (Thinking… / Planning… / Waiting…) so the bar is alive but never overwrites a fresh message.
  private startIdleCycle(token: number, dwellMs: number) {
    this.idleTimer = setTimeout(() => {
      if (token !== this.sayToken || !this.sayText) return;
      // Pick a random phrase that isn't the one we just showed.
      const n = AgentFx.IDLE_PHRASES.length;
      let next = Math.floor(Math.random() * n);
      if (next === this.idleIdx) next = (next + 1) % n;
      this.idleIdx = next;
      const phrase = AgentFx.IDLE_PHRASES[next];
      // type the idle phrase, then rotate again after a short pause (~4s)
      void this._type(phrase, token).then(() => {
        if (token === this.sayToken) this.startIdleCycle(token, 4000);
      });
    }, dwellMs);
  }

  // Low-level typer shared by say() and the idle cycle. Fast: ~12ms/char (NOT floored by ms()),
  // and types 2 chars per tick so even long lines finish quickly.
  private async _type(msg: string, token: number) {
    if (!this.sayText) return;
    this.sayText.textContent = '';
    const per = Math.max(6, Math.round(12 / (this.getPrefs().speed || 1)));
    const step = msg.length > 60 ? 3 : 2; // bigger chunks for long messages
    for (let i = step; i < msg.length + step; i += step) {
      if (token !== this.sayToken) return;
      this.sayText.textContent = msg.slice(0, Math.min(i, msg.length));
      if (i < msg.length) await new Promise((r) => setTimeout(r, per));
    }
  }

  // Retype the status bar's text. The bar STAYS visible. A message is held for at least
  // MIN_DWELL_MS (~10s); if nothing new arrives, idle phrases start cycling. `dwellMs` overrides.
  // `kind` swaps the leading icon: action ✦ | thinking 💭 | code ⌘ (checking code) | net ⇅.
  async say(text: string, dwellMs?: number, kind: string = 'action') {
    const box = this.ensureSayBox();
    if (!box || !this.sayText) return;
    box.style.opacity = '1';
    if (this.sayDot) {
      const icon = kind === 'thinking' ? '💭' : kind === 'code' ? '⌘' : kind === 'net' ? '⇅' : '✦';
      this.sayDot.textContent = icon;
      this.sayDot.style.color = kind === 'code' ? '#34d399' : kind === 'net' ? '#fbbf24' : '#a78bfa';
    }
    const msg = (text || '').trim() || 'Working…';
    const token = ++this.sayToken;
    this.clearTimers();
    await this._type(msg, token);
    if (token !== this.sayToken) return;
    // Hold this message at least the dwell time before idle phrases take over.
    this.startIdleCycle(token, Math.max(1000, dwellMs ?? AgentFx.MIN_DWELL_MS));
  }

  // Before an action runs: travel the cursor to the target, THEN spotlight it (so the motion reads).
  async before(cmd: Command) {
    const sel = cmd.args?.selector as string | undefined;
    const rect = this.rectOf(sel);
    if (rect) {
      // 1) show the cursor where it currently is, 2) glide it to the target (visible travel),
      // 3) light up the spotlight + tooltip on arrival.
      this.ensureCursor();
      await this.moveTo(rect.left + rect.width / 2, rect.top + rect.height / 2);
      this.spotlight(rect, actionLabel(cmd));
      if (cmd.op === 'click') this.ripple();
      // Hold a beat so the human registers the spotlight before the action fires.
      await new Promise((r) => setTimeout(r, this.ms(300)));
    }
    // For selector-less ops (navigate/reload/snapshot/etc) the narration toast (say) already shows.
  }

  after(_cmd: Command) {
    // Let the spotlight linger so it's clearly visible, then fade.
    setTimeout(() => this.clearSpotlight(), this.ms(1400));
  }

  fail(cmd: Command) {
    if (this.tip) {
      this.tip.style.background = '#ef4444';
      this.tip.textContent = `failed: ${actionLabel(cmd)}`;
    }
    setTimeout(() => this.clearSpotlight(), this.ms(1100));
  }

  // Typewriter fill: set the input value one character at a time (each a real React-visible change),
  // updating the spotlight label as it goes. Falls back to instant if the element vanishes.
  async typeFill(selector: string, value: string): Promise<unknown> {
    const node = document.querySelector(selector) as HTMLElement | null;
    if (!node) throw new Error(`No element matches selector: ${selector}`);
    const tag = node.tagName.toLowerCase();
    const type = tag === 'input' ? ((node as HTMLInputElement).type || 'text').toLowerCase() : tag;
    const isTextLike =
      (tag === 'input' && !['checkbox', 'radio', 'date', 'datetime-local', 'time', 'month', 'week', 'file', 'range', 'color'].includes(type)) ||
      tag === 'textarea' ||
      (node as HTMLElement).isContentEditable;

    // Non-text controls (select, checkbox, radio, date…): no char animation — set + brief label.
    if (!isTextLike) {
      const detail = setControlValue(node, value);
      if (this.tip) this.tip.textContent = detail;
      return { filled: selector, value, detail };
    }

    // Text-like: animate the typewriter (contenteditable uses textContent, others use value setter).
    node.focus();
    const editable = (node as HTMLElement).isContentEditable;
    const setVal = (v: string) => {
      if (editable) {
        (node as HTMLElement).textContent = v;
        node.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        nativeSet(node, 'value', v);
        node.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    // Pace: ~22ms/char (NOT floored by ms()), scaled by speed, so typing is snappy.
    const per = Math.max(8, Math.round(22 / (this.getPrefs().speed || 1)));
    const max = Math.min(value.length, 60);
    for (let i = 1; i <= value.length; i++) {
      setVal(value.slice(0, i));
      if (this.tip) this.tip.textContent = `Typing "${value.slice(0, Math.min(i, 24))}${i > 24 ? '…' : ''}"`;
      if (i <= max) await new Promise((r) => setTimeout(r, per));
    }
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: selector, value };
  }

  // fill_form: fill an array of {selector,value} one-by-one, animating each like a person —
  // cursor glides to the field, spotlight, fast typewriter — in a single round-trip.
  async fillForm(fields: Array<{ selector: string; value: string }>, narration?: string) {
    const results: Array<{ selector: string; ok: boolean; value?: string; error?: string }> = [];
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!f || !f.selector) {
        results.push({ selector: String(f?.selector), ok: false, error: 'missing selector' });
        continue;
      }
      // Narrate progress on the bar (unless the agent gave its own message).
      const hint = fieldHint(f.selector);
      this.say(narration || `Filling ${hint || 'field ' + (i + 1)} (${i + 1}/${fields.length})`, undefined, 'action');
      const node = document.querySelector(f.selector) as HTMLElement | null;
      if (!node) {
        results.push({ selector: f.selector, ok: false, error: 'no element matches selector' });
        continue;
      }
      const rect = (node.scrollIntoView({ block: 'center', behavior: 'smooth' }), node.getBoundingClientRect());
      this.ensureCursor();
      await this.moveTo(rect.left + rect.width / 2, rect.top + rect.height / 2);
      this.spotlight(rect, `Typing "${String(f.value).slice(0, 24)}"`);
      try {
        await this.typeFill(f.selector, String(f.value ?? ''));
        results.push({ selector: f.selector, ok: true, value: String(f.value ?? '') });
      } catch (e) {
        results.push({ selector: f.selector, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      // Brief pause between fields so the motion reads as deliberate.
      await new Promise((r) => setTimeout(r, this.ms(180)));
    }
    setTimeout(() => this.clearSpotlight(), this.ms(800));
    const filled = results.filter((r) => r.ok).length;
    return { filledForm: true, total: fields.length, filled, results };
  }
}

// Human-readable label for the spotlight tooltip.
function actionLabel(cmd: Command): string {
  const a = cmd.args || {};
  switch (cmd.op) {
    case 'click':
      return `Clicking ${fieldHint(a.selector) || shortSel(a.selector)}`;
    case 'fill':
      return `Typing "${String(a.value).slice(0, 24)}"${fieldHint(a.selector) ? ' in ' + fieldHint(a.selector) : ''}`;
    case 'fill_form':
      return `Filling the form (${Array.isArray(a.fields) ? (a.fields as unknown[]).length : 0} fields)`;
    case 'navigate':
      return `Going to ${String(a.url)}`;
    case 'reload':
      return a.hard ? 'Hard-reloading the page' : 'Reloading the page';
    case 'snapshot':
      return 'Reading the page';
    case 'page_context':
      return 'Checking where I am';
    case 'overview':
      return 'Scanning the page layout';
    case 'find':
      return `Searching for "${String(a.query).slice(0, 30)}"`;
    case 'components':
      return 'Inspecting the React components';
    case 'component_for':
      return 'Finding the component for this element';
    case 'rerender':
      return 'Forcing a re-render';
    case 'wait_for':
      return a.text ? `Waiting for "${String(a.text).slice(0, 30)}" to appear` : 'Waiting for the page to update';
    case 'network_calls':
      return 'Checking network requests';
    case 'storage':
      return `Reading ${String(a.area || 'local')} storage`;
    case 'cache':
      return 'Inspecting the cache';
    case 'eval':
      return 'Running a quick check in the page';
    case 'screenshot':
      return 'Taking a screenshot';
    case 'open_tab':
      return `Opening a new tab (${String(a.url)})`;
    default:
      return 'Working…';
  }
}

// Best-effort human name for a target element (label/placeholder/name/text) for nicer narration.
function fieldHint(sel: unknown): string {
  try {
    const el = sel ? (document.querySelector(String(sel)) as HTMLElement | null) : null;
    if (!el) return '';
    const name =
      labelFor(el) ||
      (el as HTMLInputElement).placeholder ||
      el.getAttribute('name') ||
      (el.textContent || '').trim();
    return name ? `"${name.slice(0, 28)}"` : '';
  } catch {
    return '';
  }
}
function shortSel(sel: unknown): string {
  const s = String(sel ?? '');
  return s.length > 28 ? s.slice(0, 28) + '…' : s;
}

// ---- HUD (visible control panel) -------------------------------------------

function Hud(props: {
  status: Status;
  busy: boolean;
  thinking: string | null;
  paused: boolean;
  tabId: string;
  prefs: Prefs;
  onTogglePause: () => void;
  onToggleFx: () => void;
  onToggleCollapsed: () => void;
  onSpeed: (v: number) => void;
  onMove: (pos: { x: number; y: number } | null) => void;
}) {
  const { status, busy, thinking, paused, prefs } = props;
  const color = status === 'connected' ? '#22c55e' : status === 'connecting' ? '#eab308' : '#ef4444';
  const label = status === 'connected' ? 'Agent connected' : status === 'connecting' ? 'Connecting…' : 'Agent offline';

  const panelRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  // Drag the panel by its header. Clamps to the viewport; position persists via onMove.
  const onHeaderPointerDown = (e: React.PointerEvent) => {
    // Ignore drags that start on a control button.
    if ((e.target as HTMLElement).closest('button,input,label')) return;
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onHeaderPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const w = panelRef.current?.offsetWidth || 320;
    const h = panelRef.current?.offsetHeight || 120;
    const x = Math.min(Math.max(0, e.clientX - drag.current.dx), window.innerWidth - w);
    const y = Math.min(Math.max(0, e.clientY - drag.current.dy), window.innerHeight - h);
    props.onMove({ x, y });
  };
  const onHeaderPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  // Positioned by saved pos, else anchored bottom-right.
  const posStyle: React.CSSProperties = prefs.pos
    ? { left: prefs.pos.x, top: prefs.pos.y }
    : { bottom: 16, right: 16 };

  const btn: React.CSSProperties = {
    pointerEvents: 'auto',
    cursor: 'pointer',
    border: '1px solid #334155',
    background: '#1e293b',
    color: '#e2e8f0',
    borderRadius: 6,
    padding: '2px 7px',
    font: '11px/1.2 ui-monospace, Menlo, monospace',
  };

  return (
    <div
      ref={panelRef}
      style={{
        position: 'fixed',
        ...posStyle,
        zIndex: 2147483647,
        font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#e5e7eb',
        background: 'rgba(15,23,42,0.94)',
        border: `1px solid ${color}`,
        borderRadius: 12,
        padding: '9px 11px',
        width: prefs.collapsed ? 200 : 320,
        boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
        backdropFilter: 'blur(8px)',
        userSelect: 'none',
      }}
      data-agent-bridge-hud
    >
      <div
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onDoubleClick={() => props.onMove(null)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'grab', pointerEvents: 'auto', touchAction: 'none' }}
        title="Drag to move · double-click to reset position"
      >
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: color,
            animation: busy ? 'agentPulse 1s infinite' : 'none',
          }}
        />
        <strong style={{ color: '#fff', fontWeight: 700 }}>nextjs-agent</strong>
        <span style={{ marginLeft: 'auto', color, fontSize: 11 }}>{label}</span>
        <button style={btn} onClick={props.onToggleCollapsed} title="Expand/collapse">
          {prefs.collapsed ? '▢' : '—'}
        </button>
      </div>

      <div style={{ color: '#64748b', fontSize: 10, marginTop: 3 }}>{props.tabId}</div>

      {thinking && (
        <div
          style={{
            marginTop: 7,
            padding: '6px 8px',
            borderRadius: 8,
            background: 'linear-gradient(135deg,rgba(99,102,241,.25),rgba(139,92,246,.25))',
            border: '1px solid rgba(139,92,246,.4)',
            color: '#e9d5ff',
            fontSize: 12,
          }}
        >
          💭 {thinking}
        </div>
      )}

      {!prefs.collapsed && (
        <>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button style={{ ...btn, ...(paused ? { background: '#7c2d12', borderColor: '#9a3412' } : {}) }} onClick={props.onTogglePause}>
              {paused ? '▶ Resume' : '⏸ Pause'}
            </button>
            <button style={{ ...btn, ...(prefs.fx ? { background: '#075985', borderColor: '#0369a1' } : {}) }} onClick={props.onToggleFx} title="Toggle fancy animations">
              {prefs.fx ? '✨ FX on' : 'FX off'}
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#94a3b8', fontSize: 10, pointerEvents: 'auto' }}>
              spd
              <input
                type="range"
                min={0.5}
                max={3}
                step={0.5}
                value={prefs.speed}
                onChange={(e) => props.onSpeed(Number(e.target.value))}
                style={{ width: 56, pointerEvents: 'auto' }}
              />
            </label>
          </div>
        </>
      )}

      <style>{`@keyframes agentPulse{0%{box-shadow:0 0 0 0 ${color}80}70%{box-shadow:0 0 0 6px ${color}00}100%{box-shadow:0 0 0 0 ${color}00}}
        @keyframes agentRipple{0%{width:10px;height:10px;opacity:.65}100%{width:80px;height:80px;opacity:0}}
        @keyframes agentCursorPulse{0%{transform:scale(.6);opacity:.8}100%{transform:scale(2.2);opacity:0}}
        @keyframes agentSpotPulse{0%,100%{box-shadow:0 0 0 3px #38bdf8,0 0 0 100000px rgba(2,6,23,.6),0 0 26px 4px rgba(56,189,248,.7)}50%{box-shadow:0 0 0 4px #7dd3fc,0 0 0 100000px rgba(2,6,23,.62),0 0 40px 10px rgba(56,189,248,.95)}}
        @keyframes agentCaret{0%,100%{opacity:1}50%{opacity:0}}
        @keyframes agentThink{0%,100%{opacity:.5;transform:rotate(0deg)}50%{opacity:1;transform:rotate(180deg)}}`}</style>
    </div>
  );
}

// ---- op implementations (run in the page) ---------------------------------

async function run(op: string, args: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case 'click':
      return doClick(String(args.selector));
    case 'fill':
      return doFill(String(args.selector), String(args.value ?? ''));
    case 'fill_form': {
      // Non-animated batch fill (used when FX is off). Fills every field instantly.
      const fields = (args.fields as Array<{ selector: string; value: string }>) || [];
      const results = fields.map((f) => {
        try {
          doFill(String(f.selector), String(f.value ?? ''));
          return { selector: f.selector, ok: true };
        } catch (e) {
          return { selector: f.selector, ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      });
      return { filledForm: true, total: fields.length, filled: results.filter((r) => r.ok).length, results };
    }
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

// Set a value on a control using the right strategy for its type. Returns a short describing string.
// Handles: <select> (by value OR visible label), checkbox/radio (true/false/on/off/1/0/value match),
// date/time (normalizes common formats), number/text/textarea (native value setter), contenteditable.
function setControlValue(node: HTMLElement, value: string): string {
  const tag = node.tagName.toLowerCase();

  // <select> — match by option value first, else by visible label (case-insensitive).
  if (tag === 'select') {
    const sel = node as HTMLSelectElement;
    const opts = Array.from(sel.options);
    let opt =
      opts.find((o) => o.value === value) ||
      opts.find((o) => o.text.trim().toLowerCase() === value.trim().toLowerCase()) ||
      opts.find((o) => o.text.trim().toLowerCase().includes(value.trim().toLowerCase()));
    if (!opt) throw new Error(`No <option> matching "${value}" (have: ${opts.map((o) => o.text.trim()).slice(0, 8).join(', ')})`);
    nativeSet(sel, 'value', opt.value);
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return `selected "${opt.text.trim()}"`;
  }

  if (tag === 'input') {
    const input = node as HTMLInputElement;
    const type = (input.type || 'text').toLowerCase();

    if (type === 'checkbox') {
      const want = /^(true|1|on|yes|checked)$/i.test(value.trim());
      if (input.checked !== want) input.click(); // click fires the right React/MUI events
      return `checkbox ${input.checked ? 'checked' : 'unchecked'}`;
    }
    if (type === 'radio') {
      // Select the radio in the group whose value/label matches; if this exact one, just click it.
      const group = input.name
        ? (Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(input.name)}"]`)) as HTMLInputElement[])
        : [input];
      const target =
        group.find((r) => r.value === value) ||
        group.find((r) => (r.labels?.[0]?.textContent || '').trim().toLowerCase() === value.trim().toLowerCase()) ||
        input;
      if (!target.checked) target.click();
      return `radio "${target.value}" selected`;
    }
    if (type === 'date' || type === 'datetime-local' || type === 'time' || type === 'month' || type === 'week') {
      const v = normalizeDateValue(type, value);
      nativeSet(input, 'value', v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return `set ${type} to "${v}"`;
    }
    if (type === 'file') {
      throw new Error('file inputs cannot be set programmatically (OS picker); use the upload tool path');
    }
    // text-like inputs (text, email, number, search, tel, url, password…)
    nativeSet(input, 'value', value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return `typed "${value}"`;
  }

  if (tag === 'textarea') {
    nativeSet(node as HTMLTextAreaElement, 'value', value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return `typed "${value}"`;
  }

  // contenteditable (rich text / editable divs)
  if ((node as HTMLElement).isContentEditable) {
    node.focus();
    (node as HTMLElement).textContent = value;
    node.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return `set contenteditable text`;
  }

  throw new Error(`Don't know how to fill <${tag}> — not a known input type`);
}

// Set a property via the element's native prototype setter so React's value-shadowing is bypassed.
function nativeSet(node: HTMLElement, prop: 'value', v: string) {
  const tag = node.tagName.toLowerCase();
  const proto =
    tag === 'select'
      ? HTMLSelectElement.prototype
      : tag === 'textarea'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, prop)?.set;
  if (setter) setter.call(node, v);
  else (node as unknown as Record<string, string>)[prop] = v;
}

// Best-effort normalization for native date/time inputs (they require specific value formats).
function normalizeDateValue(type: string, value: string): string {
  const v = value.trim();
  if (type === 'time') return v; // expects HH:MM (24h)
  // Accept yyyy-mm-dd as-is; try to coerce other parseable dates.
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return type === 'datetime-local' ? v.replace(' ', 'T').slice(0, 16) : v.slice(0, type === 'month' ? 7 : 10);
  const d = new Date(v);
  if (isNaN(d.getTime())) return v; // leave as-is; let the input reject if invalid
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (type === 'month') return ymd.slice(0, 7);
  if (type === 'datetime-local') return `${ymd}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return ymd;
}

function doFill(selector: string, value: string) {
  const node = el(selector);
  node.focus();
  const detail = setControlValue(node, value);
  return { filled: selector, value, detail };
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
