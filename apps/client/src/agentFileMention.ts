import type {FileEntry} from './bridge';

/** An `@path` being typed: where it starts in the draft, the folder it names and the name prefix inside that folder. */
export type Mention = Readonly<{start: number; dir: string; prefix: string}>;
const LIMIT = 20;

/** The mention the caret is in, if any. Only a path below the agent's folder qualifies: absolute paths, `..`, backslashes
 * and control characters are refused here, before any listing is asked for. */
export function mentionAt(draft: string, caret: number): Mention | undefined {
  const before = draft.slice(0, caret);
  const typed = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!typed) return;
  const query = typed[2];
  if (query.startsWith('/') || query.includes('\\') || /[\x00-\x1f\x7f-\x9f]/.test(query) || query.split('/').some(part => part === '..' || part === '.')) return;
  const slash = query.lastIndexOf('/');
  return {start: caret - query.length - 1, dir: query.slice(0, slash + 1), prefix: query.slice(slash + 1)};
}

/** The folder to list: the agent's folder plus the typed sub-folder, both already free of `..`. */
export const listingPath = (cwd: string, mention: Mention) => `${cwd.replace(/\/+$/, '')}/${mention.dir}`.replace(/\/+$/, '') || '/';

/** Entries whose name starts with the typed prefix; dot files only when the prefix itself starts with a dot. */
export function matchEntries(entries: readonly FileEntry[], mention: Mention): FileEntry[] {
  const prefix = mention.prefix.toLowerCase(), dots = prefix.startsWith('.');
  return entries.filter(entry => entry.name.toLowerCase().startsWith(prefix) && (dots || !entry.name.startsWith('.')) && !/[\s\x00-\x1f\x7f-\x9f]/.test(entry.name)).slice(0, LIMIT);
}

/** What replaces the typed mention: a file ends the mention, a folder keeps it open one level deeper. */
export const mentionText = (mention: Mention, entry: FileEntry) => `@${mention.dir}${entry.name}${entry.isDir ? '/' : ' '}`;
