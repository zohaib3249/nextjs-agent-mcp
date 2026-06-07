// Mode A — capture structured errors from the Next.js dev server.
//
// Strategy for Phase 1: the MCP optionally OWNS the dev server as a child process
// (`npm run dev`) and parses its stdout/stderr into structured error records.
// If the user already runs their own dev server, they can instead point the MCP at a
// log file via attachLogFile(). Either way the same parser produces the records.
//
// We parse the common Next 16 / Turbopack output shapes:
//   - compile errors / module-not-found (./path  Error: ...)
//   - "⨯" runtime/server errors with a stack
//   - "Error: ..." blocks
//   - hydration mismatch warnings
// This is heuristic by design; Next does not emit a stable machine error stream, so we
// normalize what it prints. Version-pinned to Next 16.2.x (see SPEC §7).
import { spawn } from 'node:child_process';
import { createReadStream, watch } from 'node:fs';
import { createInterface } from 'node:readline';

const MAX_ERRORS = 500;

export class ErrorTracker {
  constructor() {
    this.errors = [];
    this.child = null;
    this._buffer = [];
    this._seq = 0;
  }

  _push(record) {
    record.id = ++this._seq;
    record.ts = Date.now();
    this.errors.push(record);
    if (this.errors.length > MAX_ERRORS) this.errors.shift();
  }

  // Feed a single raw line through the heuristic classifier.
  ingestLine(line) {
    const clean = stripAnsi(line);
    this._buffer.push(clean);
    if (this._buffer.length > 40) this._buffer.shift();

    if (/^\s*⨯/.test(clean) || /\bUnhandled (Runtime )?Error\b/.test(clean)) {
      this._push({ type: 'runtime', message: clean.replace(/^\s*⨯\s*/, '').trim(), context: this._buffer.slice(-8) });
      return;
    }
    if (/Module not found/i.test(clean)) {
      const file = matchFirst(this._buffer, /^\s*\.?\/?\S+\.(tsx?|jsx?|css)\b/);
      this._push({ type: 'module-not-found', message: clean.trim(), file });
      return;
    }
    if (/Hydration failed|hydration mismatch|did not match/i.test(clean)) {
      this._push({ type: 'hydration', message: clean.trim(), context: this._buffer.slice(-6) });
      return;
    }
    if (/^\s*(Type ?error|SyntaxError|Failed to compile)/i.test(clean) || /^\s*Error:/.test(clean)) {
      const loc = matchLocation(this._buffer);
      this._push({ type: 'compile', message: clean.trim(), ...loc });
      return;
    }
  }

  // Spawn `npm run dev` (or the given command) for the project and tail its output.
  startDevServer(project, { command = 'npm', args = ['run', 'dev'], env = {} } = {}) {
    if (this.child) return { alreadyRunning: true, pid: this.child.pid };
    this.child = spawn(command, args, {
      cwd: project,
      env: { ...process.env, ...env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const wire = (stream) => {
      const rl = createInterface({ input: stream });
      rl.on('line', (l) => this.ingestLine(l));
    };
    wire(this.child.stdout);
    wire(this.child.stderr);
    this.child.on('exit', (code) => {
      this._push({ type: 'dev-server', message: `dev server exited with code ${code}` });
      this.child = null;
    });
    return { started: true, pid: this.child.pid };
  }

  // Alternative: tail an existing log file the user redirects their dev server into.
  attachLogFile(path) {
    const stream = createReadStream(path, { encoding: 'utf8' });
    const rl = createInterface({ input: stream });
    rl.on('line', (l) => this.ingestLine(l));
    watch(path, () => {}); // keep handle; simple v1 — full tail-follow is Phase 5 hardening
    return { attached: path };
  }

  list({ since } = {}) {
    const items = since ? this.errors.filter((e) => e.id > since) : this.errors;
    return { count: items.length, lastId: this._seq, errors: items };
  }

  stop() {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
      return { stopped: true };
    }
    return { stopped: false };
  }
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

function matchFirst(lines, re) {
  for (const l of lines) {
    const m = l.match(re);
    if (m) return m[0].trim();
  }
  return undefined;
}

function matchLocation(lines) {
  // Look for "file:line:col" patterns common in Next/Turbopack output.
  for (const l of lines) {
    const m = l.match(/(\.?\/?[\w./[\]@-]+\.(?:tsx?|jsx?|css)):(\d+):(\d+)/);
    if (m) return { file: m[1], line: Number(m[2]), column: Number(m[3]) };
  }
  return {};
}
