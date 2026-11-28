import { Fragment, useEffect, useRef, useState } from 'react';
import { api as nativeApi, type TmuxJumpSnapshot } from './bridge';
import { bindProtectedInvoke, captureAccess, useProtectedApi } from './access';
import { parseSnapshot, type AgentSession } from './AgentPanel';
import { paneAgent } from './agentPaneIdentity';
import { errorMessage } from './SessionTools';
import {t,useUi,formatNumber} from './i18n/core';
import {readMuxLayout,writeMuxLayout,type MuxLayout} from './muxLayout';

/** Jump To for the tmux display `sessionId`, or, with `zellij`, for the tabs of that named Zellij session. */
export default function TmuxJumpPanel({ sessionId, zellij, paneServer, onClose, onJump, onBusyChange }: {
  sessionId: string; zellij?: string; /** `tmux:<label>` of the attached server: a report of another server names none of these panes. */paneServer?: string; onClose: () => void; onJump?: (snapshot: TmuxJumpSnapshot) => void; onBusyChange?:(busy:boolean)=>void;
}) {
  useUi();
  const api = useProtectedApi(nativeApi);
  const access = useRef(captureAccess()).current;
  const [snapshot, setSnapshot] = useState<TmuxJumpSnapshot | null>(null);
  const [reports, setReports] = useState<AgentSession[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [layout, setLayout] = useState(readMuxLayout);
  const revision = useRef(0);
  const pending = useRef(false);
  const busyListener=useRef(onBusyChange);busyListener.current=onBusyChange;
  function refresh() {
    if(!access.current() || pending.current)return;
    const request=++revision.current;
    setSnapshot(null);setReports([]);setBusy(true);setError('');pending.current=true;busyListener.current?.(true);
    void (zellij===undefined ? api.tmuxJumpSnapshot(sessionId) : api.zellijJumpSnapshot(sessionId,zellij)).then(value=>{
      if(!access.current() || revision.current!==request)return;
      setSnapshot(value);
      // The agent a pane runs comes from the companion's reports; a host without them just shows the panes.
      if(value.sessions.some(session=>session.windows.some(window=>window.panes?.length)))
        void bindProtectedInvoke(access)('agent_snapshot',{sessionId}).then(rows=>{if(access.current() && revision.current===request)setReports(parseSnapshot(rows));}).catch(()=>{});
    }).catch(reason=>{
      if(access.current() && revision.current===request)setError(errorMessage(reason));
    }).finally(()=>{
      if(access.current() && revision.current===request){pending.current=false;setBusy(false);busyListener.current?.(false);}
    });
  }
  useEffect(()=>{
    pending.current=false;refresh();
    return()=>{revision.current++;pending.current=false;busyListener.current?.(false);};
  },[sessionId,zellij]);
  useEffect(() => {
    if (!access.current()) return;
    writeMuxLayout(layout);
  }, [layout]);
  async function jump(targetSessionId: string, windowId: string, paneId?: string) {
    if (!access.current() || pending.current || !snapshot || snapshot.sharedClients) return;
    if (snapshot.current.sessionId === targetSessionId && snapshot.current.windowId === windowId && (paneId === undefined || snapshot.current.paneId === paneId)) { onClose(); return; }
    pending.current = true; setBusy(true); setError('');busyListener.current?.(true);
    const request = revision.current;
    try {
      // Zellij answers a jump with nothing and applies it a moment later: the target is the current row from now on.
      const result = zellij===undefined
        ? await api.tmuxJump(sessionId, snapshot.generation, targetSessionId, windowId, ...(paneId === undefined ? [] : [paneId]))
        : await api.zellijJump(sessionId, zellij, Number(windowId)).then(()=>({...snapshot,current:{sessionId:targetSessionId,windowId}}));
      if (access.current() && revision.current === request) { setSnapshot(result);onJump?.(result); onClose(); }
    } catch (reason) {
      if (access.current() && revision.current === request) {
        // Never allow another action against a failed or retired binding's snapshot.
        setSnapshot(null); setError(errorMessage(reason));
      }
    } finally {
      if (access.current() && revision.current === request) { pending.current = false; setBusy(false);busyListener.current?.(false); }
    }
  }
  return <section className="multiplexer-panel" aria-label={`${zellij===undefined?'tmux':'Zellij'} ${t('appJumpTo')}`}>
    <div className="tool-bar"><label>{t('jumpLayout')}<select value={layout} onChange={event => { if (access.current()) setLayout(event.target.value as MuxLayout); }}>
      <option value="list">{t('preferencesList')}</option><option value="accordion">{t('jumpAccordion')}</option><option value="grid">{t('jumpGrid')}</option>
    </select></label><button className="subtle-button" disabled={busy} onClick={refresh}>{t('agentsRefresh')}</button></div>
    {busy && <p role="status">{t(zellij===undefined?'appReadingTmuxDestinations':'appReadingZellijDestinations')}</p>}
    {error && <p role="alert">{t('jumpUnavailable')} {error}</p>}
    <div className={`mux-list mux-layout-${layout}`}>{snapshot?.sessions.map(session => <details key={`${layout}:${session.id}`} open={layout !== 'accordion' || session.id === snapshot.current.sessionId}>
      <summary>{session.name}</summary>
      {session.windows.map(window => {
        const here = session.id === snapshot.current.sessionId && window.id === snapshot.current.windowId;
        // The one current marker sits on the deepest row the tree shows: the pane when the snapshot lists it, else the window.
        const shown = here ? window.panes?.find(pane => pane.id === snapshot.current.paneId) : undefined;
        const current = here && !shown;
        return <Fragment key={window.id}><div className="mux-row"><button className="subtle-button" disabled={busy || snapshot.sharedClients} aria-current={current ? 'location' : undefined} onClick={() => void jump(session.id, window.id)}>
          {formatNumber(window.index)}: {window.name}{current ? ` · ${t('jumpCurrent')}` : ''}
        </button></div>
        {window.panes?.map(pane => {
          const agent = paneAgent(reports, pane.id, paneServer);
          return <div className="mux-row mux-pane-row" key={pane.id}><button className="subtle-button" disabled={busy} aria-current={pane === shown ? 'location' : undefined} onClick={() => void jump(session.id, window.id, pane.id)}>
            {t('jumpPane')} {formatNumber(pane.index)}: {pane.title || pane.command || pane.id}{agent ? ` · ${agent}` : ''}{window.zoomed && pane.active ? ` · ${t('jumpZoomed')}` : ''}{pane === shown ? ` · ${t('jumpCurrent')}` : ''}
          </button></div>;
        })}</Fragment>;
      })}
    </details>)}</div>
    {snapshot?.sharedClients && <p role="status">{t('jumpZellijSharedSession')}</p>}
    <p>{t(zellij===undefined?'jumpHint':'jumpHintZellij')}</p>
  </section>;
}
