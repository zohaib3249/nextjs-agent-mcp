// Mode A — build a route map by walking the App Router file tree.
// No browser, no running server: pure filesystem read.
//
// App Router conventions handled:
//   page.{tsx,jsx,ts,js}      -> a navigable route
//   layout / template / loading / error / not-found  -> structural (recorded as files, not routes)
//   [param]                   -> dynamic segment      :param
//   [...slug] / [[...slug]]   -> catch-all / optional  *slug
//   (group)                   -> route group: folder is ignored in the URL path
//   @slot                     -> parallel route slot: ignored in the URL path (recorded)
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const PAGE_RE = /^page\.(tsx|jsx|ts|js)$/;
const ROUTE_RE = /^route\.(ts|js)$/;
const STRUCTURAL_RE = /^(layout|template|loading|error|not-found|default|global-error)\.(tsx|jsx|ts|js)$/;

// Find the App Router root: prefer src/app, fall back to app.
export async function findAppDir(project) {
  for (const rel of ['src/app', 'app']) {
    const dir = join(project, rel);
    try {
      if ((await stat(dir)).isDirectory()) return dir;
    } catch {
      /* not here */
    }
  }
  return null;
}

// Convert a single directory segment name into its URL contribution.
// Returns null when the segment contributes nothing to the URL (groups, slots).
function segmentToUrlPart(name) {
  if (name.startsWith('(') && name.endsWith(')')) return null; // (group)
  if (name.startsWith('@')) return null; // @slot parallel route
  if (name.startsWith('[[...') && name.endsWith(']]')) return `*${name.slice(5, -2)}?`; // optional catch-all
  if (name.startsWith('[...') && name.endsWith(']')) return `*${name.slice(4, -1)}`; // catch-all
  if (name.startsWith('[') && name.endsWith(']')) return `:${name.slice(1, -1)}`; // dynamic
  return name; // static
}

async function walk(dir, appDir, urlParts, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries) {
    if (e.isFile()) {
      const file = join(dir, e.name);
      if (PAGE_RE.test(e.name)) {
        out.routes.push({ path: urlToPath(urlParts), type: 'page', file });
      } else if (ROUTE_RE.test(e.name)) {
        out.routes.push({ path: urlToPath(urlParts), type: 'route-handler', file });
      } else if (STRUCTURAL_RE.test(e.name)) {
        out.structural.push({ kind: e.name.split('.')[0], path: urlToPath(urlParts), file });
      }
    } else if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const part = segmentToUrlPart(e.name);
      const nextParts = part === null ? urlParts : [...urlParts, part];
      await walk(join(dir, e.name), appDir, nextParts, out);
    }
  }
}

function urlToPath(parts) {
  const p = '/' + parts.join('/');
  return p === '/' ? '/' : p.replace(/\/+$/, '');
}

export async function buildRouteMap(project) {
  const appDir = await findAppDir(project);
  if (!appDir) {
    return { error: `No App Router directory found under ${project} (looked for src/app, app).` };
  }
  const out = { routes: [], structural: [] };
  await walk(appDir, appDir, [], out);
  out.routes.sort((a, b) => a.path.localeCompare(b.path));

  // Apps with a [locale] segment route everything under it -> surface that so the agent prefixes /en etc.
  const localeSegment = out.routes.some((r) => r.path.startsWith('/:locale'));
  return {
    appDir,
    localePrefixed: localeSegment,
    routeCount: out.routes.length,
    routes: out.routes,
    structural: out.structural,
  };
}
