import {t,useUi,formatNumber} from './i18n/core';
import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { errorMessage } from './SessionTools';

type Workspace = { workspace_id: string; label: string; focused: boolean; agent_status: string };
type Tab = { tab_id: string; workspace_id: string; label: string; number: number; focused: boolean; agent_status: string };
type Pane = { pane_id: string; workspace_id: string; tab_id: string; cwd: string; focused: boolean; agent_status: string };
type Tree = { workspaces: Workspace[]; tabs: Tab[]; panes: Pane[] };
type Action =
  | { type: 'createWorkspace'; label: string; directory: string }
  | { type: 'renameWorkspace' | 'renameTab'; target: string; label: string }
  | { type: 'createTab'; workspace: string; label: string; directory: string }
  | { type: 'focusWorkspace' | 'focusTab' | 'focusAgent' | 'zoomPane'; target: string }
  | { type: 'splitPane'; target: string; horizontal: boolean; directory: string };
type Edit = { type: 'createWorkspace' | 'renameWorkspace' | 'createTab' | 'renameTab'; target?: string };

export default function HerdrPanel({ sessionId, name, projectDirectory = '.' }: { sessionId: string; name: string; projectDirectory?: string }) {
  useUi();
  const invoke = useProtectedInvoke();
  const [tree, setTree] = useState<Tree | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [label, setLabel] = useState('');
  const [directory, setDirectory] = useState('.');
  const generation = useRef(0);
  const locked = useRef(false);
  useEffect(() => setDirectory(projectDirectory), [projectDirectory]);
  useEffect(() => {
    const current = ++generation.current;
    setTree(null); setError(''); setEdit(null); setBusy(true);
    void invoke<Tree>('herdr_tree', { sessionId, name }).then(value => { if (generation.current === current) setTree(value); })
      .catch(e => { if (generation.current === current) setError(errorMessage(e)); })
      .finally(() => { if (generation.current === current) setBusy(false); });
    return () => { generation.current++; };
  }, [sessionId, name]);
  async function run(action?: Action) {
    if (locked.current) return;
    locked.current = true;
    const current = generation.current;
    setBusy(true); setError('');
    try {
      if (action) await invoke('herdr_action', { sessionId, name, action });
      const value = await invoke<Tree>('herdr_tree', { sessionId, name });
      if (generation.current === current) { setTree(value); setEdit(null); }
    } catch (e) { if (generation.current === current) setError(errorMessage(e)); }
    finally { locked.current = false; if (generation.current === current) setBusy(false); }
  }
  function begin(edit: Edit, initial = '') { setEdit(edit); setLabel(initial); }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!edit || !label.trim()) return;
    if (edit.type === 'createWorkspace') void run({ type: 'createWorkspace', label, directory });
    else if (edit.type === 'createTab') void run({ type: 'createTab', workspace: edit.target!, label, directory });
    else void run({ type: edit.type, target: edit.target!, label });
  }
  return <section aria-label={t('herdrTitle',{name})}>
    <div className="tool-bar"><h3>Herdr: {name}</h3><button className="subtle-button" disabled={busy} onClick={() => void run()}>{t('herdrRefresh')}</button><button className="subtle-button" disabled={busy} onClick={() => begin({ type: 'createWorkspace' })}>{t('herdrNewWorkspace')}</button></div>
    {busy && <p role="status">{t('herdrReading')}</p>}{error && <p className="inline-error" role="alert">{error}</p>}
    {edit && <form onSubmit={submit}><label>{t('herdrLabel')}<input autoFocus value={label} maxLength={200} required disabled={busy} onChange={e => setLabel(e.target.value)} /></label>
      {(edit.type === 'createWorkspace' || edit.type === 'createTab') && <label>{t('herdrDirectory')}<input value={directory} maxLength={4096} required disabled={busy} onChange={e => setDirectory(e.target.value)} /></label>}
      <button className="subtle-button" disabled={busy || !label.trim()} type="submit">{t('herdrSave')}</button><button className="subtle-button" disabled={busy} type="button" onClick={() => setEdit(null)}>{t('appCancel')}</button></form>}
    {tree?.workspaces.map(workspace => <details key={workspace.workspace_id} open><summary>{workspace.label} · {workspace.agent_status}{workspace.focused ? ` · ${t('herdrFocused')}` : ''}</summary>
      <div className="tool-bar"><button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'focusWorkspace', target: workspace.workspace_id })}>{t('herdrFocus',{id:workspace.workspace_id})}</button><button className="subtle-button" disabled={busy} onClick={() => begin({ type: 'renameWorkspace', target: workspace.workspace_id }, workspace.label)}>{t('herdrRenameWorkspace')}</button><button className="subtle-button" disabled={busy} onClick={() => begin({ type: 'createTab', target: workspace.workspace_id })}>{t('herdrNewTab')}</button></div>
      {tree.tabs.filter(tab => tab.workspace_id === workspace.workspace_id).map(tab => <details key={tab.tab_id} open><summary>{formatNumber(tab.number)}: {tab.label} · {tab.agent_status}{tab.focused ? ` · ${t('herdrFocused')}` : ''}</summary>
        <div className="tool-bar"><button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'focusTab', target: tab.tab_id })}>{t('herdrFocus',{id:tab.tab_id})}</button><button className="subtle-button" disabled={busy} onClick={() => begin({ type: 'renameTab', target: tab.tab_id }, tab.label)}>{t('herdrRenameTab')}</button></div>
        {tree.panes.filter(pane => pane.tab_id === tab.tab_id).map(pane => <div className="mux-row" key={pane.pane_id}><div><strong>{pane.pane_id} · {pane.agent_status}{pane.focused ? ` · ${t('herdrFocused')}` : ''}</strong><small>{pane.cwd}</small></div>
          <button className="subtle-button" disabled={busy || pane.agent_status === 'unknown'} onClick={() => void run({ type: 'focusAgent', target: pane.pane_id })}>{t('herdrFocusAgent',{id:pane.pane_id})}</button><button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'zoomPane', target: pane.pane_id })}>{t('muxZoom',{id:pane.pane_id})}</button>
          <button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'splitPane', target: pane.pane_id, horizontal: true, directory: pane.cwd })}>{t('herdrSplitRight',{id:pane.pane_id})}</button><button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'splitPane', target: pane.pane_id, horizontal: false, directory: pane.cwd })}>{t('herdrSplitDown',{id:pane.pane_id})}</button>
        </div>)}
      </details>)}
    </details>)}
  </section>;
}
