// Parse CLI args / env into a config object shared across the server.
//   --project <path>   absolute path to the Next.js app root (has package.json + src/app or app)
//   --ws-port <port>   WebSocket port for the Mode-B bridge (Phase 2)
import { resolve } from 'node:path';

export function loadConfig(argv = process.argv.slice(2)) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') opts.project = argv[++i];
    else if (a === '--ws-port') opts.wsPort = Number(argv[++i]);
    else if (a === '--http-port') opts.httpPort = Number(argv[++i]);
  }

  const project = resolve(opts.project || process.env.NEXTJS_MCP_PROJECT || process.cwd());
  const wsPort = opts.wsPort || Number(process.env.NEXTJS_MCP_WS_PORT) || 7333;
  // Optional local HTTP control endpoint (debug/automation): POST /op {op,args,tabId}. Off unless set.
  const httpPort = opts.httpPort || Number(process.env.NEXTJS_MCP_HTTP_PORT) || 0;

  return { project, wsPort, httpPort };
}
