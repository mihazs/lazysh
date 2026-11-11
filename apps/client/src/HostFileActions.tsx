import {useEffect, useState} from 'react';
import {Download, ExternalLink, Share2} from 'lucide-react';
import {t, useUi, formatNumber} from './i18n/core';
import {uiErrorText} from './i18n/localError';
import {useProtectedApi} from './access';
import {api as nativeApi, type HostFileAction, type HostFileStat} from './bridge';
import {useHostFile} from './useHostFile';
import './FilePreview.css';

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${formatNumber(value, {maximumFractionDigits: unit === 0 ? 0 : 1})} ${units[unit]}`;
}
const doneKeys = {save: 'filesSaved', open: 'filesOpened', share: 'filesShared'} as const;

/** Open with another app, download or share the selected host file: the copy comes over SFTP (or the local disk) with progress and cancel. */
export default function HostFileActions({sessionId, path}: {sessionId: string; path: string}) {
  useUi();
  const api = useProtectedApi(nativeApi);
  const file = useHostFile(api, sessionId);
  const [stat, setStat] = useState<HostFileStat | null>(null);
  useEffect(() => {
    let current = true;
    setStat(null);
    api.hostFileStat(sessionId, path).then(value => { if (current) setStat(value); }, () => {});
    return () => { current = false; };
  }, [sessionId, path]);
  const {state} = file;
  const actions = stat?.actions ?? ['save', 'open'];
  const press = (action: HostFileAction) => void file.start(path, action, stat);
  const name = state.phase === 'confirm' ? state.stat.name : '';
  return <>
    <div className="file-actions" role="group" aria-label={t('filesActions')}>
      {actions.includes('open') && <button type="button" className="subtle-button" disabled={file.busy} onClick={() => press('open')}><ExternalLink size={15}/> {t('filesOpenWith')}</button>}
      {actions.includes('save') && <button type="button" className="subtle-button" disabled={file.busy} onClick={() => press('save')}><Download size={15}/> {t('filesDownload')}</button>}
      {actions.includes('share') && <button type="button" className="subtle-button" disabled={file.busy} onClick={() => press('share')}><Share2 size={15}/> {t('filesShare')}</button>}
    </div>
    {state.phase === 'confirm' && <div className="upload-confirm" role="group" aria-label={t('filesConfirmDownload')}>
      {state.stat.link !== null && <p>{t('filesLinkConfirm', {name, target: state.stat.link})}</p>}
      {state.stat.size > 50 * 1024 * 1024 && <p>{t('filesLargeConfirm', {name, size: formatBytes(state.stat.size)})}</p>}
      <div className="button-row">
        <button type="button" className="primary-button" onClick={file.confirm}>{t('filesContinue')}</button>
        <button type="button" className="subtle-button" onClick={file.dismiss}>{t('filesCancel')}</button>
      </div>
    </div>}
    {state.phase === 'running' && <div className="file-transfer" role="status">
      <p>{state.progress.total === null
        ? t('filesDownloadingUnknown', {name: state.name, done: formatBytes(state.progress.bytes)})
        : t('filesDownloading', {name: state.name, done: formatBytes(state.progress.bytes), total: formatBytes(state.progress.total)})}</p>
      <progress aria-label={t('filesProgress')} max={state.progress.total ?? undefined} value={state.progress.total === null ? undefined : state.progress.bytes}/>
      <button type="button" className="subtle-button" disabled={state.cancelling} onClick={file.cancel}>{state.cancelling ? t('filesCancelling') : t('filesCancel')}</button>
    </div>}
    {state.phase === 'done' && <p role="status">{t(doneKeys[state.action], {location: state.location ?? ''})}</p>}
    {state.phase === 'cancelled' && <p role="status">{t('filesDownloadCancelled')}</p>}
    {state.phase === 'failed' && <p className="inline-error" role="alert">{uiErrorText(state.error)}</p>}
  </>;
}
