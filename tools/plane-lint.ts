// plane-lint — enforces the two-plane isolation invariant (ADR-017).
//
// The edge/data plane (@loopback/*) and the agent plane (@agentback/*) never
// share a live Context; they meet only at serializable boundaries. Therefore:
//   - an `edge`-plane member must NOT runtime-import `@agentback/*`
//   - an `agent`-plane member must NOT runtime-import `@loopback/*`
// `import type` is allowed (erased at runtime). The sole sanctioned cross-plane
// value-mapper is `@platform-internal/agentback-bridge`.
//
// Reads each workspace member's `hermes` descriptor from its package.json, scans
// its src/**/*.ts for offending runtime imports, and exits non-zero on violation.
import {readFileSync, readdirSync, statSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AREAS = ['apps', 'packages', 'components', 'infrastructure'];
const BRIDGE = '@platform-internal/agentback-bridge';

type Plane = 'edge' | 'agent' | 'none';
interface Member {
  name: string;
  plane: Plane;
  dir: string;
}

function members(): Member[] {
  const out: Member[] = [];
  for (const area of AREAS) {
    const areaDir = join(ROOT, area);
    if (!existsSync(areaDir)) continue;
    for (const entry of readdirSync(areaDir)) {
      const pkgPath = join(areaDir, entry, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const h = pkg.hermes;
      if (!h)
        throw new Error(
          `${pkg.name}: missing "hermes" descriptor in package.json`,
        );
      out.push({name: h.name, plane: h.plane, dir: join(areaDir, entry)});
    }
  }
  return out;
}

function tsFiles(dir: string): string[] {
  const src = join(dir, 'src');
  if (!existsSync(src)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(p);
    }
  };
  walk(src);
  return out;
}

// A runtime import of `scope`: matches `from '<scope>...'` / `import '<scope>...'`
// but NOT `import type ... from` (type-only, erased).
function runtimeImports(source: string, scope: string): boolean {
  const importRe = /^\s*import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm;
  const bareRe = /^\s*import\s+['"]([^'"]+)['"]/gm;
  for (const re of [importRe, bareRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      if (m[1]!.startsWith(scope)) return true;
    }
  }
  return false;
}

const violations: string[] = [];
for (const m of members()) {
  if (m.plane === 'none') continue;
  if (m.name === BRIDGE) continue; // the one sanctioned crossing
  const forbidden = m.plane === 'edge' ? '@agentback/' : '@loopback/';
  for (const file of tsFiles(m.dir)) {
    if (runtimeImports(readFileSync(file, 'utf8'), forbidden)) {
      violations.push(
        `${m.name} (${m.plane}) runtime-imports ${forbidden}* in ${file.slice(ROOT.length + 1)}`,
      );
    }
  }
}

const all = members();
console.log(
  `plane-lint: scanned ${all.length} members ` +
    `(${all.filter(x => x.plane === 'edge').length} edge, ` +
    `${all.filter(x => x.plane === 'agent').length} agent, ` +
    `${all.filter(x => x.plane === 'none').length} none)`,
);
if (violations.length) {
  console.error(
    `\nplane-lint FAILED — ${violations.length} cross-plane violation(s):`,
  );
  for (const v of violations) console.error(`  ✗ ${v}`);
  process.exit(1);
}
console.log('plane-lint OK — no cross-plane runtime imports.');
