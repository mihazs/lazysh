import {LocalUiError} from './i18n/localError';
import type {api as nativeApi} from './bridge';

/** `~`, `$HOME` and `${HOME}` stand for the host's login directory, alone or before a `/`. */
const HOME = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;
const homes = new Map<string, Promise<string>>();

/** Expands a leading home reference against an absolute `home`; `~name` is refused, other paths stay as typed. */
export function expandHome(path: string, home: string): string {
  if (/^~[^/]/.test(path)) throw new LocalUiError('filesHomeUser');
  const match = HOME.exec(path);
  if (!match) return path;
  const rest = path.slice(match[0].length).replace(/^\/+|\/+$/g, '');
  const base = home.replace(/[\\/]+$/, '');
  return rest ? `${base}/${rest}` : base || '/';
}

/**
 * The one place the app turns a typed or printed host path into the path it sends to the host:
 * `~` resolves to the home the host itself reports (SFTP's canonical starting directory), asked
 * once per session. Paths without a home reference return unchanged without a native call.
 */
export async function resolveHostPath(api: Pick<typeof nativeApi, 'hostHome'>, sessionId: string, path: string): Promise<string> {
  if (!/^(?:~|\$HOME|\$\{HOME\})/.test(path)) return path;
  let home = homes.get(sessionId);
  if (!home) {
    home = api.hostHome(sessionId);
    homes.set(sessionId, home);
    home.catch(() => homes.delete(sessionId));
  }
  return expandHome(path, await home);
}
