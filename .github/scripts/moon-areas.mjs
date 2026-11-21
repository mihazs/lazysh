// Print the CI areas that a changed file affects, derived from the moon project graph:
// `moon query affected --downstream deep` (the file's project and every dependent), mapped through .github/ci-areas.json.
// Usage: node moon-areas.mjs <changed-path>...   Exit 1 (caller must select everything) when moon fails or a path
// under apps/ or packages/ belongs to no mapped project.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const moon = existsSync(join(root, 'node_modules/@moonrepo/cli/moon.js')) ? [process.execPath, join(root, 'node_modules/@moonrepo/cli/moon.js')] : ['moon'];
try {
  const { MOON_BASE, MOON_HEAD, ...env } = process.env;
  const out = execFileSync(moon[0], [...moon.slice(1), 'query', 'projects'], { cwd: root, env: { ...env, MOON_TELEMETRY: 'false', NO_COLOR: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const projects = JSON.parse(out).projects;
  const config = JSON.parse(readFileSync(join(root, '.github/ci-areas.json'), 'utf8'));
  const areas = config.projects;
  const owner = path => projects.filter(p => path === p.source || path.startsWith(`${p.source}/`)).sort((a, b) => b.source.length - a.source.length)[0];
  const paths = process.argv.slice(2);
  for (const path of paths) if (!owner(path) || !(owner(path).id in areas)) throw new Error(`no mapped moon project owns ${path}`);
  // moon names the directly affected projects (owner plus task-input matches); dependents come from moon's own dependsOn graph.
  const direct = JSON.parse(execFileSync(moon[0], [...moon.slice(1), 'query', 'affected'], { cwd: root, env: { ...env, MOON_TELEMETRY: 'false', NO_COLOR: '1' }, input: `${paths.join('\n')}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }));
  const ignored = new Set(config.ignoreEdges ?? []);
  const dependents = new Map(projects.map(p => [p.id, []]));
  for (const p of projects) for (const d of p.config.dependsOn ?? []) if (!ignored.has(`${p.id}>${d.id ?? d}`)) dependents.get(d.id ?? d)?.push(p.id);
  const affected = new Set();
  const visit = id => { if (affected.has(id)) return; affected.add(id); dependents.get(id)?.forEach(visit); };
  Object.keys(direct.projects ?? {}).forEach(visit);
  for (const id of affected) if (!(id in areas)) throw new Error(`project ${id} has no entry in ci-areas.json`);
  console.log([...new Set([...affected].flatMap(id => areas[id]))].join(' '));
} catch (error) {
  console.error(String(error));
  process.exit(1);
}
