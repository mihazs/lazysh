import {invoke} from '@tauri-apps/api/core';
import type {AccessLease} from './access';
import {LocalUiError} from './i18n/localError';
import {parseOptionalHostFeatures} from './hostFeatures';

// Retain only pending native requests. A replacement view cannot overlap its
// predecessor, even when revocation rejects ordinary protected invokes early.
const pending = new Set<string>();
/** What a discovery answers when the host's port-scan switch is off: nothing was scanned. */
export const PORT_SCAN_DISABLED = Symbol('port scan disabled on this host');
// Scanning runs over this app's own SSH connection, not the companion, so the app has to read and obey the host's switch.
export async function discoverPreviewListeners(lease: AccessLease, sessionId: string, allowPorts: number[] | null, probeHttp: boolean): Promise<unknown> {
  lease.assert();
  if (pending.has(sessionId)) throw new LocalUiError('previewDiscoveryFinishing');
  pending.add(sessionId);
  try {
    const features = parseOptionalHostFeatures(await invoke('get_host_features', {sessionId}, {headers: lease.headers}));
    lease.assert();
    if (features && !features.portScanEnabled) return PORT_SCAN_DISABLED;
    const rows = await invoke('discover_preview_ports', {sessionId, allowPorts, probeHttp}, {headers: lease.headers});
    lease.assert();
    return rows;
  } finally { pending.delete(sessionId); }
}
