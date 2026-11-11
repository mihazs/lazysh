import {useEffect, useRef, useState} from 'react';
import {captureAccess} from './access';
import type {api as nativeApi, HostFileAction, HostFileProgress, HostFileStat} from './bridge';
import {captureUiError, LocalUiError, type UiErrorCause} from './i18n/localError';

type Api = Pick<typeof nativeApi, 'hostFileStat' | 'hostFileDownload' | 'hostFileCancel' | 'hostFileDeliver'>;
/** Mirrors the native threshold above which the user confirms a download first. */
export const LARGE_FILE = 50 * 1024 * 1024;
export type Transfer =
  | {phase: 'idle'}
  | {phase: 'confirm'; stat: HostFileStat; action: HostFileAction}
  | {phase: 'running'; name: string; progress: HostFileProgress; cancelling: boolean}
  | {phase: 'done'; action: HostFileAction; location: string | null}
  | {phase: 'cancelled'}
  | {phase: 'failed'; error: UiErrorCause};
type Job = {id: string; cancelled: boolean; name: string};
const CANCELLED = ['transfer_cancelled', 'exchange_cancelled'];
const wasCancelled = (error: unknown) => !!error && typeof error === 'object' && 'kind' in error && CANCELLED.includes(String(error.kind));

/**
 * One host file at a time: confirm a symbolic link or a large file, stream a private copy with progress,
 * then save, open or share it. A saved copy is discarded at once. A copy another app may still be reading
 * (open, share) stays; native code keeps only the newest few and deletes the rest at every app start.
 */
export function useHostFile(api: Api, sessionId: string) {
  const access = useRef(captureAccess()).current;
  const alive = useRef(true);
  const job = useRef<Job | null>(null);
  const [state, setState] = useState<Transfer>({phase: 'idle'});
  const live = () => alive.current && access.current();
  const show = (next: Transfer) => { if (live()) setState(next); };
  const discard = (id: string) => void api.hostFileCancel(sessionId, id).catch(() => {});
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (job.current) discard(job.current.id);
    };
  }, [sessionId]);

  async function run(stat: HostFileStat, action: HostFileAction) {
    const current: Job = {id: crypto.randomUUID(), cancelled: false, name: stat.name};
    job.current = current;
    const running = (progress: HostFileProgress): Transfer => ({phase: 'running', name: stat.name, progress, cancelling: current.cancelled});
    show(running({bytes: 0, total: stat.size}));
    try {
      await api.hostFileDownload(sessionId, stat.path, current.id, {followLink: stat.link !== null, allowLarge: stat.size > LARGE_FILE}, progress => {
        if (job.current === current) show(running(progress));
      });
      if (current.cancelled) throw {kind: 'transfer_cancelled'};
      const delivered = await api.hostFileDeliver(sessionId, current.id, action);
      if (action === 'save') discard(current.id);
      show({phase: 'done', action, location: delivered.location});
    } catch (error) {
      discard(current.id);
      show(current.cancelled || wasCancelled(error) ? {phase: 'cancelled'} : {phase: 'failed', error: captureUiError(error)});
    } finally {
      if (job.current === current) job.current = null;
    }
  }
  return {
    state,
    busy: state.phase === 'running' || job.current !== null,
    /** `known` is what the caller already learned about the file; it is asked again when missing. */
    async start(path: string, action: HostFileAction, known: HostFileStat | null = null) {
      if (job.current) return;
      show({phase: 'idle'});
      try {
        const stat = known ?? await api.hostFileStat(sessionId, path);
        if (!live()) return;
        if (stat.kind !== 'file') throw new LocalUiError('filesNotFile');
        if (stat.link !== null || stat.size > LARGE_FILE) show({phase: 'confirm', stat, action});
        else await run(stat, action);
      } catch (error) {
        show({phase: 'failed', error: captureUiError(error)});
      }
    },
    confirm() { if (state.phase === 'confirm' && !job.current) void run(state.stat, state.action); },
    dismiss() { if (state.phase !== 'running') show({phase: 'idle'}); },
    cancel() {
      const current = job.current;
      if (!current || current.cancelled) return;
      current.cancelled = true;
      show({phase: 'running', name: current.name, progress: state.phase === 'running' ? state.progress : {bytes: 0, total: null}, cancelling: true});
      void api.hostFileCancel(sessionId, current.id).catch(() => {});
    },
  };
}
