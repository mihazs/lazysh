import {t,useUi,formatNumber} from './i18n/core';
import ToolHelp from './ToolHelp';
import { useMountedAccess, useProtectedInvoke } from './access';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { errorMessage } from './SessionTools';

type Direction = 'left' | 'right' | 'up' | 'down';
type Pane = { id: number; title: string; command: string; tab: string; focused: boolean; columns: number; rows: number };
type Close = { type: 'closePane'; target: number } | { type: 'closeSession' };
type Action = { type: 'newTab'; name: string; directory: string } | { type: 'goToTab'; index: number } | { type: 'nextTab' | 'previousTab' | 'zoomPane' } | { type: 'newPane'; horizontal: boolean; directory: string }
  | Close | { type: 'renamePane'; target: number; name: string } | { type: 'renameSession'; name: string } | { type: 'resizePane'; target: number; direction: Direction; amount: number };
type Edit = { title: string; target?: number };
/** One press moves a divider one Zellij step, which Zellij sizes itself: it has no cell count. */
const resizeLabels = { left: 'zellijResizeLeft', right: 'zellijResizeRight', up: 'zellijResizeUp', down: 'zellijResizeDown' } as const;
const resizeGlyphs = { left: '←', right: '→', up: '↑', down: '↓' } as const;
const paneName = (pane: Pane) => `${t('zellijPane', { id: formatNumber(pane.id) })}${pane.command ? ` · ${pane.command}` : ''}`;
/**
 * `missing` is the version gate's list for this host's Zellij: pane and session actions show only where the gate names them as not missing, so a version
 * that was not tested stays navigation only. `attachedHere` hides Rename for the session this terminal is attached to, whose saved name would go stale.
 */
export default function ZellijPanel({ sessionId, name, projectDirectory = '.', missing, attachedHere = false, onRenamed, onClosed }: { sessionId: string; name: string; projectDirectory?: string; missing?: readonly string[]; attachedHere?: boolean; onRenamed?: (name: string) => void; onClosed?: () => void }) {
  useUi();
  const invoke = useProtectedInvoke();
  const {access,mounted}=useMountedAccess();
  const original=useRef({sessionId,name}).current;
  const latest=useRef({sessionId,name});latest.current={sessionId,name};
  const current=()=>mounted.current&&access.current()&&latest.current.sessionId===original.sessionId&&latest.current.name===original.name;
  const [title, setTitle] = useState('');
  const [directory, setDirectory] = useState('.');
  const [tab, setTab] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState(false);
  const [panes, setPanes] = useState<Pane[]>();
  const [edit, setEdit] = useState<Edit>();
  const [editName, setEditName] = useState('');
  const [closing, setClosing] = useState<{ action: Close; message: string }>();
  const closeMessageId = useId();
  const lock = useRef(false);
  const can = (capability: string) => missing !== undefined && !missing.includes(capability);
  useEffect(() => setDirectory(projectDirectory), [projectDirectory]);
  async function exclusive(work: () => Promise<void>) {
    if (lock.current||!current()) return false;
    lock.current = true; setBusy(true); setError('');
    try { await work(); return true; }
    catch (e) { if(current())setError(errorMessage(e)); return false; }
    finally { lock.current = false; if(current())setBusy(false); }
  }
  const run = (action: Action) => { setMessage(false); return exclusive(async () => { await invoke('zellij_action', { sessionId:original.sessionId, name:original.name, action }); if(current())setMessage(true); }); };
  const readPanes = () => exclusive(async () => { const rows = await invoke<Pane[]>('zellij_panes', { sessionId:original.sessionId, name:original.name }); if(current())setPanes(rows); });
  /** A pane action changes the list, so a list already on screen is read again once the action went through. */
  async function paneAction(action: Action) { if (await run(action) && panes) await readPanes(); }
  function beginRename(next: Edit, initial: string) { setEdit(next); setEditName(initial); setClosing(undefined); setError(''); }
  function askClose(action: Close, target: string) { setClosing({ action, message: t('muxCloseConfirm', { name: target }) }); setEdit(undefined); setError(''); }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!edit || !editName.trim()) return;
    if (edit.target === undefined) { if (await run({ type: 'renameSession', name: editName })) onRenamed?.(editName); return; }
    if (await run({ type: 'renamePane', target: edit.target, name: editName })) { setEdit(undefined); if (panes) await readPanes(); }
  }
  async function confirmClose() {
    if (!closing) return;
    const { action } = closing;
    setClosing(undefined);
    if (action.type === 'closeSession') { if (await run(action)) onClosed?.(); }
    else await paneAction(action);
  }
  function create(event: FormEvent) { event.preventDefault(); if (title.trim()) void run({ type: 'newTab', name: title, directory }); }
  return <section aria-label={t('zellijTitle',{name})}><h3>Zellij: {name}</h3><p>{t('zellijHint')}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}{(busy || message) && <p role="status">{busy ? t('muxSending') : t('zellijSent')}</p>}
    {closing && <div role="alertdialog" aria-label={t('zellijConfirmClose')} aria-describedby={closeMessageId} className="security-note"><p id={closeMessageId}>{closing.message}</p>
      <button className="subtle-button" disabled={busy} onClick={() => void confirmClose()}>{t('zellijConfirmClose')}</button><button className="subtle-button" disabled={busy} onClick={() => setClosing(undefined)}>{t('appCancel')}</button></div>}
    {edit && <form onSubmit={event => void save(event)} aria-label={edit.title}><label>{t('muxPromptName')}<input autoFocus maxLength={200} value={editName} required disabled={busy} onChange={e => setEditName(e.target.value)} /></label>
      <button className="subtle-button" type="submit" disabled={busy || !editName.trim()}>{t('muxPromptSave')}</button><button className="subtle-button" type="button" disabled={busy} onClick={() => setEdit(undefined)}>{t('appCancel')}</button></form>}
    <form onSubmit={create}><label>{t('zellijNewTabName')}<input value={title} maxLength={200} disabled={busy} required onChange={e => setTitle(e.target.value)} /></label><label>{t('zellijDirectory')}<input value={directory} maxLength={4096} disabled={busy} required onChange={e => setDirectory(e.target.value)} /></label><button className="subtle-button" disabled={busy || !title.trim()} type="submit">{t('zellijCreateTab')}</button></form>
    <div className="tool-bar"><button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'previousTab' })}>{t('gesturePreviousZellijTab')}</button><button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'nextTab' })}>{t('gestureNextZellijTab')}</button></div>
    <ToolHelp label={t('zellijQuickAbout')}>{t('zellijQuickHint')}</ToolHelp>
    <div className="mux-shortcuts" role="group" aria-label={t('zellijQuickTabs')}>
      {Array.from({length:20},(_,index)=>index+1).map(index=><button type="button" className="subtle-button" key={index} disabled={busy} onClick={()=>void run({type:'goToTab',index})}>{t('muxShortcutTab',{index:formatNumber(index)})}</button>)}
    </div>
    <form onSubmit={e => { e.preventDefault(); void run({ type: 'goToTab', index: tab }); }}><label>{t('zellijTabNumber')}<input type="number" min={1} max={1000} value={tab} disabled={busy} onChange={e => setTab(Number(e.target.value))} /></label><button className="subtle-button" disabled={busy || !Number.isInteger(tab) || tab < 1 || tab > 1000}>{t('zellijSelectTab')}</button></form>
    <div className="tool-bar"><button className="subtle-button" disabled={busy || !directory} onClick={() => void run({ type: 'newPane', horizontal: true, directory })}>{t('zellijSplitRight')}</button><button className="subtle-button" disabled={busy || !directory} onClick={() => void run({ type: 'newPane', horizontal: false, directory })}>{t('zellijSplitDown')}</button><button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'zoomPane' })}>{t('zellijZoom')}</button></div>
    {(can('rename') && !attachedHere || can('close')) && <div className="tool-bar">
      {can('rename') && !attachedHere && <button className="subtle-button" disabled={busy} onClick={() => beginRename({ title: t('zellijRenameSession') }, name)}>{t('zellijRenameSession')}</button>}
      {can('close') && <button className="subtle-button" disabled={busy} onClick={() => askClose({ type: 'closeSession' }, name)}>{t('zellijCloseSession')}</button>}</div>}
    {(can('rename') || can('close') || can('resize')) && <div><div className="tool-bar"><button className="subtle-button" disabled={busy} onClick={() => void readPanes()}>{t('zellijReadPanes')}</button></div>
      {panes?.length === 0 && <p>{t('zellijNoPanes')}</p>}
      {panes?.map(pane => { const id = formatNumber(pane.id); return <div className="mux-row" key={pane.id}>
        <div><strong>{paneName(pane)}{pane.focused ? ` · ${t('muxActive')}` : ''}</strong><small>{[pane.tab, `${formatNumber(pane.columns)}×${formatNumber(pane.rows)}`, pane.title].filter(Boolean).join(' · ')}</small></div>
        {can('rename') && <button className="subtle-button" disabled={busy} onClick={() => beginRename({ title: t('zellijRenamePane', { id }), target: pane.id }, pane.title)}>{t('zellijRenamePane', { id })}</button>}
        {can('resize') && (['left', 'right', 'up', 'down'] as const).map(direction => <button key={direction} className="subtle-button" disabled={busy} aria-label={t(resizeLabels[direction], { id })} onClick={() => void paneAction({ type: 'resizePane', target: pane.id, direction, amount: 1 })}>{resizeGlyphs[direction]}</button>)}
        {can('close') && <button className="subtle-button" disabled={busy} onClick={() => askClose({ type: 'closePane', target: pane.id }, paneName(pane))}>{t('zellijClosePane', { id })}</button>}
      </div>; })}</div>}
  </section>;
}
