// ChromeController — manage a real Chrome via the DevTools Protocol (CDP), WITHOUT Playwright/
// puppeteer. Uses only Node built-ins + Chrome's HTTP debugging endpoints, so the package stays
// light. This is the layer that can do what in-page JS cannot: open browser PROFILES, list ALL
// open tabs, and open/close/activate tabs across the whole browser.
//
// CDP HTTP endpoints (on the --remote-debugging-port):
//   GET  /json/version            → browser info
//   GET  /json   (or /json/list)  → [{id,type,title,url,webSocketDebuggerUrl}, …]  (one per tab)
//   PUT  /json/new?<url>          → open a new tab
//   GET  /json/activate/<id>      → focus a tab
//   GET  /json/close/<id>         → close a tab
//
// Launch opens Chrome with a chosen --user-data-dir (a "profile" dir). Different dirs = different
// profiles/sessions (cookies, logins, etc.) kept side by side.
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { existsSync } from 'node:fs';

const DEFAULT_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

function findChrome(explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  return DEFAULT_CHROME_PATHS.find((p) => existsSync(p)) || null;
}

// Tiny HTTP GET/PUT helper for the CDP endpoints (localhost only).
function http(method, port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          resolve(body);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('CDP request timed out')));
    req.end();
  });
}

export class ChromeController {
  constructor({ port = 9222, chromePath = null } = {}) {
    this.port = port;
    this.chromePath = chromePath;
    this.proc = null; // set if WE launched Chrome
    this.profileDir = null;
  }

  // Is a debuggable Chrome reachable on our port?
  async isUp() {
    try {
      await http('GET', this.port, '/json/version');
      return true;
    } catch {
      return false;
    }
  }

  // Launch Chrome with remote debugging + a profile dir (or attach if one is already up on the port).
  // `profile` is a directory path (a "profile"); omit for a default temp profile.
  async launch({ profile = null, url = null, headless = false } = {}) {
    if (await this.isUp()) {
      return { attached: true, port: this.port, note: 'Chrome already debuggable on this port — attached.' };
    }
    const bin = findChrome(this.chromePath);
    if (!bin) {
      return { ok: false, error: 'Chrome/Chromium not found. Set CHROME_PATH or pass chromePath.' };
    }
    this.profileDir = profile || `/tmp/nextjs-agent-chrome-${this.port}`;
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(headless ? ['--headless=new'] : []),
      ...(url ? [url] : ['about:blank']),
    ];
    this.proc = spawn(bin, args, { detached: false, stdio: 'ignore' });
    this.proc.on('exit', () => {
      this.proc = null;
    });
    // Wait for the debug endpoint to come up.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (await this.isUp()) {
        const ver = await http('GET', this.port, '/json/version');
        return { launched: true, port: this.port, profileDir: this.profileDir, browser: ver.Browser };
      }
    }
    return { ok: false, error: 'Chrome launched but the debug port never came up.' };
  }

  // List every open tab/page in the browser.
  async tabs() {
    if (!(await this.isUp())) return { ok: false, error: `No debuggable Chrome on port ${this.port}. Launch or attach first.` };
    const list = await http('GET', this.port, '/json');
    const tabs = (Array.isArray(list) ? list : [])
      .filter((t) => t.type === 'page')
      .map((t) => ({ id: t.id, title: t.title, url: t.url, active: !!t.active }));
    return { ok: true, port: this.port, count: tabs.length, tabs };
  }

  async openTab(url) {
    if (!(await this.isUp())) return { ok: false, error: `No debuggable Chrome on port ${this.port}.` };
    const t = await http('PUT', this.port, `/json/new?${encodeURIComponent(url || 'about:blank')}`);
    return { ok: true, opened: { id: t.id, url: t.url, title: t.title } };
  }

  async activateTab(id) {
    if (!(await this.isUp())) return { ok: false, error: `No debuggable Chrome on port ${this.port}.` };
    await http('GET', this.port, `/json/activate/${id}`);
    return { ok: true, activated: id };
  }

  async closeTab(id) {
    if (!(await this.isUp())) return { ok: false, error: `No debuggable Chrome on port ${this.port}.` };
    await http('GET', this.port, `/json/close/${id}`);
    return { ok: true, closed: id };
  }

  status() {
    return { port: this.port, launchedByUs: !!this.proc, profileDir: this.profileDir };
  }
}
