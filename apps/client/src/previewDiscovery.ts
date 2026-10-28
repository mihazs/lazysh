import {invoke} from '@tauri-apps/api/core';
import type {AccessLease} from './access';
import {LocalUiError} from './i18n/localError';

// Retain only pending native requests. A replacement view cannot overlap its
// predecessor, even when revocation rejects ordinary protected invokes early.
const pending = new Set<string>();
export async function discoverPreviewListeners(lease: AccessLease, sessionId: string, allowPorts: number[] | null, probeHttp: boolean): Promise<unknown> {
  lease.assert();
  if (pending.has(sessionId)) throw new LocalUiError('previewDiscoveryFinishing');
  pending.add(sessionId);
  try {
    const rows = await invoke('discover_preview_ports', {sessionId, allowPorts, probeHttp}, {headers: lease.headers});
    lease.assert();
    return rows;
  } finally { pending.delete(sessionId); }
}
