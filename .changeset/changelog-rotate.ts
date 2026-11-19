import { join } from 'node:path';
import { changelogSection, classifyLegacy, groupMarkdown, parseEntries, renderEntry } from './changelog-model.mjs';

const unreleased = /^## \[Unreleased\]\s*$/m;
const hints: Record<string, string> = { Added: 'feat', Fixed: 'fix', Changed: 'change' };
type Item = { text: string; hint?: string };

/** The hand-written bullets of a root changelog section (with their `### Added|Fixed|Changed` hint) and everything else, verbatim. */
export function legacyItems(body: string) {
  const items: Item[] = [];
  const rest: string[] = [];
  let hint: string | undefined;
  let current: string[] | undefined;
  let owner: Item | undefined;
  const close = () => { if (owner) owner.text = current!.join('\n').trimEnd(); owner = current = undefined; };
  for (const line of body.split('\n')) {
    const heading = /^### (\w+)\s*$/.exec(line);
    if (heading) { close(); hint = hints[heading[1]]; continue; }
    if (line.startsWith('- ')) { close(); owner = { text: '', hint }; items.push(owner); current = [line]; }
    else if (owner && (line.startsWith(' ') || !line.trim())) current!.push(line);
    else { close(); rest.push(line); }
  }
  close();
  return { items, rest: rest.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

/** The hand-written bullets as items of a category; a `### Added|Fixed|Changed` heading they sat under wins over their verb. */
export const classified = (items: Item[]) => items.map(item => ({ type: item.hint ?? classifyLegacy(item.text.slice(2)), text: item.text }));

/**
 * The root changelog with a new `## [version] - date` section below `## [Unreleased]`: the version's entries from the
 * client changelog plus the hand-written bullets still under `[Unreleased]`, which is left without bullets.
 */
export function rotate(root: string, clientSection: string, version: string, date: string) {
  const [head, after] = root.split(unreleased);
  if (after === undefined) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  if (root.includes(`## [${version}]`)) throw new Error(`CHANGELOG.md already has a section for ${version}`);
  const end = after.search(/^## /m);
  const { items, rest } = legacyItems(end < 0 ? after : after.slice(0, end));
  // One line per change, without the collapsed details: this file is scanned for clones, and the multi-line blocks of two
  // similar fragments of one pull request (same headline, same link, same opening) are one. Details live in the package
  // changelog and the GitHub release. Moved bullets stay verbatim, as written.
  const seen = new Set<string>();
  const generated = parseEntries(clientSection).map(entry => ({ type: entry.type, text: renderEntry({ ...entry, details: '' }, true) }))
    .filter(({ text }) => !seen.has(text) && seen.add(text));
  const section = `## [${version}] - ${date}\n\n${groupMarkdown([...generated, ...classified(items)], '###') || 'No user-facing changes.'}\n\n`;
  return `${head}## [Unreleased]\n\n${rest ? `${rest}\n\n` : ''}${section}${end < 0 ? '' : after.slice(end)}`;
}

if (import.meta.main) {
  const [version, date = new Date().toISOString().slice(0, 10)] = process.argv.slice(2);
  const section = changelogSection(await Bun.file('apps/client/CHANGELOG.md').text(), version ?? '');
  if (!section?.trim()) throw new Error(`apps/client/CHANGELOG.md has no section for ${version}`);
  const path = join(process.cwd(), 'CHANGELOG.md');
  await Bun.write(path, rotate(await Bun.file(path).text(), section, version, date));
}
