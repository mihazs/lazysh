import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { accessControl, accessSnapshot, acknowledgeAccessReady, applyAccessStatus, useAccessSnapshot } from './access';
import type { LiveSession } from './terminal';
import { forgetSession } from './pendingSessions';

/** Native owns sessions; retain xterm buffers while transient tools and drafts unmount. */
export type SessionRegistry = { sessions: LiveSession[]; activeId: string | null };
export default function AccessShell({ native, children }: {
  native: boolean; children: (registry: SessionRegistry) => ReactNode;
}) {
  const registry = useRef<SessionRegistry>({ sessions: [], activeId: null }).current;
  const { status, epoch } = useAccessSnapshot();
  const [initialized, setInitialized] = useState(!native);
  const [error, setError] = useState('');
  useEffect(() => () => {
    // The shell lifetime is the renderer lifetime, unlike WorkspaceApp's lock-driven remounts.
    for (const session of registry.sessions) forgetSession(session.id);
  }, [registry]);
  useEffect(() => {
    if (!native) return;
    let alive = true; let stop: (() => void) | undefined;
    void (async () => {
      try {
        const remove = await listen<unknown>('lazysh-app-lock', event => {
          if (!alive) return;
          try { applyAccessStatus(event.payload); } catch { setError('Native app lock status is unavailable.'); }
        });
        if (!alive) { remove(); return; }
        stop = remove;
        const initialEpoch = accessSnapshot().epoch;
        const value = await accessControl.status();
        if (!alive) return;
        if (accessSnapshot().epoch === initialEpoch) applyAccessStatus(value);
        setInitialized(true);
      } catch { if (alive) setError('Native app lock status is unavailable. Restart lazysh to retry.'); }
    })();
    return () => { alive = false; stop?.(); };
  }, [native]);
  useEffect(() => {
    if (!native || !initialized || !status?.initialized || status.locked) return;
    // Effects run after React commits the fresh tree; the native cover remains until this acknowledgement.
    const current = epoch;
    void accessControl.ready(status.generation).then(() => acknowledgeAccessReady(current)).catch(() => {
      if (accessSnapshot().epoch === current) setError('Native app unlock could not finish.');
    });
  }, [native, initialized, status?.initialized, status?.locked, status?.generation, epoch]);
  if (native && (error || !initialized || !status?.initialized || status.locked)) {
    return <main aria-label="App access"><h1>{status?.locked ? 'lazysh is locked' : 'Checking device access…'}</h1>
      <p>{error || (status?.locked ? 'Use the native Unlock control to authenticate on this device.' : 'Waiting for the native access check.')}</p>
    </main>;
  }
  return <Fragment key={native ? epoch : 'browser'}>{children(registry)}</Fragment>;
}
