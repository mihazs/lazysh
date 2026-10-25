import {t, useUi} from './i18n/core';
import { useState } from 'react';
import { accessControl, accessSnapshot, applyAccessStatus, useAccessSnapshot } from './access';

export default function AccessPanel() {
  useUi();
  const { status } = useAccessSnapshot();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function configure(enabled: boolean) {
    if (!status?.supported || busy) return;
    const epoch = accessSnapshot().epoch;
    setBusy(true); setError('');
    try {
      const value = await accessControl.configure(enabled);
      // A later native lock event wins over any older configure response.
      if (accessSnapshot().epoch === epoch) applyAccessStatus(value);
    } catch {
      if (accessSnapshot().epoch === epoch) setError(t("accessDeviceAuthenticationDidNotCompleteAppLockSettingsWere"));
    } finally { if (accessSnapshot().epoch === epoch) setBusy(false); }
  }
  return <section aria-label={t("accessAppLockSettings")}><h3>{t("accessAppLock")}</h3>
    <p>{t("accessRequireDeviceAuthenticationWhenReturningToLazyshNativeDevice")}</p>
    {status?.supported && <p>{t("accessDisableAppLockBeforeChangingEnrolledBiometricsThisPreview")}</p>}
    <label className="access-lock-toggle"><input type="checkbox" checked={status?.enabled ?? false} disabled={!status?.supported || busy}
      onChange={event => void configure(event.target.checked)} />{t("accessLockWhenReturningToTheApp")}</label>
    {!status?.supported && <p>{status?.reason || t("accessAppLockIsUnavailableOnThisPlatform")}</p>}
    {busy && <p role="status">{t("accessWaitingForDeviceAuthentication")}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
