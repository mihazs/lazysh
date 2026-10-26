import {t,useUi} from './core';
import type {LocaleSnapshot} from './nativeLocale';

export function NativeLocaleNotice({state,retry}:{state:LocaleSnapshot;retry:()=>void}) {
  useUi();
  if(state.phase==='loading')return <p role="status">{t('nativeLocaleChecking')}</p>;
  if(state.phase!=='error')return null;
  const message=state.writerPending?'nativeLocaleWritePending':state.error==='write'?'nativeLocaleSaveFailed':'nativeLocaleUnavailable';
  return <aside role="alert">
    <p>{t(message)}</p>
    <button disabled={state.writerPending} onClick={retry}>{t('nativeLocaleRetry')}</button>
  </aside>;
}
