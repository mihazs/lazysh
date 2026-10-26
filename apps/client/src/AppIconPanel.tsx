import {LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import {t, useUi} from './i18n/core';
import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { captureAccess, useProtectedInvoke } from './access';

type Icon = 'default' | 'amber';
type IconStatus = { available: boolean; current: Icon | 'unknown'; reason: string };
const unavailable: IconStatus = { available: false, current: 'unknown', reason: '' };
function parseStatus(value: unknown): IconStatus {
  if (!value || typeof value !== 'object') throw new LocalUiError('iconsCannotReadTheCurrentAppIcon');
  const row = value as Record<string, unknown>;
  if (typeof row.available !== 'boolean' || typeof row.current !== 'string' || !['default', 'amber', 'unknown'].includes(String(row.current))
    || typeof row.reason !== 'string' || row.reason.length > 512) throw new LocalUiError('iconsCannotReadTheCurrentAppIcon');
  return row as IconStatus;
}
export default function AppIconPanel() {
  useUi();
  const invoke = useProtectedInvoke();
  const lease = useRef(captureAccess()).current;
  const alive = useRef(true);
  const [status, setStatus] = useState<IconStatus>();
  const [choice, setChoice] = useState<Icon>('default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiErrorCause>('');
  const generation = useRef(0);
  const changing = useRef(false);
  const currentRequest = (request: number) => alive.current && lease.current() && generation.current === request;
  async function read() {
    if (!alive.current || !lease.current()) return;
    const current = ++generation.current;
    try {
      const actual = isTauri() ? parseStatus(await invoke('app_icon_status')) : unavailable;
      if (currentRequest(current)) { setStatus(actual); if (actual.current !== 'unknown') setChoice(actual.current); }
    } catch { if (currentRequest(current)) { setStatus(undefined); setError(new LocalUiError('iconsCannotReadTheCurrentAppIconTryRefreshing')); } }
  }
  useEffect(() => {
    alive.current = true;
    void read();
    const resumed = () => { if (!document.hidden && !changing.current) void read(); };
    window.addEventListener('focus', resumed);
    document.addEventListener('visibilitychange', resumed);
    return () => { alive.current = false; generation.current++; window.removeEventListener('focus', resumed); document.removeEventListener('visibilitychange', resumed); };
  }, []);
  async function apply() {
    if (!alive.current || !lease.current() || changing.current || !status?.available) return;
    changing.current = true; setBusy(true); setError('');
    const current = ++generation.current;
    try {
      const actual = parseStatus(await invoke('set_app_icon', {icon: choice}));
      if (currentRequest(current)) { setStatus(actual); if (actual.current !== 'unknown') setChoice(actual.current); }
    } catch (error) {
      if (currentRequest(current)) {
        setError(error instanceof LocalUiError ? error : error instanceof Error ? error.message : typeof error === 'string' ? error : new LocalUiError('appIOSCouldNotChangeTheAppIcon'));
        await read();
      }
    } finally { if (alive.current && lease.current()) { changing.current = false; setBusy(false); } }
  }
  return <fieldset><legend>{t("iconsAppIcon")}</legend>
    <p>{!isTauri() ? t("iconsAlternateHomeScreenIconsRequireTheIOSApp") : status?.reason ?? t("iconsReadingTheCurrentIOSIcon")}</p>
    {error && <p role="alert">{uiErrorText(error)}</p>}
    <p role="status">{t("iconsCurrentIconValue1", {value1: status ? {default: t("iconsDefault"), amber: t("iconsAmber"), unknown: t("appUnknownRefreshBeforeChanging")}[status.current] : t("appUnknown")})}</p>
    <label>{t("iconsHomeScreenIcon")}<select value={choice} disabled={!status?.available || busy} onChange={event => setChoice(event.target.value as Icon)}>
      <option value="default">{t("iconsDefault")}</option><option value="amber">{t("iconsAmber")}</option>
    </select></label>
    <button disabled={!status?.available || busy || status.current === choice} onClick={() => void apply()}>{busy ? t("iconsChangingIcon") : t("iconsApplyAppIcon")}</button>
    <button disabled={busy} onClick={() => { setError(''); void read(); }}>{t("iconsRefreshAppIcon")}</button>
    <p>{t("iconsDeviceLocalIOSSettingItDoesNotChangeTerminal")}</p>
  </fieldset>;
}
