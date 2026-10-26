import {t, useUi, formatNumber} from './i18n/core';
import { useProtectedApi } from './access';
import { useProtectedInvoke } from './access';
import { useEffect, useMemo, useRef, useState } from 'react';

import Markdown from 'react-markdown';
import { api as nativeApi } from './bridge';
import {captureFileError, fileErrorText, LocalFileError, type FileErrorState} from './SessionTools';
import CodePreview from './CodePreview';

type Change = { path: string; originalPath: string | null; index: string; worktree: string };
type Commit = { oid: string; subject: string };
type Entry = { path: string; oid: string; kind: string; size: number | null };
type Blob = { text: string | null; binary: boolean; bytes: number };
type Diff = { patch: string; binary: boolean };
type Review = { path: string; revision: string; file: string; staged?: boolean };
type Annotation = { repository: string; file: string; revision: string; line: number; text: string };
type Image = { mime: string; data: number[] };
type Line = { before?: number; after?: number; left?: string; right?: string; kind: 'context' | 'change' | 'hunk' };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';
const validText = (value: unknown, limit = 4096): value is string => typeof value === 'string' && value.length <= limit && !value.includes('\0');
const validOid = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value);
function invalidResponse(): never { throw new LocalFileError('repoInvalid'); }
export function parseRepositoryStatus(value: unknown): { path: string; changes: Change[] } {
  if (!isObject(value) || !validText(value.path) || !Array.isArray(value.changes) || value.changes.length > 10000) return invalidResponse();
  for (const row of value.changes) if (!isObject(row) || !validText(row.path) || !(row.originalPath === null || validText(row.originalPath)) || typeof row.index !== 'string' || !/^[ MADRCU?!T]$/.test(row.index) || typeof row.worktree !== 'string' || !/^[ MADRCU?!T]$/.test(row.worktree)) return invalidResponse();
  return value as { path: string; changes: Change[] };
}
function parseHistory(value: unknown): Commit[] {
  if (!Array.isArray(value) || value.length > 50 || value.some(row => !isObject(row) || !validOid(row.oid) || !validText(row.subject))) return invalidResponse();
  return value as Commit[];
}
function parseTree(value: unknown): Entry[] {
  if (!Array.isArray(value) || value.length > 10000 || value.some(row => !isObject(row) || !validText(row.path) || !validOid(row.oid) || !['blob', 'commit', 'symlink', 'tree'].includes(String(row.kind)) || !(row.size === null || (Number.isSafeInteger(row.size) && Number(row.size) >= 0)))) return invalidResponse();
  return value as Entry[];
}
function parseBlob(value: unknown): Blob {
  if (!isObject(value) || typeof value.binary !== 'boolean' || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0 || Number(value.bytes) > 204800 || !(value.text === null || validText(value.text, 204800)) || value.binary !== (value.text === null)) return invalidResponse();
  return value as Blob;
}
function parseDiff(value: unknown): Diff {
  if (!isObject(value) || typeof value.binary !== 'boolean' || !validText(value.patch, 1048576)) return invalidResponse();
  return value as Diff;
}
function readReview(sessionId: string): Review | undefined {
  try {
    const stored = sessionStorage.getItem(`lazysh-review:${sessionId}`);
    if (!stored || stored.length > 16384) return;
    const value: unknown = JSON.parse(stored);
    if (isObject(value) && validText(value.path) && validText(value.file) && (value.revision === '' || validOid(value.revision)) && (value.staged === undefined || typeof value.staged === 'boolean')) return value as Review;
  } catch { /* Storage is optional. */ }
}
function imageUrl(value: unknown): string {
  if (!isObject(value) || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(String(value.mime)) || !Array.isArray(value.data) || value.data.length > 2097152 || value.data.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return invalidResponse();
  const image = value as Image;
  let binary = '';
  for (let offset = 0; offset < image.data.length; offset += 16384) binary += String.fromCharCode(...image.data.slice(offset, offset + 16384));
  return `data:${image.mime};base64,${btoa(binary)}`;
}

export function diffLines(patch: string): Line[] {
  const rows: Line[] = [];
  let before = 0, after = 0;
  let removed: string[] = [], added: string[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push({ kind: 'change', before: i < removed.length ? before++ : undefined, after: i < added.length ? after++ : undefined, left: removed[i], right: added[i] });
    removed = []; added = [];
  };
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { flush(); before = Number(hunk[1]); after = Number(hunk[2]); rows.push({ kind: 'hunk', left: line }); }
    else if (!rows.length || line === '\\ No newline at end of file') continue;
    else if (line.startsWith('-')) removed.push(line.slice(1));
    else if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith(' ')) { flush(); rows.push({ kind: 'context', before: before++, after: after++, left: line.slice(1), right: line.slice(1) }); }
  }
  flush();
  return rows;
}

export default function RepositoryPanel({ sessionId }: { sessionId: string }) {
  useUi();
  const api = useProtectedApi(nativeApi);
  const invoke = useProtectedInvoke();
  const [path, setPath] = useState('.');
  const [draft, setDraft] = useState('.');
  const [changes, setChanges] = useState<Change[]>([]);
  const [history, setHistory] = useState<Commit[]>([]);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [olderHistory, setOlderHistory] = useState(false);
  const [revision, setRevision] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [directory, setDirectory] = useState('');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState('');
  const [content, setContent] = useState<Blob | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [preview, setPreview] = useState('');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [draftStatus, setDraftStatus] = useState<'' | 'repoCommentsStaged' | 'repoCommentsCopied'>('');
  const [commentLine, setCommentLine] = useState(1);
  const [markdown, setMarkdown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FileErrorState>('');
  const request = useRef(0);
  useEffect(() => {
    const saved = readReview(sessionId);
    if (saved) void load(saved.path, saved);
    return () => { request.current++; };
  }, [sessionId]);

  async function load(next: string, saved?: Review) {
    const current = ++request.current;
    setBusy(true); setError('');
    try {
      const result = parseRepositoryStatus(await invoke('repository_status', { sessionId, path: next }));
      if (current !== request.current) return;
      setPath(result.path); setDraft(result.path); setChanges(result.changes); setRevision(''); setDirectory(''); setEntries([]); setSelected(''); setContent(null); setDiff(null); setPreview('');
      try {
        const commits = parseHistory(await invoke('repository_history', { sessionId, path: result.path }));
        if (current === request.current) { setHistory(commits); setHistoryOffset(commits.length); setOlderHistory(commits.length === 50); }
        if (current === request.current && saved?.path === result.path && saved.file) {
          if (saved.revision) await browse(saved.revision, result.path, saved);
          else await open(saved.file, saved.staged, undefined, result.path, '');
        }
      } catch (e) { if (current === request.current) { setHistory([]); setError({history:captureFileError(e)}); } }
    } catch (e) { if (current === request.current) setError(captureFileError(e)); }
    finally { if (current === request.current) setBusy(false); }
  }
  async function browse(value: string, repositoryPath = path, saved?: Review, targetDirectory = '') {
    const current = ++request.current;
    const nextDirectory = saved?.file.includes('/') ? saved.file.slice(0, saved.file.lastIndexOf('/')) : targetDirectory;
    setRevision(value); setDirectory(nextDirectory); setSelected(''); setContent(null); setDiff(null); setPreview(''); setError('');
    if (!value) return;
    setBusy(true);
    try {
      const tree = parseTree(await invoke('repository_tree', { sessionId, path: repositoryPath, revision: value, directory: nextDirectory }));
      if (current === request.current) setEntries(tree);
      if (current === request.current && saved?.file) {
        const entry = tree.find(entry => entry.path === saved.file);
        if (entry) await open(entry.path, undefined, entry, repositoryPath, value);
      }
    } catch (e) { if (current === request.current) setError(captureFileError(e)); }
    finally { if (current === request.current) setBusy(false); }
  }
  async function open(filePath: string, staged?: boolean, entry?: Entry, repositoryPath = path, selectedRevision = revision) {
    if (entry?.kind === 'tree') { await browse(selectedRevision, repositoryPath, undefined, entry.path); return; }
    const current = ++request.current;
    setSelected(filePath); setContent(null); setDiff(null); setPreview(''); setBusy(true); setError(''); setMarkdown(false);
    try {
      if (staged === undefined && /\.(png|jpe?g|gif|webp)$/i.test(filePath) && (!entry || entry.kind === 'blob')) {
        const value = imageUrl(await invoke('repository_image', { sessionId, path: repositoryPath, filePath, objectId: entry?.oid || null }));
        if (current === request.current) setPreview(value);
      } else if (entry) {
        if (entry.kind !== 'blob' && entry.kind !== 'symlink') throw new LocalFileError('repoSubmodule');
        const value = parseBlob(await invoke('repository_blob', { sessionId, path: repositoryPath, objectId: entry.oid }));
        if (current === request.current) setContent(value);
      } else if (staged === undefined) {
        const text = await api.readFile(sessionId, `${repositoryPath.replace(/\/$/, '')}/${filePath}`);
        if (typeof text !== 'string' || text.length > 1048576) throw new LocalFileError('repoInvalidFile');
        if (current === request.current) setContent({ text: text.includes('\0') ? null : text, binary: text.includes('\0'), bytes: new TextEncoder().encode(text).length });
      } else {
        const value = parseDiff(await invoke('repository_diff', { sessionId, path: repositoryPath, filePath, staged }));
        if (current === request.current) setDiff(value);
      }
      if (current === request.current) {
        try { sessionStorage.setItem(`lazysh-review:${sessionId}`, JSON.stringify({ path: repositoryPath, revision: selectedRevision, file: filePath, staged })); } catch { /* Storage is optional. */ }
      }
    } catch (e) { if (current === request.current) setError(captureFileError(e)); }
    finally { if (current === request.current) setBusy(false); }
  }
  const visibleEntries = entries.filter(entry => entry.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const visibleChanges = changes.filter(change => change.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const lineCount = useMemo(() => (content?.text || '').split('\n').length, [content?.text]);
  function annotate(line: number) {
    if (annotations.length >= 20 || annotations.some(note => note.repository === path && note.file === selected && note.revision === revision && note.line === line)) return;
    setAnnotations([...annotations, { repository: path, file: selected, revision, line, text: '' }]);
  }
  const annotationText = annotations.filter(note => note.text.trim()).map(note => `${note.repository.replace(/\/$/, '')}/${note.file}:${note.line}${note.revision ? ` (commit ${note.revision})` : ' (working tree)'}\n${note.text.trim()}`).join('\n\n');
  async function older() {
    const current = ++request.current;
    setBusy(true); setError('');
    try {
      const commits = parseHistory(await invoke('repository_history', { sessionId, path, offset: historyOffset, revision: history[0]?.oid }));
      if (current === request.current) { setHistory(previous => [...new Map([...previous, ...commits].map(commit => [commit.oid, commit])).values()]); setHistoryOffset(historyOffset + commits.length); setOlderHistory(commits.length === 50); }
    } catch (e) { if (current === request.current) setError(captureFileError(e)); }
    finally { if (current === request.current) setBusy(false); }
  }
  return <section className="tool-panel repository-panel" aria-label={t('repoTitle')}>
    <h3>{t('repoTitle')}</h3>
    <form className="tool-bar" onSubmit={event => { event.preventDefault(); void load(draft); }}>
      <label>{t('repoDirectory')}<input required value={draft} onChange={event => setDraft(event.target.value)} /></label>
      <button disabled={busy}>{t('repoOpen')}</button>
      <label>{t('repoRevision')}<select aria-label={t('repoRevisionLabel')} disabled={busy} value={revision} onChange={event => void browse(event.target.value)}><option value="">{t('repoWorkingTree')}</option>{revision && !history.some(commit => commit.oid === revision) && <option value={revision}>{t('repoSelectedCommit',{commit:revision.slice(0,8)})}</option>}{history.map(commit => <option key={commit.oid} value={commit.oid}>{commit.oid.slice(0, 8)} {commit.subject}</option>)}</select></label>
      {olderHistory && <button type="button" disabled={busy || historyOffset >= 100000} onClick={() => void older()}>{t('repoOlder')}</button>}
    </form>
    {error && <p className="inline-error" role="alert">{fileErrorText(error)}</p>}
    {busy && <p role="status">{t('repoReading')}</p>}
    <div className="repository-layout"><div className="repository-list">
      <label>{t('repoFind')}<input value={filter} onChange={event => setFilter(event.target.value)} /></label>
      {(revision ? visibleEntries : visibleChanges).length > 500 && <p>{t('repoLimit')}</p>}
      {revision ? <><p>{t('repoEntries',{entries:formatNumber(entries.length),directory:directory || '/'})}</p>{directory && <button disabled={busy} onClick={() => void browse(revision, path, undefined, directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '')}>{t('filesParent')}</button>}{visibleEntries.slice(0, 500).map(entry => <button className="repository-file" disabled={busy} key={entry.path} aria-pressed={selected === entry.path} onClick={() => void open(entry.path, undefined, entry)}><code>{entry.path}</code><small>{entry.kind} {entry.size === null ? '' : t('repoBytes',{bytes:formatNumber(entry.size)})}</small></button>)}</> : <>
        {changes.length === 0 && history.length > 0 && <p>{t('repoClean')}</p>}
        {visibleChanges.slice(0, 500).map(change => <article key={change.path} className="repository-change"><code>{change.index}{change.worktree} {change.path}</code>{change.originalPath && <small>{t('repoFrom',{path:change.originalPath})}</small>}<div>
          <button disabled={busy} onClick={() => void open(change.path)}>{t('repoRead')}</button>
          {change.index !== ' ' && change.index !== '?' && <button disabled={busy} onClick={() => void open(change.path, true)}>{t('repoStaged')}</button>}
          {change.worktree !== ' ' && change.worktree !== '?' && <button disabled={busy} onClick={() => void open(change.path, false)}>{t('repoUnstaged')}</button>}
          {change.index === '?' && <small>{t('repoUntracked')}</small>}
        </div></article>)}
      </>}
    </div><div className="repository-content">
      {selected && <h4>{selected}</h4>}
      {preview && <img className="repository-image" src={preview} alt={t('repoPreview',{file:selected})} />}
      {content && (content.binary ? <p>{t('repoBinary',{bytes:formatNumber(content.bytes)})}</p> : <>
        {selected.toLowerCase().endsWith('.md') && <button onClick={() => setMarkdown(!markdown)}>{markdown ? t('repoSource') : t('repoMarkdown')}</button>}
        <div className="tool-bar"><label>{t('repoCommentLine')}<input type="number" min={1} max={lineCount} value={commentLine} onChange={event => setCommentLine(Number(event.target.value))} /></label><button disabled={!Number.isSafeInteger(commentLine) || commentLine < 1 || commentLine > lineCount || annotations.length >= 20} onClick={() => annotate(commentLine)}>{t('repoAddComment')}</button></div>
        {markdown ? <Markdown components={{ img: () => <span>{t('repoRemoteImage')}</span>, a: ({ children }) => <span>{children}</span> }}>{content.text || ''}</Markdown> : <CodePreview path={selected} text={content.text || ''} />}
      </>)}
      {diff && (diff.binary ? <p>{t('repoBinaryDiff')}</p> : diff.patch ? <div className="repository-diff-scroll"><table className="repository-diff" aria-label={t('repoSideBySide')}><thead><tr><th colSpan={2}>{t('repoBefore')}</th><th colSpan={2}>{t('repoAfter')}</th></tr></thead><tbody>{diffLines(diff.patch).map((line, i) => line.kind === 'hunk' ? <tr key={i}><th className="diff-hunk" colSpan={4}>{line.left}</th></tr> : <tr key={i} className={line.kind}><td>{line.before}</td><td><pre>{line.left}</pre></td><td>{line.after}</td><td><pre>{line.right}</pre></td></tr>)}</tbody></table></div> : <p>{t('repoNoSelectionChanges')}</p>)}
    </div></div>
    {annotations.length > 0 && <section className="repository-comments" aria-label={t('repoComments')}><h4>{t('repoNextPrompt')}</h4>{annotations.map((note, index) => <label key={`${note.repository}:${note.file}:${note.revision}:${note.line}`}>{note.repository}/{note.file}:{note.line}<textarea maxLength={2000} value={note.text} onChange={event => setAnnotations(current => current.map((row, i) => i === index ? { ...row, text: event.target.value } : row))} /><button onClick={() => setAnnotations(current => current.filter((_, i) => i !== index))}>{t('repoRemoveComment')}</button></label>)}{annotationText.length > 65536 && <p>{t('repoShorten')}</p>}<button disabled={!annotationText || annotationText.length > 65536} onClick={() => { window.dispatchEvent(new CustomEvent('lazysh-prompt-draft', { detail: { sessionId, text: annotationText } })); setDraftStatus('repoCommentsStaged'); }}>{t('repoUsePrompt')}</button><button disabled={!annotationText} onClick={() => void navigator.clipboard.writeText(annotationText).then(() => setDraftStatus('repoCommentsCopied')).catch(e => setError(captureFileError(e)))}>{t('repoCopyComments')}</button>{draftStatus && <p role="status">{t(draftStatus)}</p>}</section>}
  </section>;
}
