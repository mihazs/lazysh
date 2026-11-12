import {useEffect, useState} from 'react';
import {t, useUi} from './i18n/core';
import {captureUiError, uiErrorText, type UiErrorCause} from './i18n/localError';
import {useProtectedApi} from './access';
import {api as nativeApi} from './bridge';
import FilePreview, {type FileContent} from './FilePreview';
import HostFileActions from './HostFileActions';
import {previewKind} from './mediaPreview';

/** What a tapped host path offers: view in the app, open with another app, download, share, copy the path. */
export default function HostPathSheet({sessionId, path, line, onCopy, onClose}: {sessionId: string; path: string; line?: number; onCopy: (path: string) => void; onClose: () => void}) {
  useUi();
  const api = useProtectedApi(nativeApi);
  const [preview, setPreview] = useState<FileContent | null>(null);
  const [error, setError] = useState<UiErrorCause | null>(null);
  useEffect(() => { setPreview(null); setError(null); }, [path]);
  async function view() {
    setError(null);
    try { setPreview({path, text: await api.readFile(sessionId, path)}); }
    catch (failure) { setError(captureUiError(failure)); }
  }
  return <div className="terminal-consent" role="region" aria-label={t('terminalPathRegion')}>
    <p>{path}{line !== undefined && <> · {t('terminalPathLine', {line: String(line)})}</>}</p>
    <HostFileActions key={path} sessionId={sessionId} path={path}/>
    {previewKind(path) !== 'image' && <button type="button" onClick={() => void view()}>{t('terminalViewFile')}</button>}
    <button type="button" onClick={() => onCopy(path)}>{t('terminalCopyPath')}</button>
    <button type="button" onClick={onClose}>{t('terminalDismissPath')}</button>
    {error !== null && <p className="inline-error" role="alert">{uiErrorText(error)}</p>}
    {preview && <FilePreview key={preview.path} content={preview}/>}
  </div>;
}
