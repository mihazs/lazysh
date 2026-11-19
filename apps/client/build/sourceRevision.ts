import { execFileSync } from 'node:child_process';

// The Git revision and dirty flag the app reports in About; Vite (dev, tests) and the Bun build embed the same two constants.
export function sourceDefines(): Record<string, string> {
  let sourceRevision = '';
  let sourceDirty = true;
  try {
    const revision = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {encoding:'utf8'}).trim();
    if (/^[0-9a-f]{40}$/.test(revision)) sourceRevision = revision;
    sourceDirty = execFileSync('git', ['status', '--porcelain'], {encoding:'utf8'}).trim().length > 0;
  } catch { /* Source archives may not include Git metadata. */ }
  return { __LAZYSH_SOURCE_REVISION__: JSON.stringify(sourceRevision), __LAZYSH_SOURCE_DIRTY__: JSON.stringify(sourceDirty) };
}
