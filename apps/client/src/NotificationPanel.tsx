import {t, useUi, formatDateTime} from './i18n/core';
import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { isPermissionGranted, onAction, registerActionTypes, requestPermission } from '@tauri-apps/plugin-notification';
import { collectInbox, getInbox, openInboxEvent, updateInbox, useInbox, type InboxSession } from './notificationStore';
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
  const names = { needs_attention: "inboxNeedsYou", working: "inboxWorking", done: "inboxDone" } as const;
  return <section className="tool-panel notification-panel" aria-label={t("inboxTitle")}>
    <h3>{t("inboxTitle")}</h3>
    <p>{t("inboxExplanation")}</p>
    <div className="tool-bar"><label><input type="checkbox" checked={state.monitoring} disabled={!isTauri()} onChange={event => updateInbox({ monitoring: event.target.checked })} />{t("inboxMonitor")}</label>
      {state.notifications ? <button onClick={() => updateInbox({ notifications: false })}>{t("inboxPause")}</button> : <button disabled={busy || !isTauri()} onClick={() => void enable()}>{t("inboxEnable")}</button>}
      <button disabled={busy || !state.notifications || !isTauri()} onClick={() => void test()}>{t("inboxTest")}</button>
      <button disabled={!state.monitoring || !isTauri()} onClick={() => window.dispatchEvent(new Event('lazysh-inbox-refresh'))}>{t("inboxRefresh")}</button>
      <button disabled={!state.rows.length} onClick={() => updateInbox({ rows: [] })}>{t("inboxClear")}</button>
    </div>
    <p>{t("inboxPrivacy")}</p>
    {!isTauri() && <p>{t("inboxNativeRequired")}</p>}
    {state.error && <p className="inline-error" role="alert">{state.error}</p>}
    {status && <p role="status">{t(status)}</p>}
    {state.rows.length === 0 && <p>{t("inboxEmpty")}</p>}
    <div className="notification-list">{state.rows.map(row => <article className="agent-card" key={row.id}><strong>{t(names[row.state])} · {row.agent}</strong><p>{row.hostName} · <code>{row.project}</code></p><time dateTime={row.updatedAt}>{formatDateTime(new Date(row.updatedAt))}</time><div>
      <button disabled={!sessions.some(session => session.id === row.sessionId && session.hostId === row.hostId && session.connected)} onClick={() => { if (!openInboxEvent(row.eventId, sessions)) setStatus("inboxConnectionEnded"); }}>{t("inboxOpenConnected")}</button>
      <button onClick={() => updateInbox({ rows: state.rows.filter(event => event.id !== row.id) })}>{t("inboxArchive")}</button>
    </div></article>)}</div>
  </section>;
}
