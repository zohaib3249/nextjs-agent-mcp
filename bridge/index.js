'use client';
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// bridge/src/agent-bridge.client.tsx
import { useEffect, useRef, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var WS_PORT = Number(process.env.NEXT_PUBLIC_AGENT_BRIDGE_PORT) || 7333;
var WS_PORT_RANGE = 11;
function rand() {
  try {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return a[0].toString(36) + a[1].toString(36);
  } catch {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
}
function getTabId() {
  try {
    if (window.name && window.name.startsWith("agbid:")) return window.name.slice(6);
    const id = "tab-" + rand().slice(0, 10);
    window.name = "agbid:" + id;
    return id;
  } catch {
    return "tab-" + rand().slice(0, 10);
  }
}
var TAB_ID = typeof window !== "undefined" ? getTabId() : "tab-ssr";
function adoptTabId(id) {
  TAB_ID = id;
  try {
    window.name = "agbid:" + id;
  } catch {
  }
}
var NET = {
  seq: 0,
  entries: [],
  max: 500,
  bodyCap: 2e4
};
function netPush(e) {
  const entry = { id: ++NET.seq, ts: Date.now(), ...e };
  NET.entries.push(entry);
  if (NET.entries.length > NET.max) NET.entries.shift();
}
function errorUrls(limit = 20) {
  if (limit <= 0) return [];
  const out = [];
  for (let i = NET.entries.length - 1; i >= 0 && out.length < limit; i--) {
    const e = NET.entries[i];
    if (typeof e.status === "number" && e.status >= 400) out.push({ url: e.url, status: e.status, type: e.type });
  }
  return out;
}
function resourceType(initiatorType, url) {
  if (initiatorType === "xmlhttprequest") return "xhr";
  if (initiatorType === "fetch") return "fetch";
  if (initiatorType === "img" || /\.(png|jpe?g|gif|webp|svg|avif|ico)(\?|$)/i.test(url)) return "image";
  if (initiatorType === "css" || initiatorType === "link" || /\.css(\?|$)/i.test(url)) return "css";
  if (initiatorType === "script" || /\.m?js(\?|$)/i.test(url)) return "script";
  if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url)) return "font";
  if (initiatorType === "navigation") return "document";
  return "other";
}
var netInstalled = false;
function installNetworkRecorder() {
  if (netInstalled || typeof window === "undefined") return;
  netInstalled = true;
  const origFetch = window.fetch?.bind(window);
  if (origFetch) {
    window.fetch = async (input, init) => {
      const start = performance.now();
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
      try {
        const res = await origFetch(input, init);
        let body;
        try {
          const ct = res.headers.get("content-type") || "";
          if (/json|text|xml|javascript|html/.test(ct)) {
            body = (await res.clone().text()).slice(0, NET.bodyCap);
          }
        } catch {
        }
        netPush({
          source: "fetch",
          type: "fetch",
          method,
          url,
          status: res.status,
          ok: res.ok,
          durationMs: Math.round(performance.now() - start),
          size: body ? body.length : null,
          body
        });
        return res;
      } catch (err) {
        netPush({
          source: "fetch",
          type: "fetch",
          method,
          url,
          status: null,
          ok: false,
          durationMs: Math.round(performance.now() - start),
          size: null,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err;
      }
    };
  }
  const XP = XMLHttpRequest.prototype;
  const origOpen = XP.open;
  const origSend = XP.send;
  XP.open = function(method, url, ...rest) {
    this.__net = { method: (method || "GET").toUpperCase(), url, start: 0 };
    return origOpen.call(this, method, url, ...rest);
  };
  XP.send = function(bodyArg) {
    const meta = this.__net;
    if (meta) {
      meta.start = performance.now();
      this.addEventListener("loadend", () => {
        let body;
        try {
          if (this.responseType === "" || this.responseType === "text") body = String(this.responseText).slice(0, NET.bodyCap);
        } catch {
        }
        netPush({
          source: "xhr",
          type: "xhr",
          method: meta.method,
          url: meta.url,
          status: this.status || null,
          ok: this.status >= 200 && this.status < 400,
          durationMs: Math.round(performance.now() - meta.start),
          size: body ? body.length : null,
          body
        });
      });
    }
    return origSend.call(this, bodyArg);
  };
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const type = resourceType(e.initiatorType, e.name);
        if (type === "fetch" || type === "xhr") continue;
        netPush({
          source: "resource",
          type,
          method: "GET",
          url: e.name,
          status: null,
          ok: null,
          durationMs: Math.round(e.duration),
          size: e.transferSize || e.encodedBodySize || null
        });
      }
    });
    po.observe({ type: "resource", buffered: true });
  } catch {
  }
}
if (typeof window !== "undefined") installNetworkRecorder();
var PREFS_KEY = "__agent_bridge_prefs";
var DEFAULT_PREFS = { fx: true, collapsed: false, speed: 1, pos: null };
function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch {
    return DEFAULT_PREFS;
  }
}
function savePrefs(p) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
  }
}
var FX = null;
function AgentBridge() {
  const [status, setStatus] = useState("connecting");
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(null);
  const [paused, setPaused] = useState(false);
  const [tabIdState, setTabIdState] = useState(TAB_ID);
  const [owner, setOwner] = useState(null);
  const ownerRef = useRef(null);
  ownerRef.current = owner;
  const [locked, setLocked] = useState(false);
  const [introAgent, setIntroAgent] = useState(null);
  const sendRef = useRef(null);
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setPrefs(loadPrefs());
    setMounted(true);
  }, []);
  const fxLayer = useRef(null);
  const pausedRef = useRef(paused);
  const prefsRef = useRef(prefs);
  const resumeWaiters = useRef([]);
  pausedRef.current = paused;
  prefsRef.current = prefs;
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
  useEffect(() => {
    FX = new AgentFx(() => fxLayer.current, () => prefsRef.current);
    const t = setTimeout(() => {
      if (prefsRef.current.fx) FX?.showBar(status === "connected" ? "Agent connected \u2014 ready" : "Waiting for the agent\u2026");
    }, 50);
    return () => {
      clearTimeout(t);
      FX = null;
    };
  }, []);
  useEffect(() => {
    if (!FX) return;
    if (!prefs.fx) FX.hideBar();
    else FX.showBar(status === "connected" ? "Agent connected \u2014 ready" : status === "connecting" ? "Connecting\u2026" : "Agent offline");
  }, [status, prefs.fx]);
  useEffect(() => {
    let ws = null;
    let closed = false;
    let retry = null;
    const waitWhilePaused = () => pausedRef.current ? new Promise((r) => resumeWaiters.current.push(r)) : Promise.resolve();
    let portOffset = 0;
    const connect = () => {
      if (closed) return;
      setStatus("connecting");
      const port = WS_PORT + portOffset % WS_PORT_RANGE;
      let opened = false;
      try {
        ws = new WebSocket(`ws://localhost:${port}`);
      } catch {
        portOffset++;
        retry = setTimeout(connect, 400);
        return;
      }
      const tryNext = setTimeout(() => {
        if (!opened) {
          portOffset++;
          try {
            ws?.close();
          } catch {
          }
        }
      }, 700);
      ws.onopen = () => {
        opened = true;
        clearTimeout(tryNext);
        setStatus("connected");
        ws.send(
          JSON.stringify({
            t: "register",
            role: "tab",
            tabId: TAB_ID,
            url: location.href,
            pathname: location.pathname,
            title: document.title,
            userAgent: navigator.userAgent
          })
        );
        if (prefsRef.current.fx) FX?.showBar("Idle \u2014 unclaimed (open to agents)");
      };
      ws.onmessage = async (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.t === "assignTabId" && msg.tabId) {
          adoptTabId(String(msg.tabId));
          setTabIdState(String(msg.tabId));
          return;
        }
        if (msg.t === "registered") return;
        if (msg.t === "claimed") {
          const o = { name: String(msg.agentName || "agent"), intent: String(msg.intent || "") };
          setOwner(o);
          setLocked(false);
          setIntroAgent(o);
          setTimeout(() => setIntroAgent(null), 2200);
          if (prefsRef.current.fx) FX?.showBar(`Controlled by ${o.name}${o.intent ? " \u2014 " + o.intent : ""}`);
          return;
        }
        if (msg.t === "released") {
          setOwner(null);
          setIntroAgent(null);
          if (prefsRef.current.fx) FX?.showBar("Idle \u2014 unclaimed (open to agents)");
          return;
        }
        if (msg.t === "lockedByUser") {
          setOwner(null);
          setLocked(true);
          setIntroAgent(null);
          if (prefsRef.current.fx) FX?.showBar("You're in control \u2014 agents are blocked");
          return;
        }
        if (msg.t === "unlocked") {
          setLocked(false);
          if (prefsRef.current.fx) FX?.showBar("Idle \u2014 unclaimed (open to agents)");
          return;
        }
        if (msg.t !== "cmd") return;
        if (!ownerRef.current) {
          send({ t: "result", id: msg.id, ok: false, error: "tab not claimed" });
          return;
        }
        const cmd = { kind: "command", id: msg.id, op: String(msg.op), args: msg.args || {}, message: msg.message ?? null };
        const narration = String(cmd.message ?? cmd.args?.message ?? "").slice(0, 300);
        if (cmd.op === "think" || cmd.op === "status") {
          const msg2 = narration;
          const kind = cmd.args?.kind || (cmd.op === "think" ? "thinking" : "action");
          const dwellMs = typeof cmd.args?.dwellMs === "number" ? cmd.args.dwellMs : void 0;
          setThinking(msg2);
          if (prefsRef.current.fx) FX?.say(msg2, dwellMs, kind);
          send({ t: "result", id: cmd.id, ok: true, value: { acknowledged: true } });
          return;
        }
        if (pausedRef.current) {
          await waitWhilePaused();
        }
        setThinking(narration || actionLabel(cmd));
        setBusy(true);
        try {
          let value;
          if (prefsRef.current.fx) {
            FX?.say(narration || actionLabel(cmd));
            if (cmd.op === "fill_form" && FX) {
              value = await FX.fillForm(
                cmd.args.fields || [],
                narration
              );
            } else {
              await FX?.before(cmd);
              if (cmd.op === "fill" && FX) {
                value = await FX.typeFill(String(cmd.args.selector), String(cmd.args.value ?? ""));
              } else {
                value = await run(cmd.op, cmd.args);
              }
            }
          } else {
            if (cmd.op === "fill_form") {
              value = await run("fill_form", cmd.args);
            } else {
              value = await run(cmd.op, cmd.args);
            }
          }
          if (prefsRef.current.fx) FX?.after(cmd);
          send({ t: "result", id: cmd.id, ok: true, value });
        } catch (err) {
          if (prefsRef.current.fx) FX?.fail(cmd);
          send({ t: "result", id: cmd.id, ok: false, error: errMsg(err) });
        } finally {
          setBusy(false);
        }
      };
      ws.onclose = () => {
        clearTimeout(tryNext);
        ws = null;
        setStatus("disconnected");
        const delay = opened ? 1200 : 250;
        if (!closed) retry = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };
    const send = (obj) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };
    sendRef.current = send;
    const levels = ["log", "info", "warn", "error", "debug"];
    const orig = {};
    const fmt = (a) => a.map((v) => {
      if (typeof v === "string") return v;
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    }).join(" ").slice(0, 2e3);
    for (const lvl of levels) {
      orig[lvl] = console[lvl];
      console[lvl] = (...a) => {
        send({ t: "console", level: lvl, message: fmt(a) });
        orig[lvl].apply(console, a);
      };
    }
    const onError = (e) => send({ t: "console", level: "error", message: `Uncaught ${e.message} @ ${e.filename}:${e.lineno}` });
    const onRejection = (e) => send({ t: "console", level: "error", message: `Unhandled rejection: ${String(e.reason)}`.slice(0, 2e3) });
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      for (const lvl of levels) if (orig[lvl]) console[lvl] = orig[lvl];
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      ws?.close();
    };
  }, []);
  if (!mounted) return null;
  const takeOver = () => sendRef.current?.({ t: "takeover" });
  const allowAgents = () => sendRef.current?.({ t: "allowAgents" });
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      "div",
      {
        ref: fxLayer,
        "data-agent-bridge-hud": true,
        style: { position: "fixed", inset: 0, zIndex: 2147483646, pointerEvents: "none", overflow: "hidden" }
      }
    ),
    /* @__PURE__ */ jsx(ControlOverlay, { owner, locked, introAgent, onTakeOver: takeOver, onAllow: allowAgents, fx: prefs.fx }),
    /* @__PURE__ */ jsx(
      Hud,
      {
        status,
        busy,
        thinking,
        paused,
        tabId: tabIdState,
        owner,
        prefs,
        onTogglePause: () => setPaused((p) => !p),
        onToggleFx: () => setPrefs((p) => ({ ...p, fx: !p.fx })),
        onToggleCollapsed: () => setPrefs((p) => ({ ...p, collapsed: !p.collapsed })),
        onSpeed: (v) => setPrefs((p) => ({ ...p, speed: v })),
        onMove: (pos) => setPrefs((p) => ({ ...p, pos }))
      }
    )
  ] });
}
function ControlOverlay({
  owner,
  locked,
  introAgent,
  onTakeOver,
  onAllow,
  fx
}) {
  if (!fx) {
    if (!owner && !locked) return null;
  }
  const active = !!owner;
  const badgeBtn = {
    pointerEvents: "auto",
    cursor: "pointer",
    border: "none",
    borderRadius: 8,
    padding: "7px 12px",
    font: "700 12px/1 ui-sans-serif, system-ui, sans-serif",
    color: "#fff"
  };
  return /* @__PURE__ */ jsxs("div", { "data-agent-bridge-hud": true, style: { position: "fixed", inset: 0, zIndex: 2147483645, pointerEvents: "none" }, children: [
    active && /* @__PURE__ */ jsx(
      "div",
      {
        style: {
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          boxShadow: "inset 0 0 0 3px rgba(56,189,248,.9), inset 0 0 40px 6px rgba(56,189,248,.35)",
          animation: "agentFramePulse 2.2s ease-in-out infinite"
        }
      }
    ),
    active && /* @__PURE__ */ jsxs(
      "div",
      {
        style: {
          position: "absolute",
          top: 0,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 14px",
          borderRadius: "0 0 14px 14px",
          background: "linear-gradient(135deg,#0ea5e9,#6366f1)",
          color: "#fff",
          font: "600 13px/1.3 ui-sans-serif, system-ui, sans-serif",
          boxShadow: "0 8px 28px rgba(0,0,0,.45)",
          maxWidth: "92vw"
        },
        children: [
          /* @__PURE__ */ jsx("span", { style: { animation: "agentThink 1.6s ease-in-out infinite" }, children: "\u2726" }),
          /* @__PURE__ */ jsxs("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: [
            /* @__PURE__ */ jsx("strong", { children: owner.name }),
            " is controlling this tab",
            owner.intent ? ` \u2014 ${owner.intent}` : ""
          ] }),
          /* @__PURE__ */ jsx("button", { style: { ...badgeBtn, background: "rgba(255,255,255,.18)" }, onClick: onTakeOver, title: "Disconnect the agent and take control", children: "\u270B Take over" })
        ]
      }
    ),
    locked && !active && /* @__PURE__ */ jsxs(
      "div",
      {
        style: {
          position: "absolute",
          top: 0,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 14px",
          borderRadius: "0 0 14px 14px",
          background: "#16a34a",
          color: "#fff",
          font: "600 13px/1.3 ui-sans-serif, system-ui, sans-serif",
          boxShadow: "0 8px 28px rgba(0,0,0,.4)"
        },
        children: [
          /* @__PURE__ */ jsx("span", { children: "\u{1F9D1} You're in control \u2014 agents are blocked" }),
          /* @__PURE__ */ jsx("button", { style: { ...badgeBtn, background: "rgba(255,255,255,.2)" }, onClick: onAllow, title: "Let agents claim this tab again", children: "Allow agents" })
        ]
      }
    ),
    introAgent && /* @__PURE__ */ jsx(
      "div",
      {
        style: {
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(2,6,23,.55)",
          animation: "agentIntroFade 2.2s ease forwards",
          pointerEvents: "none"
        },
        children: /* @__PURE__ */ jsxs(
          "div",
          {
            style: {
              padding: "20px 26px",
              borderRadius: 16,
              background: "linear-gradient(135deg,#0ea5e9,#6366f1)",
              color: "#fff",
              textAlign: "center",
              boxShadow: "0 20px 60px rgba(0,0,0,.55)",
              animation: "agentIntroPop .5s cubic-bezier(.22,1,.36,1)"
            },
            children: [
              /* @__PURE__ */ jsx("div", { style: { fontSize: 30, marginBottom: 6 }, children: "\u{1F916}" }),
              /* @__PURE__ */ jsxs("div", { style: { font: "800 18px/1.2 ui-sans-serif, system-ui, sans-serif" }, children: [
                introAgent.name,
                " took control"
              ] }),
              introAgent.intent && /* @__PURE__ */ jsx("div", { style: { marginTop: 6, opacity: 0.92, font: "500 13px/1.4 ui-sans-serif, system-ui, sans-serif", maxWidth: 360 }, children: introAgent.intent })
            ]
          }
        )
      }
    ),
    /* @__PURE__ */ jsx("style", { children: `
        @keyframes agentFramePulse{0%,100%{box-shadow:inset 0 0 0 3px rgba(56,189,248,.85),inset 0 0 40px 6px rgba(56,189,248,.28)}50%{box-shadow:inset 0 0 0 3px rgba(125,211,252,1),inset 0 0 60px 10px rgba(56,189,248,.5)}}
        @keyframes agentIntroFade{0%{opacity:0}15%{opacity:1}75%{opacity:1}100%{opacity:0}}
        @keyframes agentIntroPop{0%{transform:scale(.8);opacity:0}100%{transform:scale(1);opacity:1}}
      ` })
  ] });
}
var _AgentFx = class _AgentFx {
  // a message stays at least this long before idle phrases
  constructor(getLayer, getPrefs) {
    __publicField(this, "getLayer");
    __publicField(this, "getPrefs");
    __publicField(this, "cursor", null);
    __publicField(this, "spot", null);
    __publicField(this, "tip", null);
    __publicField(this, "cx", -100);
    __publicField(this, "cy", -100);
    // Persistent "speech" toast that types out the agent's narration (Claude-Code style).
    __publicField(this, "sayBox", null);
    __publicField(this, "sayText", null);
    __publicField(this, "sayDot", null);
    __publicField(this, "sayToken", 0);
    // cancels an in-flight typing animation when a newer one starts
    __publicField(this, "sayHideTimer", null);
    __publicField(this, "idleTimer", null);
    __publicField(this, "idleIdx", 0);
    this.getLayer = getLayer;
    this.getPrefs = getPrefs;
  }
  speed() {
    return this.getPrefs().speed || 1;
  }
  // Pace by speed, but floor so a high speed setting can never make effects invisible.
  ms(base) {
    return Math.max(220, base / this.speed());
  }
  ensureCursor() {
    const layer = this.getLayer();
    if (!layer) return null;
    if (!this.cursor) {
      const c = document.createElement("div");
      c.style.cssText = `position:absolute;width:30px;height:30px;left:0;top:0;transform:translate(-200px,-200px);transition:transform .55s cubic-bezier(.22,1,.36,1);z-index:6;will-change:transform;background:no-repeat center/contain url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M3 2l7 18 2.5-7.5L20 10z' fill='%2338bdf8' stroke='white' stroke-width='1.5' stroke-linejoin='round'/></svg>");filter:drop-shadow(0 0 8px rgba(56,189,248,.95)) drop-shadow(0 2px 4px rgba(0,0,0,.5));`;
      const halo = document.createElement("div");
      halo.style.cssText = "position:absolute;left:-9px;top:-9px;width:30px;height:30px;border-radius:50%;background:radial-gradient(circle,rgba(56,189,248,.45),rgba(56,189,248,0) 70%);animation:agentCursorPulse 1.4s ease-out infinite;";
      c.appendChild(halo);
      layer.appendChild(c);
      this.cursor = c;
    }
    return this.cursor;
  }
  rectOf(sel) {
    if (!sel) return null;
    const el2 = document.querySelector(sel);
    if (!el2) return null;
    el2.scrollIntoView({ block: "center", behavior: "smooth" });
    return el2.getBoundingClientRect();
  }
  // Glide the cursor to a point and resolve when it arrives.
  moveTo(x, y) {
    const c = this.ensureCursor();
    if (!c) return Promise.resolve();
    this.cx = x;
    this.cy = y;
    c.style.transitionDuration = `${this.ms(500)}ms`;
    c.style.transform = `translate(${x}px, ${y}px)`;
    return new Promise((r) => setTimeout(r, this.ms(520)));
  }
  // Spotlight + labeled tooltip around a rect.
  spotlight(rect, label) {
    const layer = this.getLayer();
    if (!layer) return;
    if (!this.spot) {
      this.spot = document.createElement("div");
      this.spot.style.cssText = "position:absolute;border-radius:10px;z-index:3;pointer-events:none;box-shadow:0 0 0 3px #38bdf8, 0 0 0 100000px rgba(2,6,23,.6), 0 0 30px 6px rgba(56,189,248,.85);transition:all .4s cubic-bezier(.22,1,.36,1);animation:agentSpotPulse 1.1s ease-in-out infinite;";
      layer.appendChild(this.spot);
    }
    const pad = 6;
    this.spot.style.left = `${rect.left - pad}px`;
    this.spot.style.top = `${rect.top - pad}px`;
    this.spot.style.width = `${rect.width + pad * 2}px`;
    this.spot.style.height = `${rect.height + pad * 2}px`;
    this.spot.style.opacity = "1";
    if (!this.tip) {
      this.tip = document.createElement("div");
      this.tip.style.cssText = "position:absolute;z-index:5;pointer-events:none;max-width:300px;padding:6px 11px;border-radius:8px;font:700 13px/1.3 ui-sans-serif,system-ui,sans-serif;color:#fff;background:#0ea5e9;box-shadow:0 8px 22px rgba(0,0,0,.45);transition:all .3s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      layer.appendChild(this.tip);
    }
    this.tip.style.background = "#0ea5e9";
    this.tip.textContent = label;
    const top = rect.top - 36 < 8 ? rect.bottom + 10 : rect.top - 36;
    this.tip.style.left = `${Math.max(8, rect.left)}px`;
    this.tip.style.top = `${top}px`;
    this.tip.style.opacity = "1";
  }
  clearSpotlight() {
    if (this.spot) this.spot.style.opacity = "0";
    if (this.tip) this.tip.style.opacity = "0";
  }
  // Click ripple at the current cursor position.
  ripple() {
    const layer = this.getLayer();
    if (!layer) return;
    const r = document.createElement("div");
    r.style.cssText = `position:absolute;left:${this.cx}px;top:${this.cy}px;width:8px;height:8px;border-radius:50%;background:rgba(56,189,248,.55);z-index:3;transform:translate(-50%,-50%);animation:agentRipple ${this.ms(550)}ms ease-out forwards;`;
    layer.appendChild(r);
    setTimeout(() => r.remove(), this.ms(600));
  }
  // A floating toast at top-center (like a navigation toast). Used for thinking + notices.
  // Both kinds use the dark/black style the user prefers; thinking gets a 💭 and an accent bar.
  toast(text, kind = "info") {
    const layer = this.getLayer();
    if (!layer || !text) return;
    const t = document.createElement("div");
    t.style.cssText = "position:absolute;left:50%;top:18px;transform:translateX(-50%) translateY(-12px);z-index:7;display:flex;align-items:center;gap:9px;max-width:min(640px,90vw);padding:11px 16px;border-radius:12px;color:#f1f5f9;font:600 14px/1.4 ui-sans-serif,system-ui,sans-serif;background:rgba(15,23,42,.97);border:1px solid " + (kind === "think" ? "#8b5cf6" : "#334155") + ";box-shadow:0 14px 40px rgba(0,0,0,.55);opacity:0;transition:all .4s cubic-bezier(.22,1,.36,1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    if (kind === "think") {
      const dot = document.createElement("span");
      dot.style.cssText = "flex:0 0 auto;font-size:16px;";
      dot.textContent = "\u{1F4AD}";
      t.appendChild(dot);
    }
    const span = document.createElement("span");
    span.style.cssText = "overflow:hidden;text-overflow:ellipsis;";
    span.textContent = text;
    t.appendChild(span);
    layer.appendChild(t);
    requestAnimationFrame(() => {
      t.style.opacity = "1";
      t.style.transform = "translateX(-50%) translateY(0)";
    });
    const life = kind === "think" ? this.ms(4200) : this.ms(2800);
    setTimeout(() => {
      t.style.opacity = "0";
      t.style.transform = "translateX(-50%) translateY(-12px)";
      setTimeout(() => t.remove(), 420);
    }, life);
  }
  // A persistent status bar fixed to the BOTTOM-CENTER of the screen (not page-anchored). Created
  // once and kept visible from connection onward; say() retypes its text.
  ensureSayBox() {
    const layer = this.getLayer();
    if (!layer) return null;
    if (!this.sayBox) {
      const box = document.createElement("div");
      box.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483646;display:flex;align-items:center;gap:10px;max-width:min(760px,94vw);min-width:240px;padding:12px 18px;border-radius:14px;color:#f1f5f9;font:600 14px/1.4 ui-sans-serif,system-ui,sans-serif;background:rgba(12,18,32,.97);border:1px solid #334155;box-shadow:0 18px 50px rgba(0,0,0,.6);opacity:0;transition:opacity .3s ease;white-space:nowrap;pointer-events:none;";
      const dot = document.createElement("span");
      dot.textContent = "\u2726";
      dot.style.cssText = "flex:0 0 auto;color:#a78bfa;font-size:16px;animation:agentThink 1.6s ease-in-out infinite;";
      const txt = document.createElement("span");
      txt.style.cssText = "overflow:hidden;text-overflow:ellipsis;";
      const caret = document.createElement("span");
      caret.textContent = "\u258C";
      caret.style.cssText = "color:#a78bfa;animation:agentCaret 1s step-end infinite;margin-left:1px;flex:0 0 auto;";
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
  showBar(idle = "Agent connected \u2014 ready") {
    const box = this.ensureSayBox();
    if (!box || !this.sayText) return;
    box.style.opacity = "1";
    if (!this.sayText.textContent) this.sayText.textContent = idle;
  }
  hideBar() {
    if (this.sayBox) this.sayBox.style.opacity = "0";
  }
  clearTimers() {
    if (this.sayHideTimer) clearTimeout(this.sayHideTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.sayHideTimer = null;
    this.idleTimer = null;
  }
  // After a message has been shown for its dwell time with nothing new, cycle gentle idle phrases
  // (Thinking… / Planning… / Waiting…) so the bar is alive but never overwrites a fresh message.
  startIdleCycle(token, dwellMs) {
    this.idleTimer = setTimeout(() => {
      if (token !== this.sayToken || !this.sayText) return;
      const n = _AgentFx.IDLE_PHRASES.length;
      let next = Math.floor(Math.random() * n);
      if (next === this.idleIdx) next = (next + 1) % n;
      this.idleIdx = next;
      const phrase = _AgentFx.IDLE_PHRASES[next];
      void this._type(phrase, token).then(() => {
        if (token === this.sayToken) this.startIdleCycle(token, 4e3);
      });
    }, dwellMs);
  }
  // Low-level typer shared by say() and the idle cycle. Fast: ~12ms/char (NOT floored by ms()),
  // and types 2 chars per tick so even long lines finish quickly.
  async _type(msg, token) {
    if (!this.sayText) return;
    this.sayText.textContent = "";
    const per = Math.max(6, Math.round(12 / (this.getPrefs().speed || 1)));
    const step = msg.length > 60 ? 3 : 2;
    for (let i = step; i < msg.length + step; i += step) {
      if (token !== this.sayToken) return;
      this.sayText.textContent = msg.slice(0, Math.min(i, msg.length));
      if (i < msg.length) await new Promise((r) => setTimeout(r, per));
    }
  }
  // Retype the status bar's text. The bar STAYS visible. A message is held for at least
  // MIN_DWELL_MS (~10s); if nothing new arrives, idle phrases start cycling. `dwellMs` overrides.
  // `kind` swaps the leading icon: action ✦ | thinking 💭 | code ⌘ (checking code) | net ⇅.
  async say(text, dwellMs, kind = "action") {
    const box = this.ensureSayBox();
    if (!box || !this.sayText) return;
    box.style.opacity = "1";
    if (this.sayDot) {
      const icon = kind === "thinking" ? "\u{1F4AD}" : kind === "code" ? "\u2318" : kind === "net" ? "\u21C5" : "\u2726";
      this.sayDot.textContent = icon;
      this.sayDot.style.color = kind === "code" ? "#34d399" : kind === "net" ? "#fbbf24" : "#a78bfa";
    }
    const msg = (text || "").trim() || "Working\u2026";
    const token = ++this.sayToken;
    this.clearTimers();
    await this._type(msg, token);
    if (token !== this.sayToken) return;
    this.startIdleCycle(token, Math.max(1e3, dwellMs ?? _AgentFx.MIN_DWELL_MS));
  }
  // Before an action runs: travel the cursor to the target, THEN spotlight it (so the motion reads).
  async before(cmd) {
    const sel = cmd.args?.selector;
    const rect = this.rectOf(sel);
    if (rect) {
      this.ensureCursor();
      await this.moveTo(rect.left + rect.width / 2, rect.top + rect.height / 2);
      this.spotlight(rect, actionLabel(cmd));
      if (cmd.op === "click") this.ripple();
      await new Promise((r) => setTimeout(r, this.ms(300)));
    }
  }
  after(_cmd) {
    setTimeout(() => this.clearSpotlight(), this.ms(1400));
  }
  fail(cmd) {
    if (this.tip) {
      this.tip.style.background = "#ef4444";
      this.tip.textContent = `failed: ${actionLabel(cmd)}`;
    }
    setTimeout(() => this.clearSpotlight(), this.ms(1100));
  }
  // Typewriter fill: set the input value one character at a time (each a real React-visible change),
  // updating the spotlight label as it goes. Falls back to instant if the element vanishes.
  async typeFill(selector, value) {
    const node = document.querySelector(selector);
    if (!node) throw new Error(`No element matches selector: ${selector}`);
    const tag = node.tagName.toLowerCase();
    const type = tag === "input" ? (node.type || "text").toLowerCase() : tag;
    const isTextLike = tag === "input" && !["checkbox", "radio", "date", "datetime-local", "time", "month", "week", "file", "range", "color"].includes(type) || tag === "textarea" || node.isContentEditable;
    if (isComposedWidget(node)) {
      if (this.tip) this.tip.textContent = `Selecting "${String(value).slice(0, 24)}"`;
      return doSelectOption(selector, value);
    }
    if (!isTextLike) {
      const detail = setControlValue(node, value);
      if (this.tip) this.tip.textContent = detail;
      return { filled: selector, value, detail };
    }
    node.focus();
    const editable = node.isContentEditable;
    const setVal = (v) => {
      if (editable) {
        node.textContent = v;
        node.dispatchEvent(new InputEvent("input", { bubbles: true }));
      } else {
        nativeSet(node, "value", v);
        node.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };
    const per = Math.max(8, Math.round(22 / (this.getPrefs().speed || 1)));
    const max = Math.min(value.length, 60);
    for (let i = 1; i <= value.length; i++) {
      setVal(value.slice(0, i));
      if (this.tip) this.tip.textContent = `Typing "${value.slice(0, Math.min(i, 24))}${i > 24 ? "\u2026" : ""}"`;
      if (i <= max) await new Promise((r) => setTimeout(r, per));
    }
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: selector, value };
  }
  // fill_form: fill an array of {selector,value} one-by-one, animating each like a person —
  // cursor glides to the field, spotlight, fast typewriter — in a single round-trip.
  async fillForm(fields, narration) {
    const results = [];
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!f || !f.selector) {
        results.push({ selector: String(f?.selector), ok: false, error: "missing selector" });
        continue;
      }
      const hint = fieldHint(f.selector);
      this.say(narration || `Filling ${hint || "field " + (i + 1)} (${i + 1}/${fields.length})`, void 0, "action");
      const node = document.querySelector(f.selector);
      if (!node) {
        results.push({ selector: f.selector, ok: false, error: "no element matches selector" });
        continue;
      }
      const rect = (node.scrollIntoView({ block: "center", behavior: "smooth" }), node.getBoundingClientRect());
      this.ensureCursor();
      await this.moveTo(rect.left + rect.width / 2, rect.top + rect.height / 2);
      this.spotlight(rect, `Typing "${String(f.value).slice(0, 24)}"`);
      try {
        await this.typeFill(f.selector, String(f.value ?? ""));
        results.push({ selector: f.selector, ok: true, value: String(f.value ?? "") });
      } catch (e) {
        results.push({ selector: f.selector, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      await new Promise((r) => setTimeout(r, this.ms(180)));
    }
    setTimeout(() => this.clearSpotlight(), this.ms(800));
    const filled = results.filter((r) => r.ok).length;
    return { filledForm: true, total: fields.length, filled, results };
  }
};
__publicField(_AgentFx, "IDLE_PHRASES", [
  "Thinking\u2026",
  "Planning the next step\u2026",
  "Looking around the page\u2026",
  "Waiting for the agent\u2026",
  "Working on it\u2026",
  "Reading the layout\u2026",
  "Reasoning about what to do next\u2026",
  "Scanning for the right element\u2026",
  "Checking the page state\u2026",
  "Considering the options\u2026",
  "Mapping out the form\u2026",
  "Reviewing the DOM\u2026",
  "Inspecting the components\u2026",
  "Figuring out the next action\u2026",
  "Gathering context\u2026",
  "Analyzing the structure\u2026",
  "Locating the controls\u2026",
  "Double-checking the selectors\u2026",
  "Tracing the data flow\u2026",
  "Looking for the submit button\u2026",
  "Parsing the response\u2026",
  "Verifying the result\u2026",
  "Waiting for the page to settle\u2026",
  "Hold on, almost there\u2026",
  "Lining things up\u2026",
  "Cross-referencing the routes\u2026",
  "Reading the network activity\u2026",
  "Checking for errors\u2026",
  "Making sure everything loaded\u2026",
  "Deciding where to click\u2026",
  "Composing the next move\u2026",
  "Sizing up the page\u2026",
  "Looking for the right field\u2026",
  "Re-reading the requirements\u2026",
  "Connecting the dots\u2026",
  "Evaluating the state\u2026",
  "Preparing the next step\u2026",
  "Sketching a plan\u2026",
  "Picking the best approach\u2026",
  "Confirming the route\u2026",
  "Sweeping the interface\u2026",
  "Reading labels and inputs\u2026",
  "Watching for changes\u2026",
  "Letting the UI catch up\u2026",
  "Tidying up the plan\u2026",
  "Queuing the next action\u2026",
  "Checking the form values\u2026",
  "Looking at what changed\u2026",
  "Re-orienting on the page\u2026",
  "Thinking it through\u2026",
  "Almost ready\u2026",
  "Just a moment\u2026",
  "Processing\u2026"
]);
__publicField(_AgentFx, "MIN_DWELL_MS", 1e4);
var AgentFx = _AgentFx;
function actionLabel(cmd) {
  const a = cmd.args || {};
  switch (cmd.op) {
    case "click":
      return `Clicking ${fieldHint(a.selector) || shortSel(a.selector)}`;
    case "fill":
      return `Typing "${String(a.value).slice(0, 24)}"${fieldHint(a.selector) ? " in " + fieldHint(a.selector) : ""}`;
    case "fill_form":
      return `Filling the form (${Array.isArray(a.fields) ? a.fields.length : 0} fields)`;
    case "navigate":
      return `Going to ${String(a.url)}`;
    case "reload":
      return a.hard ? "Hard-reloading the page" : "Reloading the page";
    case "snapshot":
      return "Reading the page";
    case "page_context":
      return "Checking where I am";
    case "overview":
      return "Scanning the page layout";
    case "find":
      return `Searching for "${String(a.query).slice(0, 30)}"`;
    case "components":
      return "Inspecting the React components";
    case "component_for":
      return "Finding the component for this element";
    case "rerender":
      return "Forcing a re-render";
    case "wait_for":
      return a.text ? `Waiting for "${String(a.text).slice(0, 30)}" to appear` : "Waiting for the page to update";
    case "network_calls":
      return "Checking network requests";
    case "storage":
      return `Reading ${String(a.area || "local")} storage`;
    case "cache":
      return "Inspecting the cache";
    case "eval":
      return "Running a quick check in the page";
    case "screenshot":
      return "Taking a screenshot";
    case "open_tab":
      return `Opening a new tab (${String(a.url)})`;
    default:
      return "Working\u2026";
  }
}
function fieldHint(sel) {
  try {
    const el2 = sel ? document.querySelector(String(sel)) : null;
    if (!el2) return "";
    const name = labelFor(el2) || el2.placeholder || el2.getAttribute("name") || (el2.textContent || "").trim();
    return name ? `"${name.slice(0, 28)}"` : "";
  } catch {
    return "";
  }
}
function shortSel(sel) {
  const s = String(sel ?? "");
  return s.length > 28 ? s.slice(0, 28) + "\u2026" : s;
}
function Hud(props) {
  const { status, busy, thinking, paused, prefs } = props;
  const color = status === "connected" ? "#22c55e" : status === "connecting" ? "#eab308" : "#ef4444";
  const label = status === "connected" ? "Agent connected" : status === "connecting" ? "Connecting\u2026" : "Agent offline";
  const panelRef = useRef(null);
  const drag = useRef(null);
  const onHeaderPointerDown = (e) => {
    if (e.target.closest("button,input,label")) return;
    const el2 = panelRef.current;
    if (!el2) return;
    const r = el2.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onHeaderPointerMove = (e) => {
    if (!drag.current) return;
    const w = panelRef.current?.offsetWidth || 320;
    const h = panelRef.current?.offsetHeight || 120;
    const x = Math.min(Math.max(0, e.clientX - drag.current.dx), window.innerWidth - w);
    const y = Math.min(Math.max(0, e.clientY - drag.current.dy), window.innerHeight - h);
    props.onMove({ x, y });
  };
  const onHeaderPointerUp = (e) => {
    drag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
    }
  };
  const posStyle = prefs.pos ? { left: prefs.pos.x, top: prefs.pos.y } : { bottom: 16, right: 16 };
  const btn = {
    pointerEvents: "auto",
    cursor: "pointer",
    border: "1px solid #334155",
    background: "#1e293b",
    color: "#e2e8f0",
    borderRadius: 6,
    padding: "2px 7px",
    font: "11px/1.2 ui-monospace, Menlo, monospace"
  };
  return /* @__PURE__ */ jsxs(
    "div",
    {
      ref: panelRef,
      style: {
        position: "fixed",
        ...posStyle,
        zIndex: 2147483647,
        font: "12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "#e5e7eb",
        background: "rgba(15,23,42,0.94)",
        border: `1px solid ${color}`,
        borderRadius: 12,
        padding: "9px 11px",
        width: prefs.collapsed ? 200 : 320,
        boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
        backdropFilter: "blur(8px)",
        userSelect: "none"
      },
      "data-agent-bridge-hud": true,
      children: [
        /* @__PURE__ */ jsxs(
          "div",
          {
            onPointerDown: onHeaderPointerDown,
            onPointerMove: onHeaderPointerMove,
            onPointerUp: onHeaderPointerUp,
            onDoubleClick: () => props.onMove(null),
            style: { display: "flex", alignItems: "center", gap: 8, cursor: "grab", pointerEvents: "auto", touchAction: "none" },
            title: "Drag to move \xB7 double-click to reset position",
            children: [
              /* @__PURE__ */ jsx(
                "span",
                {
                  style: {
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: color,
                    animation: busy ? "agentPulse 1s infinite" : "none"
                  }
                }
              ),
              /* @__PURE__ */ jsx("strong", { style: { color: "#fff", fontWeight: 700 }, children: "nextjs-agent" }),
              /* @__PURE__ */ jsx("span", { style: { marginLeft: "auto", color, fontSize: 11 }, children: label }),
              /* @__PURE__ */ jsx("button", { style: btn, onClick: props.onToggleCollapsed, title: "Expand/collapse", children: prefs.collapsed ? "\u25A2" : "\u2014" })
            ]
          }
        ),
        /* @__PURE__ */ jsxs("div", { style: { color: "#64748b", fontSize: 10, marginTop: 3, display: "flex", gap: 6 }, children: [
          /* @__PURE__ */ jsx("span", { children: props.tabId }),
          /* @__PURE__ */ jsx("span", { style: { marginLeft: "auto", color: props.owner ? "#34d399" : "#eab308" }, children: props.owner ? `\u25A3 ${props.owner.name}` : "\u25CB unclaimed" })
        ] }),
        thinking && /* @__PURE__ */ jsxs(
          "div",
          {
            style: {
              marginTop: 7,
              padding: "6px 8px",
              borderRadius: 8,
              background: "linear-gradient(135deg,rgba(99,102,241,.25),rgba(139,92,246,.25))",
              border: "1px solid rgba(139,92,246,.4)",
              color: "#e9d5ff",
              fontSize: 12
            },
            children: [
              "\u{1F4AD} ",
              thinking
            ]
          }
        ),
        !prefs.collapsed && /* @__PURE__ */ jsx(Fragment, { children: /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }, children: [
          /* @__PURE__ */ jsx("button", { style: { ...btn, ...paused ? { background: "#7c2d12", borderColor: "#9a3412" } : {} }, onClick: props.onTogglePause, children: paused ? "\u25B6 Resume" : "\u23F8 Pause" }),
          /* @__PURE__ */ jsx("button", { style: { ...btn, ...prefs.fx ? { background: "#075985", borderColor: "#0369a1" } : {} }, onClick: props.onToggleFx, title: "Toggle fancy animations", children: prefs.fx ? "\u2728 FX on" : "FX off" }),
          /* @__PURE__ */ jsxs("label", { style: { display: "flex", alignItems: "center", gap: 4, color: "#94a3b8", fontSize: 10, pointerEvents: "auto" }, children: [
            "spd",
            /* @__PURE__ */ jsx(
              "input",
              {
                type: "range",
                min: 0.5,
                max: 3,
                step: 0.5,
                value: prefs.speed,
                onChange: (e) => props.onSpeed(Number(e.target.value)),
                style: { width: 56, pointerEvents: "auto" }
              }
            )
          ] })
        ] }) }),
        /* @__PURE__ */ jsx("style", { children: `@keyframes agentPulse{0%{box-shadow:0 0 0 0 ${color}80}70%{box-shadow:0 0 0 6px ${color}00}100%{box-shadow:0 0 0 0 ${color}00}}
        @keyframes agentRipple{0%{width:10px;height:10px;opacity:.65}100%{width:80px;height:80px;opacity:0}}
        @keyframes agentCursorPulse{0%{transform:scale(.6);opacity:.8}100%{transform:scale(2.2);opacity:0}}
        @keyframes agentSpotPulse{0%,100%{box-shadow:0 0 0 3px #38bdf8,0 0 0 100000px rgba(2,6,23,.6),0 0 26px 4px rgba(56,189,248,.7)}50%{box-shadow:0 0 0 4px #7dd3fc,0 0 0 100000px rgba(2,6,23,.62),0 0 40px 10px rgba(56,189,248,.95)}}
        @keyframes agentCaret{0%,100%{opacity:1}50%{opacity:0}}
        @keyframes agentThink{0%,100%{opacity:.5;transform:rotate(0deg)}50%{opacity:1;transform:rotate(180deg)}}` })
      ]
    }
  );
}
async function run(op, args) {
  switch (op) {
    case "click":
      return doClick(String(args.selector));
    case "fill":
      return doFill(String(args.selector), String(args.value ?? ""));
    case "select_option":
      return doSelectOption(String(args.selector), String(args.value ?? ""));
    case "set_field":
      return doSetField(String(args.selector), String(args.value ?? ""));
    case "fill_form": {
      const fields = args.fields || [];
      const results = [];
      for (const f of fields) {
        try {
          await doFill(String(f.selector), String(f.value ?? ""));
          results.push({ selector: f.selector, ok: true });
        } catch (e) {
          results.push({ selector: f.selector, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { filledForm: true, total: fields.length, filled: results.filter((r) => r.ok).length, results };
    }
    case "snapshot":
      return doSnapshot();
    case "page_context":
      return doPageContext();
    case "components":
      return doComponents(args);
    case "component_for":
      return doComponentFor(String(args.selector));
    case "rerender":
      return doRerender(String(args.selector));
    case "open_tab":
      return doOpenTab(String(args.url));
    case "wait_for":
      return doWaitFor(args);
    case "overview":
      return doOverview();
    case "navigate": {
      const url = String(args.url);
      const errLimit = typeof args.return_error_urls === "number" ? args.return_error_urls : 20;
      const before = location.href;
      location.assign(url);
      await new Promise((r) => setTimeout(r, 350));
      const navigatedWithinDoc = location.href !== before && document.readyState === "complete";
      const errors = errorUrls(errLimit);
      return {
        navigated: url,
        sameDocument: navigatedWithinDoc,
        overview: doOverview(),
        errorUrls: errors,
        // failed requests {url, status, type} seen so far (top N, newest first)
        errorCount: errors.length
      };
    }
    case "reload":
      if (args.hard) location.replace(location.href.split("#")[0]);
      else location.reload();
      return { reloaded: true, hard: !!args.hard };
    case "network_calls":
      return doNetworkCalls(args);
    case "storage":
      return doStorage(args);
    case "cache":
      return doCache(args);
    case "eval":
      return doEval(String(args.code));
    case "screenshot":
      return doScreenshot(args);
    case "find":
      return doFind(args);
    default:
      throw new Error(`Unknown op: ${op}`);
  }
}
function doFind(args) {
  const qRaw = String(args.query || "").trim();
  if (!qRaw) throw new Error("find requires a non-empty `query`.");
  const q = qRaw.toLowerCase();
  const scopes = Array.isArray(args.in) ? args.in : ["fields", "actions", "components"];
  const has = (v) => typeof v === "string" && v.toLowerCase().includes(q);
  const result = { query: qRaw };
  const snap = doSnapshot();
  if (scopes.includes("fields")) {
    result.fields = snap.fields.filter((f) => has(f.label) || has(f.name) || has(f.id) || has(f.placeholder) || has(f.value)).map((f) => ({
      label: f.label,
      name: f.name,
      id: f.id,
      type: f.type,
      value: f.value,
      placeholder: f.placeholder,
      selector: f.selector,
      formName: f.formName,
      matchedOn: ["label", "name", "id", "placeholder", "value"].filter((k) => has(f[k]))
    }));
  }
  if (scopes.includes("actions")) {
    result.actions = snap.actions.filter((a) => has(a.text) || has(a.href));
  }
  if (scopes.includes("components")) {
    try {
      const comp = doComponents({});
      const seen = /* @__PURE__ */ new Set();
      result.components = (comp.tree || []).filter((c) => has(c.name)).filter((c) => {
        if (seen.has(c.name)) return false;
        seen.add(c.name);
        return true;
      }).slice(0, 50).map((c) => ({ name: c.name, depth: c.depth, hooks: c.hooks }));
    } catch {
      result.components = [];
    }
  }
  const counts = {};
  for (const k of ["fields", "actions", "components"]) if (Array.isArray(result[k])) counts[k] = result[k].length;
  result.counts = counts;
  return result;
}
async function doNetworkCalls(args) {
  const since = typeof args.since === "number" ? args.since : 0;
  const types = Array.isArray(args.types) ? args.types : null;
  const urlContains = typeof args.urlContains === "string" ? args.urlContains : null;
  const includeBodies = args.includeBodies !== false;
  const limit = typeof args.limit === "number" ? args.limit : 100;
  let items = NET.entries.filter((e) => e.id > since);
  if (types) items = items.filter((e) => types.includes(e.type));
  if (urlContains) items = items.filter((e) => e.url.includes(urlContains));
  const total = items.length;
  items = items.slice(-limit);
  const out = items.map((e) => includeBodies ? e : { ...e, body: e.body ? `[${e.body.length} chars omitted]` : void 0 });
  return {
    lastId: NET.seq,
    matched: total,
    returned: out.length,
    typesSeen: [...new Set(NET.entries.map((e) => e.type))],
    calls: out
  };
}
function readCookies() {
  const out = {};
  for (const part of document.cookie.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[decodeURIComponent(part.slice(0, i).trim())] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function dumpStore(s) {
  const o = {};
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k != null) o[k] = s.getItem(k) ?? "";
  }
  return o;
}
function doStorage(args) {
  const area = String(args.area || "local");
  const action = String(args.action || "get");
  const key = args.key;
  const value = args.value;
  if (area === "cookie") {
    if (action === "get") return { area, cookies: readCookies() };
    if (action === "set") {
      if (!key) throw new Error("storage set cookie requires key");
      document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(value ?? "")}; path=/`;
      return { area, set: key };
    }
    if (action === "delete") {
      if (!key) throw new Error("storage delete cookie requires key");
      document.cookie = `${encodeURIComponent(key)}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
      return { area, deleted: key };
    }
    if (action === "clear") {
      for (const k of Object.keys(readCookies()))
        document.cookie = `${encodeURIComponent(k)}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
      return { area, cleared: true };
    }
  }
  const store = area === "session" ? sessionStorage : localStorage;
  if (action === "get") return key != null ? { area, key, value: store.getItem(key) } : { area, items: dumpStore(store) };
  if (action === "set") {
    if (!key) throw new Error("storage set requires key");
    store.setItem(key, value ?? "");
    return { area, set: key };
  }
  if (action === "delete") {
    if (!key) throw new Error("storage delete requires key");
    store.removeItem(key);
    return { area, deleted: key };
  }
  if (action === "clear") {
    store.clear();
    return { area, cleared: true };
  }
  throw new Error(`Unknown storage action: ${action}`);
}
async function doCache(args) {
  const action = String(args.action || "list");
  if (typeof caches === "undefined") return { supported: false, reason: "Cache Storage API unavailable." };
  const names = await caches.keys();
  if (action === "clear") {
    const name = args.name;
    if (name) {
      const ok = await caches.delete(name);
      return { cleared: ok ? [name] : [], notFound: ok ? [] : [name] };
    }
    await Promise.all(names.map((n) => caches.delete(n)));
    return { cleared: names };
  }
  const detail = await Promise.all(
    names.map(async (n) => {
      const c = await caches.open(n);
      const reqs = await c.keys();
      return { name: n, entries: reqs.length, urls: reqs.slice(0, 50).map((r) => r.url) };
    })
  );
  return { caches: detail };
}
async function doEval(code) {
  const fn = new Function(`"use strict"; return (async () => { ${/\breturn\b/.test(code) ? code : "return (" + code + ")"} })();`);
  let value;
  try {
    value = await fn();
  } catch (e) {
    throw new Error(`eval error: ${e instanceof Error ? e.message : String(e)}`);
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (serialized && serialized.length > 2e4) serialized = serialized.slice(0, 2e4) + "\u2026[truncated]";
  return { type: typeof value, value: serialized === void 0 ? null : JSON.parse(serialized ?? "null") };
}
async function doScreenshot(args) {
  const selector = args.selector;
  const target = selector ? document.querySelector(selector) : document.body;
  if (!target) throw new Error(`No element matches selector: ${selector}`);
  let html2canvas;
  try {
    const mod = await import(
      /* webpackIgnore: true */
      "https://esm.sh/html2canvas@1.4.1"
    );
    html2canvas = mod.default;
  } catch (e) {
    return {
      supported: false,
      reason: "Could not load html2canvas (needs network access to esm.sh). In-page capture has no headless fallback.",
      error: e instanceof Error ? e.message : String(e)
    };
  }
  const canvas = await html2canvas(target, { logging: false, scale: Number(args.scale) || 1 });
  const dataUrl = canvas.toDataURL("image/png");
  return { format: "png", width: canvas.width, height: canvas.height, dataUrl };
}
function el(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`No element matches selector: ${selector}`);
  return node;
}
function doOpenTab(url) {
  const target = url.startsWith("http") ? url : location.origin + (url.startsWith("/") ? url : "/" + url);
  const w = window.open(target, "_blank");
  if (!w) {
    return {
      opened: false,
      url: target,
      error: "window.open was blocked (popup blocker). Allow popups for this origin, or open the tab manually."
    };
  }
  return { opened: true, url: target, note: "New tab opening; call list_tabs to get its tabId once connected." };
}
function doClick(selector) {
  const node = el(selector);
  node.scrollIntoView({ block: "center" });
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  return { clicked: selector };
}
function setControlValue(node, value) {
  const tag = node.tagName.toLowerCase();
  if (tag === "select") {
    const sel = node;
    const opts = Array.from(sel.options);
    let opt = opts.find((o) => o.value === value) || opts.find((o) => o.text.trim().toLowerCase() === value.trim().toLowerCase()) || opts.find((o) => o.text.trim().toLowerCase().includes(value.trim().toLowerCase()));
    if (!opt) throw new Error(`No <option> matching "${value}" (have: ${opts.map((o) => o.text.trim()).slice(0, 8).join(", ")})`);
    nativeSet(sel, "value", opt.value);
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return `selected "${opt.text.trim()}"`;
  }
  if (tag === "input") {
    const input = node;
    const type = (input.type || "text").toLowerCase();
    if (type === "checkbox") {
      const want = /^(true|1|on|yes|checked)$/i.test(value.trim());
      if (input.checked !== want) input.click();
      return `checkbox ${input.checked ? "checked" : "unchecked"}`;
    }
    if (type === "radio") {
      const group = input.name ? Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(input.name)}"]`)) : [input];
      const target = group.find((r) => r.value === value) || group.find((r) => (r.labels?.[0]?.textContent || "").trim().toLowerCase() === value.trim().toLowerCase()) || input;
      if (!target.checked) target.click();
      return `radio "${target.value}" selected`;
    }
    if (type === "date" || type === "datetime-local" || type === "time" || type === "month" || type === "week") {
      const v = normalizeDateValue(type, value);
      nativeSet(input, "value", v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return `set ${type} to "${v}"`;
    }
    if (type === "file") {
      throw new Error("file inputs cannot be set programmatically (OS picker); use the upload tool path");
    }
    nativeSet(input, "value", value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return `typed "${value}"`;
  }
  if (tag === "textarea") {
    nativeSet(node, "value", value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return `typed "${value}"`;
  }
  if (node.isContentEditable) {
    node.focus();
    node.textContent = value;
    node.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return `set contenteditable text`;
  }
  throw new Error(`Don't know how to fill <${tag}> \u2014 not a known input type`);
}
function reactPropsOf(node) {
  for (const k in node) {
    if (k.startsWith("__reactProps$")) return node[k];
  }
  return null;
}
function doSetField(selector, value) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`No element matches selector: ${selector}`);
  const fired = [];
  try {
    node.focus?.();
    if ("value" in node) {
      nativeSet(node, "value", value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      fired.push("dom-native-setter");
    }
  } catch {
  }
  const props = reactPropsOf(node);
  if (props && typeof props.onChange === "function") {
    try {
      props.onChange({
        target: node,
        currentTarget: node,
        type: "change",
        bubbles: true,
        preventDefault() {
        },
        stopPropagation() {
        },
        persist() {
        }
      });
      fired.push("react-onChange");
    } catch (e) {
      fired.push(`react-onChange-threw:${e instanceof Error ? e.message : "err"}`);
    }
  }
  if (!fired.length) throw new Error("Could not set field via DOM or React onChange.");
  return { setField: selector, value, via: fired };
}
function nativeSet(node, prop, v) {
  const tag = node.tagName.toLowerCase();
  const proto = tag === "select" ? HTMLSelectElement.prototype : tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, prop)?.set;
  if (setter) setter.call(node, v);
  else node[prop] = v;
}
function normalizeDateValue(type, value) {
  const v = value.trim();
  if (type === "time") return v;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return type === "datetime-local" ? v.replace(" ", "T").slice(0, 16) : v.slice(0, type === "month" ? 7 : 10);
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (type === "month") return ymd.slice(0, 7);
  if (type === "datetime-local") return `${ymd}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return ymd;
}
function doFill(selector, value) {
  const node = el(selector);
  if (isComposedWidget(node)) {
    return doSelectOption(selector, value);
  }
  node.focus();
  const detail = setControlValue(node, value);
  return { filled: selector, value, detail };
}
function isComposedWidget(node) {
  const tag = node.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return false;
  if (node.isContentEditable) return false;
  const role = node.getAttribute("role") || "";
  if (/combobox|listbox|button|switch/.test(role)) return true;
  if (node.closest('.MuiSelect-root, .MuiAutocomplete-root, [class*="select" i], [data-radix-select-trigger], [data-state]')) return true;
  return !node.querySelector("input, textarea, select");
}
async function doSelectOption(selector, value) {
  const trigger = document.querySelector(selector);
  if (!trigger) throw new Error(`No element matches selector: ${selector}`);
  const innerInput = (trigger.matches("input") ? trigger : trigger.querySelector("input")) || trigger.closest(".MuiAutocomplete-root")?.querySelector("input");
  if (innerInput && (innerInput.getAttribute("role") === "combobox" || trigger.closest(".MuiAutocomplete-root"))) {
    innerInput.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(innerInput, value);
    innerInput.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(250);
  } else {
    openWidget(trigger);
    await wait(120);
  }
  const opt = await waitForOption(value, 2500);
  if (!opt) {
    const avail = currentOptions().slice(0, 10).map((o) => optText(o));
    throw new Error(`No option matching "${value}". Available: ${avail.join(" | ") || "(none visible)"}`);
  }
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    opt.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  }
  await wait(80);
  return { selected: optText(opt), via: "select_option", selector };
}
function openWidget(el2) {
  el2.scrollIntoView({ block: "center" });
  for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    el2.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  }
}
var OPTION_SEL = '[role="option"], [role="listbox"] li, .MuiAutocomplete-option, .MuiMenuItem-root, [data-radix-collection-item]';
function currentOptions() {
  return [...document.querySelectorAll(OPTION_SEL)].filter((o) => o.offsetParent !== null);
}
function optText(o) {
  return (o.getAttribute("aria-label") || o.textContent || "").trim();
}
function optMatches(o, value) {
  const v = value.trim().toLowerCase();
  const txt = optText(o).toLowerCase();
  const dv = (o.getAttribute("data-value") || o.getAttribute("value") || "").toLowerCase();
  return txt === v || dv === v;
}
async function waitForOption(value, timeoutMs) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const opts = currentOptions();
    if (opts.length) {
      const exact = opts.find((o) => optMatches(o, value));
      if (exact) return exact;
      const partial = opts.find((o) => optText(o).toLowerCase().includes(value.trim().toLowerCase()));
      if (partial) return partial;
    }
    await wait(100);
  }
  return null;
}
function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function cssPath(node) {
  if (node.id) return `#${CSS.escape(node.id)}`;
  const parts = [];
  let cur = node;
  while (cur && cur.nodeType === 1 && parts.length < 5) {
    let part = cur.tagName.toLowerCase();
    const parent = cur.parentElement;
    const self = cur;
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
  return parts.join(" > ");
}
var LOCALES = /* @__PURE__ */ new Set(["en", "fr", "es", "de", "ar", "zh", "hi", "pt", "ru", "ja"]);
function doPageContext() {
  const segs = location.pathname.split("/").filter(Boolean);
  const locale = segs[0] && LOCALES.has(segs[0]) ? segs[0] : null;
  const h1 = document.querySelector('h1, [role="heading"][aria-level="1"]');
  return {
    url: location.href,
    pathname: location.pathname,
    locale,
    title: document.title,
    heading: (h1?.textContent || "").trim().slice(0, 120) || null
  };
}
function labelFor(e) {
  const id = e.getAttribute("id");
  if (id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (lbl?.textContent?.trim()) return lbl.textContent.trim();
  }
  const labelledby = e.getAttribute("aria-labelledby");
  if (labelledby) {
    const txt = labelledby.split(/\s+/).map((lid) => document.getElementById(lid)?.textContent?.trim() || "").filter(Boolean).join(" ");
    if (txt) return txt;
  }
  const aria = e.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim();
  const wrap = e.closest("label");
  if (wrap?.textContent?.trim()) return wrap.textContent.trim();
  const ph = e.placeholder;
  if (ph?.trim()) return ph.trim();
  const nm = e.getAttribute("name");
  return nm || null;
}
function stableSelector(e) {
  if (e.id) return `#${CSS.escape(e.id)}`;
  const name = e.getAttribute("name");
  if (name) {
    const tag = e.tagName.toLowerCase();
    const sameName = document.querySelectorAll(`${tag}[name="${CSS.escape(name)}"]`);
    if (sameName.length === 1) return `${tag}[name="${CSS.escape(name)}"]`;
  }
  return cssPath(e);
}
var FIELD_SEL = "input, textarea, select";
function describeField(e, formName) {
  const tag = e.tagName.toLowerCase();
  const input = e;
  const type = tag === "select" ? "select" : tag === "textarea" ? "textarea" : input.type || "text";
  const field = {
    label: labelFor(e),
    name: e.getAttribute("name") || null,
    id: e.getAttribute("id") || null,
    type,
    required: input.required || e.getAttribute("aria-required") === "true",
    disabled: input.disabled || e.getAttribute("aria-disabled") === "true",
    selector: stableSelector(e),
    formName
  };
  if (type === "checkbox" || type === "radio") {
    field.value = input.value;
    field.checked = input.checked;
  } else {
    field.value = input.value ?? "";
  }
  if ((input.placeholder ?? "").trim()) field.placeholder = input.placeholder.trim();
  if (tag === "select") {
    const sel = e;
    field.options = Array.from(sel.options).map((o) => ({ value: o.value, label: o.text.trim() }));
    field.value = sel.value;
  }
  return field;
}
function valuesMap(fields) {
  const out = {};
  for (const f of fields) {
    const key = f.name || f.id || f.label;
    if (!key) continue;
    out[key] = f.type === "checkbox" || f.type === "radio" ? f.checked : f.value;
  }
  return out;
}
function describeAction(e) {
  const tag = e.tagName.toLowerCase();
  const role = e.getAttribute("role") || (tag === "a" ? "link" : "button");
  const text = (e.getAttribute("aria-label") || e.textContent || e.value || "").trim().slice(0, 80);
  const action = {
    text,
    role,
    selector: stableSelector(e),
    disabled: e.disabled || e.getAttribute("aria-disabled") === "true"
  };
  if (tag === "a") action.href = e.getAttribute("href");
  const t = e.type;
  if (t) action.type = t;
  return action;
}
function fiberOf(node) {
  for (const key in node) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
      return node[key];
    }
  }
  return null;
}
function componentName(fiber) {
  const t = fiber?.type;
  if (!t) return null;
  if (typeof t === "string") return null;
  if (typeof t === "function") return t.displayName || t.name || "Anonymous";
  if (t.displayName) return t.displayName;
  if (t.render) return t.render.displayName || t.render.name || "ForwardRef";
  if (t.type) return componentName({ type: t.type });
  return "Anonymous";
}
function hookShape(fiber) {
  let count = 0;
  let hasState = false;
  let hasEffect = false;
  let hook = fiber?.memoizedState;
  if (typeof fiber?.type !== "function") return { count: 0, hasState: false, hasEffect: false };
  let guard = 0;
  while (hook && typeof hook === "object" && "next" in hook && guard < 200) {
    count++;
    if (hook.queue) hasState = true;
    if (hook.memoizedState && hook.memoizedState.tag !== void 0 && hook.memoizedState.create) hasEffect = true;
    hook = hook.next;
    guard++;
  }
  return { count, hasState, hasEffect };
}
function collectComponents(root, maxNodes = 600) {
  const out = [];
  const stack = [{ fiber: root, depth: 0 }];
  let seen = 0;
  while (stack.length && seen < maxNodes) {
    const { fiber, depth } = stack.pop();
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
function rootFiber() {
  const probe = document.querySelector("#__next, [data-reactroot], main, body > div") || document.body.firstElementChild;
  let f = probe ? fiberOf(probe) : null;
  if (!f) {
    const any = [...document.querySelectorAll("*")].slice(0, 50).map(fiberOf).find(Boolean);
    f = any || null;
  }
  while (f && f.return) f = f.return;
  return f;
}
function doComponents(args) {
  const sel = args.selector;
  let start = null;
  if (sel) {
    const node = document.querySelector(sel);
    if (!node) throw new Error(`No element matches selector: ${sel}`);
    start = fiberOf(node);
  } else {
    start = rootFiber();
  }
  if (!start) {
    return { supported: false, reason: "No React fiber found (production build or pre-hydration).", components: [] };
  }
  const list = collectComponents(start);
  const byName = {};
  for (const c of list) byName[c.name] = (byName[c.name] || 0) + 1;
  return {
    supported: true,
    note: "React 19: source file/line and hook names are unavailable from fibers; hook shape is inferred.",
    total: list.length,
    unique: Object.keys(byName).length,
    summary: Object.entries(byName).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    tree: list.slice(0, 300)
  };
}
function doComponentFor(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`No element matches selector: ${selector}`);
  let f = fiberOf(node);
  if (!f) return { supported: false, reason: "No React fiber on this element.", chain: [] };
  const chain = [];
  let guard = 0;
  while (f && guard < 80) {
    const name = componentName(f);
    if (name) chain.push({ name, hooks: hookShape(f) });
    f = f.return;
    guard++;
  }
  return { supported: true, selector, owner: chain[0]?.name || null, chain: chain.slice(0, 25) };
}
function doRerender(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`No element matches selector: ${selector}`);
  let f = fiberOf(node);
  while (f && typeof f.type !== "function") f = f.return;
  if (!f) return { ok: false, reason: "No function component owns this element." };
  const name = componentName(f);
  let hook = f.memoizedState;
  let guard = 0;
  while (hook && guard < 200) {
    if (hook.queue && typeof hook.queue.dispatch === "function") {
      const cur = hook.memoizedState;
      hook.queue.dispatch(cur);
      return { ok: true, component: name, via: "state-dispatch" };
    }
    hook = hook.next;
    guard++;
  }
  return { ok: false, component: name, reason: "Component has no state hook to nudge; cannot force rerender safely." };
}
function doSnapshot() {
  const inHud = (n) => !!n.closest("[data-agent-bridge-hud]");
  const formEls = [...document.querySelectorAll("form")].filter((f) => !inHud(f));
  const seenInForm = /* @__PURE__ */ new Set();
  const forms = formEls.map((f, i) => {
    const formName = f.getAttribute("name") || f.getAttribute("id") || f.getAttribute("aria-label") || `form#${i + 1}`;
    const ctrls = [...f.querySelectorAll(FIELD_SEL)].filter((n) => !inHud(n));
    ctrls.forEach((c) => seenInForm.add(c));
    const submitEl = f.querySelector('button[type="submit"], input[type="submit"], [role="button"][type="submit"]') || f.querySelector("button:not([type])") || null;
    const fieldObjs = ctrls.map((c) => describeField(c, formName));
    return {
      name: formName,
      selector: stableSelector(f),
      submit: submitEl ? describeAction(submitEl) : null,
      fields: fieldObjs,
      // Flat current-state map: { identifier: currentValue }. Identifier is name||id||label.
      values: valuesMap(fieldObjs)
    };
  });
  const allCtrls = [...document.querySelectorAll(FIELD_SEL)].filter((n) => !inHud(n)).slice(0, 400);
  const fields = allCtrls.map((c) => {
    const owner = c.closest("form");
    const formName = owner ? owner.getAttribute("name") || owner.getAttribute("id") || owner.getAttribute("aria-label") || null : null;
    return describeField(c, formName);
  });
  const ACTION_SEL = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"]';
  const actionEls = [...document.querySelectorAll(ACTION_SEL)].filter((n) => !inHud(n)).slice(0, 200);
  const actions = actionEls.map(describeAction).filter((a) => a.text || a.href);
  const values = {};
  for (const f of forms) values[f.name] = f.values;
  const loose = fields.filter((f) => !f.formName);
  if (loose.length) values._ = valuesMap(loose);
  return {
    route: doPageContext(),
    counts: { fields: fields.length, forms: forms.length, actions: actions.length },
    forms,
    fields,
    actions,
    values
  };
}
function inHudEl(n) {
  return !!n.closest("[data-agent-bridge-hud]");
}
function visible(e) {
  const el2 = e;
  if (inHudEl(e)) return false;
  const r = el2.getBoundingClientRect();
  return r.width > 0 || r.height > 0 || el2.offsetParent !== null;
}
function regionItems(root, cap = 40) {
  const els = [...root.querySelectorAll('a[href], button, [role="link"], [role="button"], [role="menuitem"], [role="tab"]')].filter((n) => !inHudEl(n)).slice(0, cap);
  return els.map((e) => {
    const text = (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 60);
    const item = { text, selector: stableSelector(e) };
    const href = e.getAttribute?.("href");
    if (href) item.href = href;
    return item;
  }).filter((i) => i.text || i.href);
}
function regionFor(sel, root) {
  if (!root || !visible(root)) return null;
  return { selector: stableSelector(root), items: regionItems(root) };
}
function doOverview() {
  const headerEl = document.querySelector('header, [role="banner"]');
  const header = regionFor("header", headerEl);
  const footerEl = document.querySelector('footer, [role="contentinfo"]');
  const footer = regionFor("footer", footerEl);
  const navs = [...document.querySelectorAll('nav, [role="navigation"]')].filter(visible).slice(0, 6).map((n) => ({
    label: (n.getAttribute("aria-label") || "").trim() || null,
    selector: stableSelector(n),
    items: regionItems(n, 30)
  }));
  const sidebarEls = [
    ...document.querySelectorAll('aside, [role="complementary"], [class*="sidebar" i], [data-sidebar], [class*="drawer" i]')
  ].filter(visible).slice(0, 4);
  const sidebars = sidebarEls.map((s) => ({
    selector: stableSelector(s),
    label: (s.getAttribute("aria-label") || "").trim() || null,
    items: regionItems(s, 40)
  }));
  const sections = [...document.querySelectorAll('section, [role="region"], main [aria-labelledby], main > div[class*="section" i]')].filter(visible).slice(0, 20).map((s) => {
    const h = s.querySelector('h1, h2, h3, [role="heading"]');
    return {
      heading: (h?.textContent || s.getAttribute("aria-label") || "").trim().slice(0, 80) || null,
      selector: stableSelector(s)
    };
  }).filter((s) => s.heading);
  const tabLists = [...document.querySelectorAll('[role="tablist"]')].filter(visible).slice(0, 6).map((tl) => {
    const tabs = [...tl.querySelectorAll('[role="tab"]')].filter((t) => !inHudEl(t)).map((t) => ({
      text: (t.textContent || "").trim().slice(0, 50),
      selected: t.getAttribute("aria-selected") === "true",
      selector: stableSelector(t)
    }));
    return { selector: stableSelector(tl), activeTab: tabs.find((x) => x.selected)?.text || null, tabs };
  });
  const headings = [...document.querySelectorAll("h1, h2, h3")].filter(visible).slice(0, 40).map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent || "").trim().slice(0, 90) })).filter((h) => h.text);
  const openOverlays = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], dialog[open], [aria-modal="true"]')].filter(visible).slice(0, 8).map((o) => ({
    role: o.getAttribute("role") || o.tagName.toLowerCase(),
    label: (o.getAttribute("aria-label") || o.querySelector('h1,h2,h3,[role="heading"]')?.textContent || "").trim().slice(0, 80) || null,
    selector: stableSelector(o)
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
      openOverlays: openOverlays.length
    }
  };
}
async function doWaitFor(args) {
  const timeoutMs = Number(args.timeoutMs) || 5e3;
  const selector = args.selector;
  const text = args.text;
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (selector && document.querySelector(selector)) return { matched: "selector", selector };
    if (text && document.body.innerText.includes(text)) return { matched: "text", text };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`wait_for timed out after ${timeoutMs}ms (${selector ? `selector=${selector}` : ""}${text ? ` text=${text}` : ""})`);
}
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}
export {
  AgentBridge
};
