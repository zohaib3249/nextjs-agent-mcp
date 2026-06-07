// Pre-build the bridge .tsx -> dist .js (ESM) so the consuming Next.js app can resolve
// `nextjs-agent-mcp/bridge` reliably. Turbopack does NOT reliably resolve a symlinked
// package's `exports` subpath pointing at a bare .tsx; plain .js resolves cleanly.
//
// - React/react-dom stay EXTERNAL (the host app provides them).
// - The `'use client'` directive is preserved via an esbuild banner so the host
//   compiles the component as a Client Component (it uses useEffect + WebSocket).
import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const bridgeDir = join(root, 'bridge');
mkdirSync(bridgeDir, { recursive: true });

await build({
  entryPoints: [join(root, 'bridge', 'src', 'index.tsx')],
  outfile: join(bridgeDir, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  // React is provided by the host app — never bundle it.
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  // Keep the client directive at the very top of the emitted module.
  banner: { js: "'use client';" },
  legalComments: 'none',
  logLevel: 'info',
});

// Minimal type declaration so TS consumers see AgentBridge.
writeFileSync(
  join(bridgeDir, 'index.d.ts'),
  `import type { FC } from 'react';\nexport declare const AgentBridge: FC;\n`
);

// A physical bridge/package.json makes `nextjs-agent-mcp/bridge` resolvable by DIRECTORY,
// not just via the parent package's `exports` map. Turbopack honors this even through a
// `file:` symlink, where it does not reliably follow conditional `exports` subpaths.
writeFileSync(
  join(bridgeDir, 'package.json'),
  JSON.stringify({ name: 'nextjs-agent-mcp-bridge', private: true, main: 'index.js', types: 'index.d.ts' }, null, 2) + '\n'
);

console.error('[nextjs-agent-mcp] bridge built -> bridge/index.js');
