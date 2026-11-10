import {t, useUi, formatDateTime, formatNumber} from './i18n/core';
import { Archive, ChevronDown, ChevronRight, Inbox, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { formatRelativeTime, pathBasename, useNow } from './relativeTime';
import { StatusRing, reportedTones } from './AgentStatus';
import './NotificationPanel.css';
import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { isPermissionGranted, onAction, registerActionTypes, requestPermission } from '@tauri-apps/plugin-notification';
import { collectInbox, getInbox, openInboxEvent, updateInbox, useInbox, type InboxRow, type InboxSession } from './notificationStore';

const inboxGroups = [['needs_attention', 'inboxNeedsYou'], ['working', 'inboxWorking'], ['done', 'inboxDone']] as const;
import { errorMessage } from './SessionTools';

export function NotificationMonitor({ sessions }: { sessions: InboxSession[] }) {
  const invoke = useProtectedInvoke();
  const state = useInbox();
  const currentSessions = useRef(sessions);
  currentSessions.current = sessions;
  const baselineHosts = useRef(new Set<string>());
  const connected = sessions.filter(session => session.connected);
  const sessionKey = connected.map(session => session.id).sort().join(':');
  useEffect(() => {
    if (!state.monitoring || !isTauri()) { baselineHosts.current.clear(); return; }
    let active = true;
    let running = false;
    async function poll() {
      if (!active || running || !getInbox().monitoring) return;
      running = true;
      const hosts = [...new Map(currentSessions.current.filter(session => session.connected).map(session => [session.hostId, session])).values()].slice(0, 32);
      const failures: string[] = [];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, hosts.length) }, async () => {
        while (active && getInbox().monitoring) {
          const session = hosts[next++];
          if (!session) return;
          try {
            const snapshot = await invoke('agent_snapshot', { sessionId: session.id });
            const valid = () => active && getInbox().monitoring && currentSessions.current.some(item => item.id === session.id && item.connected);
            if (!valid()) continue;
            const alerts = await collectInbox(session, snapshot, !baselineHosts.current.has(session.hostId), valid, false);
            if (!valid()) continue;
            baselineHosts.current.add(session.hostId);
            if (alerts.length && getInbox().notifications && await isPermissionGranted()) {
              for (const event of alerts) {
                if (!valid() || !getInbox().notifications) break;
                await invoke('notify_agent_attention', { sessionId: session.id, agent: event.agent, project: event.project, eventId: event.eventId });
              }
            }
          } catch (e) { failures.push(`${session.name.slice(0, 80)}: ${errorMessage(e).slice(0, 300)}`); }
        }
      }));
      if (active) updateInbox({ error: failures.join('\n').slice(0, 2000) });
      running = false;
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 15000);
    const refresh = () => void poll();
    window.addEventListener('lazysh-inbox-refresh', refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('lazysh-inbox-refresh', refresh); };
  }, [state.monitoring, sessionKey]);
  useEffect(() => {
    if (!state.notifications || !isTauri()) return;
    let active = true;
    let remove: (() => void) | undefined;
    void registerActionTypes([{ id: 'lazysh-agent', actions: [{ id: 'open-session', title: t("inboxOpenSessionAction"), foreground: true }] }]).then(() => onAction(event => {
      const id = event.notification?.extra?.lazyshEventId;
      const sessionId = event.notification?.extra?.lazyshSessionId;
      if (active && typeof id === 'string' && typeof sessionId === 'string' && ['tap', 'open-session'].includes(event.actionId)) openInboxEvent(id, currentSessions.current, sessionId);
    })).then(listener => { if (active) remove = () => void listener.unregister(); else void listener.unregister(); }).catch(e => updateInbox({ error: errorMessage(e) }));
    return () => { active = false; remove?.(); };
  }, [state.notifications]);
  return null;
}

export default function NotificationPanel({ sessions }: { sessions: InboxSession[] }) {
  const invoke = useProtectedInvoke();
  useUi();
  const state = useInbox();
  const [busy, setBusy] = useState(false);
  const android = isTauri() && /Android/i.test(navigator.userAgent);
  const [status, setStatus] = useState<'' | 'inboxEnabled' | 'inboxPermissionDenied' | 'inboxTestSubmitted' | 'inboxConnectionEnded'>('');
  async function enable() {
    setBusy(true); setStatus('');
    try {
      const granted = await isPermissionGranted() || await requestPermission() === 'granted';
      updateInbox({ notifications: granted });
      setStatus(granted ? "inboxEnabled" : "inboxPermissionDenied");
    } catch (e) { updateInbox({ error: errorMessage(e) }); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setStatus('');
    try { await invoke('notification_test'); setStatus("inboxTestSubmitted"); }
    catch (e) { updateInbox({ error: errorMessage(e) }); }
    finally { setBusy(false); }
  }
  const [settingsOpen, setSettingsOpen] = useState(() => !state.monitoring || state.rows.length === 0);
  const [collapsed, setCollapsed] = useState<Partial<Record<InboxRow['state'], boolean>>>({});
  const now = useNow(30000, state.rows.length > 0);
  const groups = inboxGroups.map(([group, label]) => [group, label, state.rows.filter(row => row.state === group)] as const).filter(([, , rows]) => rows.length);
  return <section className="tool-panel notification-panel" aria-label={t("inboxTitle")}>
    <div className="inbox-header">
      <h3>{t("inboxTitle")}</h3>
      <button type="button" className="icon-button" aria-label={t("inboxRefresh")} title={t("inboxRefresh")} disabled={!state.monitoring || !isTauri()} onClick={() => window.dispatchEvent(new Event('lazysh-inbox-refresh'))}><RefreshCw size={16} aria-hidden="true" /></button>
      <button type="button" className="icon-button" aria-label={t("inboxClear")} title={t("inboxClear")} disabled={!state.rows.length} onClick={() => updateInbox({ rows: [] })}><Trash2 size={16} aria-hidden="true" /></button>
    </div>
    <p className="inbox-status" data-monitoring={state.monitoring ? 'true' : 'false'}>{state.monitoring ? t("inboxMonitoringOn") : t("inboxMonitoringOff")}</p>
    {state.error && <p className="inline-error" role="alert">{state.error}</p>}
    {status && <p role="status">{t(status)}</p>}
    {state.rows.length === 0 && <div className="inbox-empty"><Inbox size={28} aria-hidden="true" /><strong>{t("inboxEmptyTitle")}</strong><span>{t("inboxEmpty")}</span></div>}
    {groups.map(([group, label, rows]) => <div className="inbox-group" data-state={group} key={group}>
      <h4><button type="button" className="status-group-toggle" aria-expanded={!collapsed[group]} onClick={() => setCollapsed(previous => ({ ...previous, [group]: !previous[group] }))}>
        <span>{t(label)}</span><span className="status-group-count">{formatNumber(rows.length)}</span><ChevronDown size={14} aria-hidden="true" />
      </button></h4>
      {!collapsed[group] && <div className="notification-list">{rows.map(row => {
        const connected = sessions.some(session => session.id === row.sessionId && session.hostId === row.hostId && session.connected);
        return <article className="inbox-row" key={row.id} data-state={row.state} aria-labelledby={`inbox-${row.id}`}>
          <StatusRing tone={reportedTones[row.state]} />
          <div className="inbox-row-body">
            <strong id={`inbox-${row.id}`}>{row.agent}</strong>
            <span className="inbox-row-context"><span className="inbox-project">{pathBasename(row.project)}</span><span>{row.hostName}</span><time dateTime={row.updatedAt} title={formatDateTime(new Date(row.updatedAt))}>{formatRelativeTime(row.updatedAt, now)}</time></span>
            <code>{row.project}</code>
          </div>
          <div className="inbox-row-actions">
            <button type="button" className="icon-button" aria-label={t("inboxArchive")} title={t("inboxArchive")} onClick={() => updateInbox({ rows: state.rows.filter(event => event.id !== row.id) })}><Archive size={16} aria-hidden="true" /></button>
            <button type="button" className="icon-button inbox-open" aria-label={t("inboxOpenConnected")} title={connected ? t("inboxOpenConnected") : t("inboxConnectionEnded")} disabled={!connected} onClick={() => { if (!openInboxEvent(row.eventId, sessions)) setStatus("inboxConnectionEnded"); }}><ChevronRight size={18} aria-hidden="true" /></button>
          </div>
        </article>;
      })}</div>}
    </div>)}
    <details className="inbox-settings" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}>
      <summary><Settings2 size={16} aria-hidden="true" />{t("inboxSettings")}</summary>
      <p>{t("inboxExplanation")}</p>
      <label className="inbox-switch"><input type="checkbox" checked={state.monitoring} disabled={!isTauri()} onChange={event => updateInbox({ monitoring: event.target.checked })} />{t("inboxMonitor")}</label>
      <div className="inbox-settings-actions">
        {state.notifications ? <button type="button" onClick={() => updateInbox({ notifications: false })}>{t("inboxPause")}</button> : <button type="button" disabled={busy || !isTauri()} onClick={() => void enable()}>{t("inboxEnable")}</button>}
        <button type="button" disabled={busy || !state.notifications || !isTauri()} onClick={() => void test()}>{t("inboxTest")}</button>
        {android && <button type="button" onClick={() => void invoke('open_notification_settings').catch(e => updateInbox({ error: errorMessage(e) }))}>{t("inboxAndroidSettings")}</button>}
      </div>
      <p>{t("inboxPrivacy")}</p>
      {!isTauri() && <p>{t("inboxNativeRequired")}</p>}
    </details>
  </section>;
}
