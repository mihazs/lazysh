import {useEffect,useRef,useState} from 'react';
import type {FileEntry} from './bridge';
import type {bindProtectedInvoke} from './access';
import {listingPath,matchEntries,type Mention} from './agentFileMention';

/** The files and folders an `@` mention can complete to, read from the host folder the agent works in. One listing per folder is
 * kept while the same conversation is open; a failed listing offers nothing. */
export function useAgentFileSuggestions({sessionId, invoke, cwd, mention}: {
  sessionId: string; invoke: ReturnType<typeof bindProtectedInvoke>; cwd?: string; mention?: Mention;
}): FileEntry[] {
  const cache = useRef(new Map<string, FileEntry[]>());
  const [listing, setListing] = useState<{path: string; entries: FileEntry[]}>();
  const path = cwd && mention ? listingPath(cwd, mention) : undefined;
  useEffect(() => { cache.current.clear(); setListing(undefined); }, [sessionId, cwd]);
  useEffect(() => {
    if (!path || !cwd?.startsWith('/')) return;
    const known = cache.current.get(path);
    if (known) { setListing({path, entries: known}); return; }
    let alive = true;
    // A short pause keeps a fast typist from asking for a listing per key.
    const timer = setTimeout(() => {
      invoke<FileEntry[]>('list_directory', {sessionId, path}).then(entries => {
        if (!Array.isArray(entries)) return;
        cache.current.set(path, entries);
        if (alive) setListing({path, entries});
      }, () => { if (alive) setListing(undefined); });
    }, 150);
    return () => { alive = false; clearTimeout(timer); };
  }, [sessionId, cwd, path, invoke]);
  return mention && listing && listing.path === path ? matchEntries(listing.entries, mention) : [];
}
