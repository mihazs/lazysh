import {useState} from 'react';
import {useProtectedApi} from './access';
import {api as nativeApi} from './bridge';
import {t} from './i18n/core';
import {terminalFeedbackUrl, type TerminalReport} from './terminalFeedback';
import {openWebPage} from './webPage';

/** Opens the issue form of the repository, prefilled with `report`, in the user's browser: the app itself sends nothing. */
export default function TerminalFeedbackLink({report}: {report: TerminalReport}) {
  const api = useProtectedApi(nativeApi);
  const [failed, setFailed] = useState(false);
  return <>
    <button type="button" className="text-button" onClick={() => { setFailed(false); openWebPage(page => api.openWebUrl(page), terminalFeedbackUrl(report)).catch(() => setFailed(true)); }}>{t('terminalFeedbackReport')}</button>
    {failed && <span role="alert">{t('terminalFeedbackFailed')}</span>}
  </>;
}
