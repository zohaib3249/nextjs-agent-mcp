'use client';

// bridge/src/agent-bridge.client.tsx
import { useEffect, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
var WS_PORT = Number(process.env.NEXT_PUBLIC_AGENT_BRIDGE_PORT) || 7333;
function getTabId() {
  try {
    const k = "__agent_bridge_tab_id";
    let v = sessionStorage.getItem(k);
    if (!v) {
      v = "tab-" + Math.random().toString(36).slice(2, 8) + "-" + Date.now() % 1e5;
      sessionStorage.setItem(k, v);
    }
    return v;
  } catch {
    return "tab-" + Math.random().toString(36).slice(2, 8);
  }
}
var TAB_ID = typeof window !== "undefined" ? getTabId() : "tab-ssr";
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
function AgentBridge() {
  const [status, setStatus] = useState("connecting");
  const [feed, setFeed] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let ws = null;
    let closed = false;
    let retry = null;
    let feedSeq = 0;
    const pushFeed = (op, detail) => {
      const fid = ++feedSeq;
      const item = { id: fid, op, detail, state: "running", ts: Date.now() };
      setFeed((f) => [item, ...f].slice(0, 8));
      return fid;
    };
    const settleFeed = (fid, state) => setFeed((f) => f.map((it) => it.id === fid ? { ...it, state } : it));
    const connect = () => {
      if (closed) return;
      setStatus("connecting");
      try {
        ws = new WebSocket(`ws://localhost:${WS_PORT}`);
      } catch {
        retry = setTimeout(connect, 1500);
        return;
      }
      ws.onopen = () => {
        setStatus("connected");
        ws.send(
          JSON.stringify({
            kind: "hello",
            tabId: TAB_ID,
            url: location.href,
            pathname: location.pathname,
            title: document.title,
            userAgent: navigator.userAgent
          })
        );
      };
      ws.onmessage = async (ev) => {
        let cmd;
        try {
          cmd = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (cmd.kind !== "command") return;
        const fid = pushFeed(cmd.op, describe(cmd));
        setBusy(true);
        try {
          highlight(cmd);
          const value = await run(cmd.op, cmd.args);
          settleFeed(fid, "ok");
          send({ kind: "result", id: cmd.id, ok: true, value });
        } catch (err) {
          settleFeed(fid, "error");
          send({ kind: "result", id: cmd.id, ok: false, error: errMsg(err) });
        } finally {
          setBusy(false);
        }
      };
      ws.onclose = () => {
        ws = null;
        setStatus("disconnected");
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws?.close();
    };
    const send = (obj) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };
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
        send({ kind: "console", level: lvl, message: fmt(a) });
        orig[lvl].apply(console, a);
      };
    }
    const onError = (e) => send({ kind: "console", level: "error", message: `Uncaught ${e.message} @ ${e.filename}:${e.lineno}` });
    const onRejection = (e) => send({ kind: "console", level: "error", message: `Unhandled rejection: ${String(e.reason)}`.slice(0, 2e3) });
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
  return /* @__PURE__ */ jsx(Hud, { status, feed, busy });
}
function Hud({ status, feed, busy }) {
  const color = status === "connected" ? "#22c55e" : status === "connecting" ? "#eab308" : "#ef4444";
  const label = status === "connected" ? "Agent connected" : status === "connecting" ? "Connecting\u2026" : "Agent offline";
  return /* @__PURE__ */ jsxs(
    "div",
    {
      style: {
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 2147483647,
        font: "12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "#e5e7eb",
        background: "rgba(17,24,39,0.92)",
        border: `1px solid ${color}`,
        borderRadius: 10,
        padding: "8px 10px",
        width: 280,
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        backdropFilter: "blur(6px)",
        pointerEvents: "none",
        userSelect: "none"
      },
      "data-agent-bridge-hud": true,
      children: [
        /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: feed.length ? 6 : 0 }, children: [
          /* @__PURE__ */ jsx(
            "span",
            {
              style: {
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: color,
                boxShadow: busy ? `0 0 0 0 ${color}` : "none",
                animation: busy ? "agentPulse 1s infinite" : "none"
              }
            }
          ),
          /* @__PURE__ */ jsx("strong", { style: { color: "#fff", fontWeight: 600 }, children: "nextjs-agent" }),
          /* @__PURE__ */ jsx("span", { style: { marginLeft: "auto", color }, children: label })
        ] }),
        /* @__PURE__ */ jsx("div", { style: { color: "#6b7280", fontSize: 10, marginBottom: feed.length ? 6 : 0 }, children: TAB_ID }),
        feed.map((it) => /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 6, opacity: it.state === "running" ? 1 : 0.7, marginTop: 3 }, children: [
          /* @__PURE__ */ jsx("span", { style: { width: 12 }, children: it.state === "running" ? "\u25B8" : it.state === "ok" ? "\u2713" : "\u2717" }),
          /* @__PURE__ */ jsx("span", { style: { color: it.state === "error" ? "#fca5a5" : "#93c5fd" }, children: it.op }),
          /* @__PURE__ */ jsx("span", { style: { color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: it.detail })
        ] }, it.id)),
        /* @__PURE__ */ jsx("style", { children: `@keyframes agentPulse{0%{box-shadow:0 0 0 0 ${color}80}70%{box-shadow:0 0 0 6px ${color}00}100%{box-shadow:0 0 0 0 ${color}00}}
        @keyframes agentRing{0%{box-shadow:0 0 0 2px #38bdf8,0 0 0 6px #38bdf855}100%{box-shadow:0 0 0 2px #38bdf800,0 0 0 14px #38bdf800}}` })
      ]
    }
  );
}
function highlight(cmd) {
  const sel = cmd.args?.selector;
  if (!sel) return;
  const node = document.querySelector(sel);
  if (!node) return;
  const prev = node.style.animation;
  node.style.animation = "agentRing 0.8s ease-out";
  setTimeout(() => {
    node.style.animation = prev;
  }, 800);
}
function describe(cmd) {
  const a = cmd.args || {};
  if (cmd.op === "fill") return `${a.selector} = "${String(a.value).slice(0, 20)}"`;
  if (cmd.op === "navigate") return String(a.url);
  if (cmd.op === "wait_for") return a.selector || (a.text ? `text:"${a.text}"` : "");
  if (cmd.op === "snapshot") return "reading page\u2026";
  if (cmd.op === "page_context") return location.pathname;
  if (cmd.op === "open_tab") return `open ${String(a.url)}`;
  if (cmd.op === "reload") return a.hard ? "hard reload" : "reload";
  if (cmd.op === "network_calls") return Array.isArray(a.types) ? a.types.join(",") : "all calls";
  if (cmd.op === "storage") return `${a.area || "local"} ${a.action || "get"}${a.key ? " " + a.key : ""}`;
  if (cmd.op === "cache") return `cache ${a.action || "list"}`;
  if (cmd.op === "eval") return String(a.code).slice(0, 28);
  if (cmd.op === "screenshot") return "capturing\u2026";
  if (cmd.op === "find") return `find "${String(a.query)}"`;
  if (cmd.op === "overview") return "page overview\u2026";
  if (a.selector) return String(a.selector);
  return "";
}
async function run(op, args) {
  switch (op) {
    case "click":
      return doClick(String(args.selector));
    case "fill":
      return doFill(String(args.selector), String(args.value ?? ""));
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
      const before = location.href;
      location.assign(url);
      await new Promise((r) => setTimeout(r, 350));
      const navigatedWithinDoc = location.href !== before && document.readyState === "complete";
      return { navigated: url, sameDocument: navigatedWithinDoc, overview: doOverview() };
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
function doFill(selector, value) {
  const node = el(selector);
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  node.focus();
  if (setter) setter.call(node, value);
  else node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
  return { filled: selector, value };
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
