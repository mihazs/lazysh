import {validTmuxServer, type SessionAttachment} from './workspace';
import { observeCurrent } from "./asyncState";
import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState, type FormEvent } from 'react';

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

export function MuxPanel({ sessionId, onAttach, attached }: { sessionId: string; onAttach: (name: string, kind?: MultiplexerKind, tmuxServer?: string) => Promise<void>; attached?: SessionAttachment }) {
  const invoke = useProtectedInvoke();
  const [selectedServer, setSelectedServer] = useState(attached?.kind === 'tmux' ? attached.tmuxServer ?? 'default' : 'default');
  const [serverDraft, setServerDraft] = useState(selectedServer);
  const tmuxServer = attached?.kind === 'tmux' ? attached.tmuxServer ?? 'default' : selectedServer;
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
  useEffect(() => {
    const current = ++generation.current;
    setTree(null); setEdit(null); setPersistent({}); setHerdr(''); setZellij(''); setProjects([]); setProjectsLoaded(false); setError(''); setBusy(true);
    observeCurrent(invoke<Tree>('multiplexer_tree', { sessionId, ...serverArgs }), () => generation.current === current,
      setTree, error => setError(errorMessage(error)), () => setBusy(false));
    return () => { generation.current++; };
  }, [sessionId, tmuxServer]);
  useEffect(() => { try { localStorage.setItem('lazysh.multiplexer.layout', layout); } catch { /* Layout remains usable without persistence. */ } }, [layout]);
  async function run(action?: Action, attach?: string, kind?: MultiplexerKind) {
    if (locked.current) return;
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
        const value = await invoke<Tree>('multiplexer_tree', { sessionId, ...serverArgs });
        if (generation.current === current) { setTree(value); setEdit(null); }
      }
    } catch (e) { if (generation.current === current) setError(errorMessage(e)); }
    finally { locked.current = false; if (generation.current === current) setBusy(false); }
  }
  async function loadPersistent(kind: 'herdr' | 'zellij') {
    if (locked.current) return;
    locked.current = true;
    const current = generation.current;
    setBusy(true); setError('');
    try {
      const sessions = await invoke<{ name: string }[]>('multiplexer_sessions', { sessionId, kind });
      if (generation.current === current) setPersistent(value => ({ ...value, [kind]: sessions }));
    } catch (e) { if (generation.current === current) setError(errorMessage(e)); }
    finally { locked.current = false; if (generation.current === current) setBusy(false); }
  }
  async function loadProjects() {
    if (locked.current) return;
    locked.current = true;
    const current = generation.current;
    setBusy(true); setError('');
    try {
      const rows = parseSnapshot(await invoke('agent_snapshot', { sessionId }));
      const values = [...new Set(rows.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(row => row.project).filter(path => path.length > 0 && !/[\x00-\x1f\x7f]/.test(path)))];
      if (generation.current === current) { setProjects(values); setProjectsLoaded(true); }
    } catch (e) { if (generation.current === current) setError(errorMessage(e)); }
    finally { locked.current = false; if (generation.current === current) setBusy(false); }
  }
  function begin(value: Edit, initial = '') { setEdit(value); setName(initial); setError(''); }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!edit || !name.trim()) return;
    if (edit.type === 'createSession') void run({ ...edit, name, directory });
    else if (edit.type === 'createWindow') void run({ type: 'createWindow', target: edit.target, name, directory });
    else void run({ type: edit.type, target: edit.target, name });
  }
  return <section className="tool-panel multiplexer-panel" aria-label="Multiplexer workspaces">
    <div className="tool-bar"><label>tmux server<input value={attached?.kind === 'tmux' ? tmuxServer : serverDraft} disabled={busy || attached?.kind === 'tmux'} onChange={event=>setServerDraft(event.target.value)} placeholder="default" /></label>
      {attached?.kind !== 'tmux' && <button className="subtle-button" disabled={busy || !validTmuxServer(serverDraft)} onClick={()=>{setError('');setSelectedServer(serverDraft);}}>Browse server</button>}<span>Server: {tmuxServer}</span></div>
    <div className="tool-bar"><h3>Workspaces</h3><button className="subtle-button" disabled={busy} onClick={() => void run()}><RefreshCw size={15} /> Refresh</button>
      {tree?.tmuxAvailable && <button className="subtle-button" disabled={busy} onClick={() => begin({ type: 'createSession' })}>New session</button>}</div>
    <div className="tool-bar"><label>Workspace layout<select value={layout} onChange={e => setLayout(e.target.value)}><option value="list">List</option><option value="accordion">Accordion</option><option value="grid">Grid</option></select></label><button className="subtle-button" disabled={busy} onClick={() => void loadProjects()}>Load recent projects</button></div>
    {projects.length > 0 && <label>Recent project directory<select value={projects.includes(directory) ? directory : ''} onChange={e => setDirectory(e.target.value)}><option value="" disabled>Choose a project</option>{projects.map(project => <option key={project} value={project}>{project}</option>)}</select></label>}
    {projectsLoaded && projects.length === 0 && <p>No recent projects in this host's agent history.</p>}
    {attached && attached.kind !== 'zellij' && <MultiplexerShortcuts key={`${sessionId}:${attached.kind}`} sessionId={sessionId} kind={attached.kind} />}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {busy && <p className="loading" role="status">Reading workspaces…</p>}
    {tree && <p className="muted">tmux {tree.tmuxAvailable ? 'available' : 'not installed'} · Herdr {tree.herdrAvailable ? 'detected' : 'not installed'} · Zellij {tree.zellijAvailable ? 'detected' : 'not installed'}</p>}
    {(tree?.herdrAvailable || tree?.zellijAvailable) && <div><label>Persistent session name<input value={persistentName} onChange={e => setPersistentName(e.target.value)} maxLength={200} disabled={busy} /></label>
      {(['herdr', 'zellij'] as const).filter(kind => kind === 'herdr' ? tree.herdrAvailable : tree.zellijAvailable).map(kind => <div key={kind}>
        <div className="tool-bar"><button className="subtle-button" disabled={busy} onClick={() => void loadPersistent(kind)}>List {kind} sessions</button>
          <button className="subtle-button" disabled={busy || !persistentName.trim()} onClick={() => void run(undefined, persistentName, kind)}>Open/create {kind} session</button></div>
        {persistent[kind]?.length === 0 && <p>No running {kind} sessions.</p>}
        {persistent[kind]?.map(session => <div className="mux-row" key={session.name}><strong>{kind}: {session.name}</strong><button className="subtle-button" disabled={busy} onClick={() => void run(undefined, session.name, kind)}>Attach {kind} {session.name}</button>{kind === 'herdr' ? <button className="subtle-button" disabled={busy} onClick={() => setHerdr(session.name)}>Browse Herdr {session.name}</button> : <button className="subtle-button" disabled={busy} onClick={() => setZellij(session.name)}>Control Zellij {session.name}</button>}</div>)}
      </div>)}<p>Browse a Herdr session for its workspace tree, or choose a Zellij session for its shortcut panel.</p></div>}
    {herdr && <HerdrPanel sessionId={sessionId} name={herdr} projectDirectory={directory} />}
    {zellij && <ZellijPanel key={`${sessionId}:${zellij}`} sessionId={sessionId} name={zellij} projectDirectory={directory} />}
    {edit && <form onSubmit={submit} aria-label="Workspace details"><label>Name<input autoFocus maxLength={200} value={name} onChange={e => setName(e.target.value)} required disabled={busy} /></label>
      {(edit.type === 'createSession' || edit.type === 'createWindow') && <label>Project directory<input value={directory} onChange={e => setDirectory(e.target.value)} required disabled={busy} placeholder="/home/user/project" /></label>}
      <button className="subtle-button" type="submit" disabled={busy || !name.trim()}>Save workspace</button><button className="subtle-button" type="button" disabled={busy} onClick={() => setEdit(null)}>Cancel</button></form>}
    {tree?.sessions.length === 0 && !busy && <div className="panel-empty"><Layers size={28} /><h3>No tmux sessions found.</h3><p>Create a session to keep agents running when you disconnect.</p></div>}
    <div className={`mux-list mux-layout-${layout}`}>{tree?.sessions.map(session => <details key={`${layout}:${session.id}`} open={layout !== 'accordion'}>
      <summary>{session.name} · {session.windows.length} windows</summary>
      <div className="tool-bar"><button className="subtle-button" disabled={busy} onClick={() => void run(undefined, session.name)}>Attach {session.name}</button>
        <button className="subtle-button" disabled={busy} onClick={() => begin({ type: 'renameSession', target: session.id }, session.name)}>Rename session</button>
        <button className="subtle-button" disabled={busy} onClick={() => begin({ type: 'createWindow', target: session.id })}>New window</button></div>
      {session.windows.map(window => <details key={window.id} open><summary>{window.index}: {window.name}{window.active ? ' · active' : ''}</summary>
        <div className="tool-bar"><button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'selectWindow', target: window.id })}>Select window {window.index}</button>
          <button className="subtle-button" disabled={busy} onClick={() => begin({ type: 'renameWindow', target: window.id }, window.name)}>Rename window</button></div>
        {window.panes.map(pane => <div className="mux-row" key={pane.id}><div><strong>{pane.command} · {pane.id}{pane.active ? ' · active' : ''}</strong><small>{pane.path}</small></div>
          <button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'selectPane', target: pane.id })}>Select {pane.id}</button>
          <button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'zoomPane', target: pane.id })}>Zoom {pane.id}</button>
          <button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'splitPane', target: pane.id, horizontal: true, directory: pane.path })}>Split {pane.id} left/right</button>
          <button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'splitPane', target: pane.id, horizontal: false, directory: pane.path })}>Split {pane.id} top/bottom</button>
        </div>)}
      </details>)}
    </details>)}</div>
    <p>Close the attached terminal tab to detach your client. Sessions and agents keep running on the host.</p>
  </section>;
}
