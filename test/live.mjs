// Live Mode-B driver: spawn the MCP (which binds the WS bridge on --ws-port), wait for a real
// browser tab to connect, then exercise page_context + snapshot + components and print results.
//
//   node test/live.mjs <project> [ws-port]
//
// Requires: your Next.js dev server running AND a browser tab open on it (e.g. http://localhost:3000)
// with <AgentBridge/> mounted, so the in-page bridge connects to this process's WS server.
import { spawn } from 'node:child_process';

const PROJECT = process.argv[2];
if (!PROJECT) {
  console.error('Usage: node test/live.mjs /path/to/your-next-app [ws-port]');
  process.exit(1);
}
const WS_PORT = process.argv[3] || '7333';

const child = spawn('node', ['src/index.js', '--project', PROJECT, '--ws-port', WS_PORT], {
  cwd: new URL('..', import.meta.url).pathname,
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
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      /* ignore non-JSON */
    }
  }
});

let id = 0;
function rpc(method, params) {
  const myId = ++id;
  return new Promise((res) => {
    pending.set(myId, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
}
const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return JSON.parse(r.result.content[0].text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'live', version: '0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = await rpc('tools/list', {});
  console.log('TOOLS:', tools.result.tools.map((t) => t.name).join(', '));

  // Wait for a browser tab to connect.
  console.log(`\nWaiting for a browser tab to connect on ws://localhost:${WS_PORT} …`);
  let connected = false;
  for (let t = 0; t < 60; t++) {
    const st = await call('bridge_status');
    if (st.connectedTabs && st.connectedTabs.length) {
      console.log('CONNECTED:', JSON.stringify(st.connectedTabs));
      connected = true;
      break;
    }
    await sleep(1000);
  }
  if (!connected) {
    console.log('No tab connected after 60s. Open http://localhost:3000/en in a browser.');
    child.kill('SIGTERM');
    process.exit(1);
  }

  console.log('\n--- page_context ---');
  console.log(JSON.stringify(await call('page_context'), null, 2));

  console.log('\n--- snapshot (counts + first form + values) ---');
  const snap = await call('snapshot');
  console.log('counts:', JSON.stringify(snap.counts));
  console.log('values:', JSON.stringify(snap.values, null, 2)?.slice(0, 1200));
  if (snap.forms?.[0]) {
    const f = snap.forms[0];
    console.log('form[0]:', f.name, '— fields:', f.fields.map((x) => `${x.name || x.id}:${x.type}`).join(', '));
    console.log('  submit:', JSON.stringify(f.submit));
  }
  console.log('first 8 fields:', JSON.stringify(snap.fields.slice(0, 8), null, 2)?.slice(0, 1500));
  console.log('first 6 actions:', JSON.stringify(snap.actions.slice(0, 6)));

  console.log('\n--- components (summary) ---');
  const comp = await call('components');
  console.log('supported:', comp.supported, '| total:', comp.total, '| unique:', comp.unique);
  console.log('top components:', JSON.stringify(comp.summary?.slice(0, 12)));

  console.log('\n--- console_messages ---');
  console.log(JSON.stringify(await call('console_messages'), null, 2)?.slice(0, 600));

  console.log('\n✓ Live introspection done.');
  child.kill('SIGTERM');
  process.exit(0);
})();
