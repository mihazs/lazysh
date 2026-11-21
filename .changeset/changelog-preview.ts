import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSummary, renderGrouped, splitFragment } from './changelog-model.mjs';

/** The pending fragments grouped exactly like the release notes they will become. */
export async function previewPending(directory: string) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.md') && name !== 'README.md').sort();
  const entries = [];
  for (const name of names) {
    const parts = splitFragment(await Bun.file(join(directory, name)).text());
    if (!parts?.header.length || !parts.summary.trim()) continue;
    const bump = ['major', 'minor', 'patch'].find(candidate => parts.header.some(line => line.endsWith(`: ${candidate}`)));
    entries.push(parseSummary(parts.summary, bump));
  }
  return entries.length ? `${entries.length} pending change${entries.length === 1 ? '' : 's'}\n\n${renderGrouped(entries, '##')}\n` : 'No pending changes: every fragment under .changeset is already released.\n';
}

if (import.meta.main) process.stdout.write(await previewPending(join(process.cwd(), '.changeset')));
