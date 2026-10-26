import {validTmuxServer, type SessionAttachment} from './workspace';
import { observeCurrent } from "./asyncState";
import {bindProtectedInvoke, captureAccess} from './access';
import type {DesktopMuxRequest} from './useDesktopLaunch';
import {t,useUi,formatNumber} from './i18n/core';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { Layers, RefreshCw } from 'lucide-react';
import { errorMessage } from './SessionTools';
import type { MultiplexerKind } from './bridge';
import HerdrPanel from './HerdrPanel';
import ZellijPanel from './ZellijPanel';
import MultiplexerShortcuts from './MultiplexerShortcuts';
import { parseSnapshot } from './AgentPanel';

type Pane = { id: string; index: number; active: boolean; command: string; path: string };
type Window = { id: string; index: number; name: string; active: boolean; panes: Pane[] };
type Session = { id: string; name: string; windows: Window[] };
type Tree = { tmuxAvailable: boolean; herdrAvailable: boolean; zellijAvailable: boolean; sessions: Session[] };
type Action =
  | { type: 'createSession'; name: string; directory: string }
  | { type: 'renameSession' | 'renameWindow'; target: string; name: string }
  | { type: 'createWindow'; target: string; name: string; directory: string }
  | { type: 'selectWindow' | 'selectPane' | 'zoomPane'; target: string }
  | { type: 'splitPane'; target: string; horizontal: boolean; directory: string };
type Edit = { type: 'createSession' } | { type: 'createWindow' | 'renameSession' | 'renameWindow'; target: string };

export function MuxPanel({ sessionId, onAttach, attached, requested }: { sessionId: string; onAttach: (name: string, kind?: MultiplexerKind, tmuxServer?: string) => Promise<void>; attached?: SessionAttachment; requested?:DesktopMuxRequest }) {
  useUi();
  const [lease]=useState(()=>requested?.lease ?? captureAccess());
  const invoke=useMemo(()=>bindProtectedInvoke(lease),[lease]);
  const requestedHerdr=requested?.mux.kind==='herdr';
  const fixedServer=requested?.mux.kind==='tmux' ? requested.mux.tmuxServer : attached?.kind==='tmux' ? attached.tmuxServer ?? 'default' : undefined;
  const [selectedServer, setSelectedServer] = useState(fixedServer ?? 'default');
  const [serverDraft, setServerDraft] = useState(selectedServer);
  const tmuxServer = fixedServer ?? selectedServer;
  const serverArgs = tmuxServer === 'default' ? {} : {tmuxServer};
  const [tree, setTree] = useState<Tree | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState<Edit | null>(null);
  const [name, setName] = useState('');
  const [directory, setDirectory] = useState('.');
  const [persistent, setPersistent] = useState<Record<string, { name: string }[]>>({});
  const [persistentName, setPersistentName] = useState('');
  const [herdr, setHerdr] = useState('');
  const [zellij, setZellij] = useState('');
  const [projects, setProjects] = useState<string[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [layout, setLayout] = useState(() => { try { const value = localStorage.getItem('lazysh.multiplexer.layout'); return ['list', 'accordion', 'grid'].includes(value ?? '') ? value! : 'list'; } catch { return 'list'; } });
  const generation = useRef(0);
  const locked = useRef(false);
  const currentOwner=(version:number)=>generation.current===version && lease.current() && (!requested || requested.sessionId===sessionId);
  async function readWorkspaces() {
    const tree=await invoke<Tree>('multiplexer_tree',{sessionId,...serverArgs});
    const sessions=requestedHerdr && tree.herdrAvailable
      ? await invoke<{name:string}[]>('multiplexer_sessions',{sessionId,kind:'herdr'}) : undefined;
    return {tree,sessions};
  }
  function acceptWorkspaces(value:Awaited<ReturnType<typeof readWorkspaces>>) {
    setTree(value.tree);setEdit(null);
    if(value.sessions)setPersistent({herdr:value.sessions});
  }
  useEffect(() => {
    const current = ++generation.current;
    if(!currentOwner(current))return;
    setTree(null); setEdit(null); setPersistent({}); setHerdr(''); setZellij(''); setProjects([]); setProjectsLoaded(false); setError(''); setBusy(true);
    observeCurrent(readWorkspaces(), () => currentOwner(current),
      acceptWorkspaces, error => setError(errorMessage(error)), () => setBusy(false));
    return () => { generation.current++; };
  }, [sessionId, tmuxServer]);
  useEffect(() => { try { localStorage.setItem('lazysh.multiplexer.layout', layout); } catch { /* Layout remains usable without persistence. */ } }, [layout]);
  async function run(action?: Action, attach?: string, kind?: MultiplexerKind) {
    if (locked.current || !currentOwner(generation.current)) return;
    locked.current = true;
    const current = generation.current;
    setBusy(true); setError('');
    try {
      if (attach !== undefined) {
        if (kind) await onAttach(attach, kind);
        else if (tmuxServer === 'default') await onAttach(attach);
        else await onAttach(attach, 'tmux', tmuxServer);
      }
      else {
        if (action) await invoke('tmux_action', { sessionId, action, ...serverArgs });
        const value=await readWorkspaces();
        if(currentOwner(current))acceptWorkspaces(value);
      }
    } catch (e) { if (currentOwner(current)) setError(errorMessage(e)); }
    finally { locked.current = false; if (currentOwner(current)) setBusy(false); }
  }
  async function loadPersistent(kind: 'herdr' | 'zellij') {
    if (locked.current || !currentOwner(generation.current)) return;
    locked.current = true;
    const current = generation.current;
    setBusy(true); setError('');
    try {
      const sessions = await invoke<{ name: string }[]>('multiplexer_sessions', { sessionId, kind });
      if (currentOwner(current)) setPersistent(value => ({ ...value, [kind]: sessions }));
    } catch (e) { if (currentOwner(current)) setError(errorMessage(e)); }
    finally { locked.current = false; if (currentOwner(current)) setBusy(false); }
  }
  async function loadProjects() {
    if (locked.current || !currentOwner(generation.current)) return;
    locked.current = true;
    const current = generation.current;
    setBusy(true); setError('');
    try {
      const rows = parseSnapshot(await invoke('agent_snapshot', { sessionId }));
      const values = [...new Set(rows.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(row => row.project).filter(path => path.length > 0 && !/[\x00-\x1f\x7f]/.test(path)))];
      if (currentOwner(current)) { setProjects(values); setProjectsLoaded(true); }
    } catch (e) { if (currentOwner(current)) setError(errorMessage(e)); }
    finally { locked.current = false; if (currentOwner(current)) setBusy(false); }
  }
  function begin(value: Edit, initial = '') { setEdit(value); setName(initial); setError(''); }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!edit || !name.trim()) return;
    if (edit.type === 'createSession') void run({ ...edit, name, directory });
    else if (edit.type === 'createWindow') void run({ type: 'createWindow', target: edit.target, name, directory });
    else void run({ type: edit.type, target: edit.target, name });
  }
  return <section className="tool-panel multiplexer-panel" aria-label={t('muxTitle')}>
    {requested && <p className="security-note">{t('desktopLaunchMuxPicker')}</p>}
    {!requestedHerdr && <div className="tool-bar"><label>{t('muxServer')}<input value={fixedServer ?? serverDraft} disabled={busy || fixedServer!==undefined} onChange={event=>setServerDraft(event.target.value)} placeholder="default" /></label>
      {fixedServer===undefined && <button className="subtle-button" disabled={busy || !validTmuxServer(serverDraft)} onClick={()=>{setError('');setSelectedServer(serverDraft);}}>{t('muxBrowseServer')}</button>}<span>{t('muxServerValue',{server:tmuxServer})}</span></div>}
    <div className="tool-bar"><h3>{t('muxWorkspaces')}</h3><button className="subtle-button" disabled={busy} onClick={() => void run()}><RefreshCw size={15} /> {t('agentsRefresh')}</button>
      {!requested && tree?.tmuxAvailable && <button className="subtle-button" disabled={busy} onClick={() => begin({ type: 'createSession' })}>{t('muxNewSession')}</button>}</div>
    {!requested && <div className="tool-bar"><label>{t('muxLayout')}<select value={layout} onChange={e => setLayout(e.target.value)}><option value="list">{t('muxList')}</option><option value="accordion">{t('jumpAccordion')}</option><option value="grid">{t('jumpGrid')}</option></select></label><button className="subtle-button" disabled={busy} onClick={() => void loadProjects()}>{t('muxProjects')}</button></div>}
    {projects.length > 0 && <label>{t('muxRecentDirectory')}<select value={projects.includes(directory) ? directory : ''} onChange={e => setDirectory(e.target.value)}><option value="" disabled>{t('muxChooseProject')}</option>{projects.map(project => <option key={project} value={project}>{project}</option>)}</select></label>}
    {projectsLoaded && projects.length === 0 && <p>{t('muxNoProjects')}</p>}
    {attached && attached.kind !== 'zellij' && <MultiplexerShortcuts key={`${sessionId}:${attached.kind}`} sessionId={sessionId} kind={attached.kind} />}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {busy && <p className="loading" role="status">{t('muxReading')}</p>}
    {requested && tree && !(requestedHerdr ? tree.herdrAvailable : tree.tmuxAvailable) && <p role="status">{t('desktopLaunchMuxUnavailable',{kind:requested.mux.kind})}</p>}
    {!requested && tree && <p className="muted">tmux {tree.tmuxAvailable ? t('muxAvailable') : t('muxMissing')} · Herdr {tree.herdrAvailable ? t('muxDetected') : t('muxMissing')} · Zellij {tree.zellijAvailable ? t('muxDetected') : t('muxMissing')}</p>}
    {(requestedHerdr ? tree?.herdrAvailable : !requested && (tree?.herdrAvailable || tree?.zellijAvailable)) && <div>{!requested && <label>{t('muxPersistentName')}<input value={persistentName} onChange={e => setPersistentName(e.target.value)} maxLength={200} disabled={busy} /></label>}
      {(['herdr', 'zellij'] as const).filter(kind => (!requested || kind==='herdr') && (kind === 'herdr' ? tree!.herdrAvailable : tree!.zellijAvailable)).map(kind => <div key={kind}>
        {!requested && <div className="tool-bar"><button className="subtle-button" disabled={busy} onClick={() => void loadPersistent(kind)}>{t('muxListSessions',{kind})}</button>
          <button className="subtle-button" disabled={busy || !persistentName.trim()} onClick={() => void run(undefined, persistentName, kind)}>{t('muxOpenSession',{kind})}</button></div>}
        {persistent[kind]?.length === 0 && <p>{t('muxNoSessions',{kind})}</p>}
        {persistent[kind]?.map(session => <div className="mux-row" key={session.name}><strong>{kind}: {session.name}</strong><button className="subtle-button" disabled={busy} onClick={() => void run(undefined, session.name, kind)}>{t('muxAttachKind',{kind,name:session.name})}</button>{!requested && (kind === 'herdr' ? <button className="subtle-button" disabled={busy} onClick={() => setHerdr(session.name)}>{t('muxBrowseHerdr',{name:session.name})}</button> : <button className="subtle-button" disabled={busy} onClick={() => setZellij(session.name)}>{t('muxControlZellij',{name:session.name})}</button>)}</div>)}
      </div>)}{!requested && <p>{t('muxPersistentHint')}</p>}</div>}
    {herdr && <HerdrPanel sessionId={sessionId} name={herdr} projectDirectory={directory} />}
    {zellij && <ZellijPanel key={`${sessionId}:${zellij}`} sessionId={sessionId} name={zellij} projectDirectory={directory} />}
    {edit && <form onSubmit={submit} aria-label={t('muxDetails')}><label>{t('appName')}<input autoFocus maxLength={200} value={name} onChange={e => setName(e.target.value)} required disabled={busy} /></label>
      {(edit.type === 'createSession' || edit.type === 'createWindow') && <label>{t('muxDirectory')}<input value={directory} onChange={e => setDirectory(e.target.value)} required disabled={busy} placeholder="/home/user/project" /></label>}
      <button className="subtle-button" type="submit" disabled={busy || !name.trim()}>{t('muxSave')}</button><button className="subtle-button" type="button" disabled={busy} onClick={() => setEdit(null)}>{t('appCancel')}</button></form>}
    {!requestedHerdr && tree?.sessions.length === 0 && !busy && <div className="panel-empty"><Layers size={28} /><h3>{t('muxNoTmux')}</h3>{!requested && <p>{t('muxCreateHint')}</p>}</div>}
    <div className={`mux-list mux-layout-${layout}`}>{!requestedHerdr && tree?.sessions.map(session => <details key={`${layout}:${session.id}`} open={layout !== 'accordion'}>
      <summary>{session.name} · {t('muxWindows',{total:formatNumber(session.windows.length),count:session.windows.length})}</summary>
      <div className="tool-bar"><button className="subtle-button" disabled={busy} onClick={() => void run(undefined, session.name)}>{t('muxAttach',{name:session.name})}</button>
        {!requested && <button className="subtle-button" disabled={busy} onClick={() => begin({ type: 'renameSession', target: session.id }, session.name)}>{t('muxRenameSession')}</button>}
        {!requested && <button className="subtle-button" disabled={busy} onClick={() => begin({ type: 'createWindow', target: session.id })}>{t('muxNewWindow')}</button>}</div>
      {!requested && session.windows.map(window => <details key={window.id} open><summary>{formatNumber(window.index)}: {window.name}{window.active ? ` · ${t('muxActive')}` : ''}</summary>
        <div className="tool-bar"><button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'selectWindow', target: window.id })}>{t('muxSelectWindow',{index:formatNumber(window.index)})}</button>
          <button className="subtle-button" disabled={busy} onClick={() => begin({ type: 'renameWindow', target: window.id }, window.name)}>{t('muxRenameWindow')}</button></div>
        {window.panes.map(pane => <div className="mux-row" key={pane.id}><div><strong>{pane.command} · {pane.id}{pane.active ? ` · ${t('muxActive')}` : ''}</strong><small>{pane.path}</small></div>
          <button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'selectPane', target: pane.id })}>{t('muxSelect',{id:pane.id})}</button>
          <button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'zoomPane', target: pane.id })}>{t('muxZoom',{id:pane.id})}</button>
          <button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'splitPane', target: pane.id, horizontal: true, directory: pane.path })}>{t('muxSplitHorizontal',{id:pane.id})}</button>
          <button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'splitPane', target: pane.id, horizontal: false, directory: pane.path })}>{t('muxSplitVertical',{id:pane.id})}</button>
        </div>)}
      </details>)}
    </details>)}</div>
    <p>{t('muxDetachHint')}</p>
  </section>;
}
