// Smoke test: boot the MCP over stdio, list tools, call route_map against a Next.js project.
// Usage: node test/smoke.mjs /path/to/your-next-app
import { spawn } from 'node:child_process';

const PROJECT = process.argv[2];
if (!PROJECT) {
  console.error('Usage: node test/smoke.mjs /path/to/your-next-app');
  process.exit(1);
}

const child = spawn('node', ['src/index.js', '--project', PROJECT], {
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
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
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

const parse = (r) => JSON.parse(r.result.content[0].text);

(async () => {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = await rpc('tools/list', {});
  console.log('TOOLS:', tools.result.tools.map((t) => t.name).join(', '));

  const rm = await rpc('tools/call', { name: 'route_map', arguments: {} });
  const map = parse(rm);
  console.log(`\nROUTE_MAP: appDir=${map.appDir}`);
  console.log(`  localePrefixed=${map.localePrefixed} routeCount=${map.routeCount}`);
  console.log('  sample routes:');
  for (const r of map.routes.slice(0, 12)) console.log(`    ${r.type.padEnd(13)} ${r.path}`);

  const errs = await rpc('tools/call', { name: 'get_errors', arguments: {} });
  console.log('\nGET_ERRORS (pre-dev):', parse(errs));

  child.kill('SIGTERM');
  process.exit(0);
})();
