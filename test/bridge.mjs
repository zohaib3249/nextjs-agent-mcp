// Verify the Mode-B round-trip without a real browser: a fake WS client plays the
// role of <AgentBridge/>, answering a command the MCP dispatches.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = 7399;
// --project is irrelevant here (a fake browser answers the WS, no route reading), so point it
// at the package dir itself — this test has no external app dependency.
const ROOT = new URL('..', import.meta.url).pathname;
const child = spawn('node', ['src/index.js', '--project', ROOT, '--ws-port', String(PORT)], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
let id = 0;
const rpc = (method, params) =>
  new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
const parse = (r) => JSON.parse(r.result.content[0].text);

(async () => {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // Before any tab connects, click should report "no tab".
  const noTab = parse(await rpc('tools/call', { name: 'click', arguments: { selector: '#x' } }));
  console.log('click (no tab):', noTab.ok === false ? 'OK -> ' + noTab.error.slice(0, 40) : 'UNEXPECTED', '\n');

  // Connect a fake bridge that answers snapshot + click.
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ kind: 'hello', url: 'http://localhost:3000/en', userAgent: 'fake-bridge' }));
      setTimeout(resolve, 200);
    });
    ws.on('message', (raw) => {
      const cmd = JSON.parse(raw.toString());
      if (cmd.kind !== 'command') return;
      if (cmd.op === 'snapshot')
        ws.send(JSON.stringify({ kind: 'result', id: cmd.id, ok: true, value: { url: 'http://localhost:3000/en', title: 'Home', count: 1, items: [{ role: 'button', name: 'Checkout', selector: '#checkout' }] } }));
      else if (cmd.op === 'click') ws.send(JSON.stringify({ kind: 'result', id: cmd.id, ok: true, value: { clicked: cmd.args.selector } }));
      else ws.send(JSON.stringify({ kind: 'result', id: cmd.id, ok: false, error: 'unhandled' }));
    });
  });

  const status = parse(await rpc('tools/call', { name: 'bridge_status', arguments: {} }));
  console.log('bridge_status:', JSON.stringify(status));

  const snap = parse(await rpc('tools/call', { name: 'snapshot', arguments: {} }));
  console.log('snapshot:', JSON.stringify(snap.value));

  const click = parse(await rpc('tools/call', { name: 'click', arguments: { selector: '#checkout' } }));
  console.log('click:', JSON.stringify(click));

  child.kill('SIGTERM');
  process.exit(0);
})();
