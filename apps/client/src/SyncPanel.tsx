import {t,useUi,formatNumber} from './i18n/core';
import {captureUiError,LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import { useProtectedInvoke } from './access';
import {applyPreferenceIntent} from './i18n/nativeLocale';
import { useEffect, useRef, useState } from "react";

import {
  getPreferences,
  parsePreferences,
} from "./preferences";

type Scope = "settings" | "credentials";
type SyncMessage = 'syncConfigured' | 'syncSettingsUploaded' | 'syncCredentialsUploaded' | 'syncDisconnected' | {hostsAdded:number;credentialsAdded:number};
type Preview = {
  token: string;
  scope: Scope;
  hosts: {
    id: string;
    name: string;
    hostname: string;
    port: number;
    username: string;
    fingerprint?: string;
    jumpHostId?: string;
    forwardAgent?: boolean;
    addHost: boolean;
    importCredentials: boolean;
    trustFingerprint?: boolean;
  }[];
  conflicts: { id: string; reason: string }[];
  preferences?: unknown;
};
export function parseSyncPreview(value: unknown): Preview {
  if (!value || typeof value !== "object")
    throw new LocalUiError('syncInvalidPreview');
  const preview = value as Preview;
  if (
    typeof preview.token !== "string" ||
    preview.token.length > 128 ||
    !["settings", "credentials"].includes(preview.scope) ||
    !Array.isArray(preview.hosts) ||
    preview.hosts.length > 1000 ||
    !Array.isArray(preview.conflicts) ||
    preview.conflicts.length > 1000
  )
    throw new LocalUiError('syncInvalidPreview');
  for (const host of preview.hosts) {
    if (
      !host ||
      typeof host.addHost !== "boolean" ||
      typeof host.importCredentials !== "boolean" ||
      !Number.isInteger(host.port) ||
      host.port < 1 ||
      host.port > 65535
    )
      throw new LocalUiError('syncInvalidHost');
    for (const key of ["id", "name", "hostname", "username"] as const)
      if (typeof host[key] !== "string" || host[key].length > 4096)
        throw new LocalUiError('syncInvalidHost');
    if (
      host.fingerprint !== undefined &&
      (typeof host.fingerprint !== "string" || host.fingerprint.length > 256)
    )
      throw new LocalUiError('syncInvalidIdentity');
    if (
      (host.jumpHostId !== undefined &&
        (typeof host.jumpHostId !== "string" ||
          host.jumpHostId.length > 100)) ||
      (host.forwardAgent !== undefined &&
        typeof host.forwardAgent !== "boolean") ||
      (host.trustFingerprint !== undefined &&
        typeof host.trustFingerprint !== "boolean")
    )
      throw new LocalUiError('syncInvalidRouting');
  }
  for (const conflict of preview.conflicts)
    if (
      !conflict ||
      typeof conflict.id !== "string" ||
      typeof conflict.reason !== "string" ||
      conflict.reason.length > 4096
    )
      throw new LocalUiError('syncInvalidConflict');
  return preview;
}

export default function SyncPanel({
  onHostsChanged,
}: {
  onHostsChanged: () => void;
}) {
  useUi();
  const invoke = useProtectedInvoke();
  const [endpoint, setEndpoint] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [generated, setGenerated] = useState("");
  const [settingsEnabled, setSettingsEnabled] = useState(false);
  const [credentialsEnabled, setCredentialsEnabled] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(true);
  const running = useRef(true);
  const operation = useRef(0);
  const [preview, setPreview] = useState<Preview>();
  const [message, setMessage] = useState<SyncMessage | null>(null);
  const [error, setError] = useState<UiErrorCause>('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const generation = ++operation.current;
    void invoke<{
      configured: boolean;
      endpoint?: string;
      username?: string;
      settingsEnabled: boolean;
      credentialsEnabled: boolean;
    }>("sync_status")
      .then((status) => {
        if (!alive.current || generation !== operation.current) return;
        setConfigured(status.configured === true);
        setEndpoint(status.endpoint || "");
        setUsername(status.username || "");
        setSettingsEnabled(status.settingsEnabled === true);
        setCredentialsEnabled(status.credentialsEnabled === true);
      })
      .catch((e) => {
        if (alive.current && generation === operation.current)
          setError(captureUiError(e));
      })
      .finally(() => {
        if (alive.current && generation === operation.current) {
          running.current = false;
          setBusy(false);
        }
      });
    return () => {
      alive.current = false;
    };
  }, []);
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    operation.current++;
    setBusy(true);
    setError("");
    setMessage(null);
    try {
      await action();
    } catch (e) {
      if (alive.current) setError(captureUiError(e));
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function configure() {
    const result = await invoke<{ recoveryKey?: string; recipient: string }>(
      "sync_configure",
      {
        config: { endpoint, username, settingsEnabled, credentialsEnabled },
        password,
        recoveryKey: recoveryKey || null,
      },
    );
    if (!alive.current) return;
    setConfigured(true);
    setPassword("");
    setRecoveryKey("");
    setPreview(undefined);
    setGenerated(result.recoveryKey || "");
    setMessage('syncConfigured');
  }
  async function fetchPreview(scope: Scope) {
    const value = parseSyncPreview(await invoke("sync_preview", { scope }));
    if (value.scope !== scope) throw new LocalUiError('syncScopeMismatch');
    if (alive.current) setPreview(value);
  }
  async function apply() {
    if (!preview) return;
    let result: {
      hostsAdded: number;
      credentialsAdded: number;
      preferences?: unknown;
    };
    try {
      result = await invoke("sync_apply", { token: preview.token });
    } finally {
      if (alive.current) onHostsChanged();
    }
    if (!alive.current) return;
    if (result.preferences !== undefined) {
      const explicitLanguage=!!result.preferences && typeof result.preferences==='object' && Object.hasOwn(result.preferences,'uiLanguage');
      await applyPreferenceIntent(result.preferences,explicitLanguage,()=>alive.current);
    }
    if (!alive.current) return;
    setPreview(undefined);
    setMessage({hostsAdded:result.hostsAdded,credentialsAdded:result.credentialsAdded});
  }
  return (
    <section className="preferences-panel" aria-label={t('appEncryptedSync')}>
      <p>
        {t('syncDescription')}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(configure);
        }}
      >
        <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
          <label>
            {t('syncDirectory')}
            <input
              type="url"
              required
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://dav.example/lazysh/"
            />
          </label>
          <label>
            {t('syncUsername')}
            <input
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            {t('syncPassword')}
            <input
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label>
            {t('syncRecoveryImport')}
            <input
              type="password"
              autoComplete="off"
              value={recoveryKey}
              onChange={(event) => setRecoveryKey(event.target.value)}
              placeholder={
                configured
                  ? t('syncKeepKey')
                  : t('syncNewIdentity')
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={settingsEnabled}
              onChange={(event) => setSettingsEnabled(event.target.checked)}
            />
            {t('syncEnableSettings')}
          </label>
          <label>
            <input
              type="checkbox"
              checked={credentialsEnabled}
              onChange={(event) => setCredentialsEnabled(event.target.checked)}
            />
            {t('syncEnableCredentials')}
          </label>
          <button disabled={busy}>{t('syncConfigure')}</button>
        </fieldset>
      </form>
      {configured && (
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await invoke<{ recoveryKey: string }>(
                "sync_recovery_key",
              );
              if (
                typeof result.recoveryKey !== "string" ||
                result.recoveryKey.length > 256
              )
                throw new LocalUiError('syncInvalidRecovery');
              if (alive.current) setGenerated(result.recoveryKey);
            })
          }
        >
          {t('syncShowRecovery')}
        </button>
      )}
      {generated && (
        <div>
          <p>
            {t('syncRecoveryHint')}
          </p>
          <textarea readOnly aria-label={t('syncRecoveryKey')} value={generated} />
          <button onClick={() => setGenerated("")}>{t('syncHideRecovery')}</button>
        </div>
      )}
      {configured && (
        <div>
          {(["settings", "credentials"] as const).map((scope) => (
            <fieldset
              key={scope}
              disabled={
                busy ||
                !(scope === "settings" ? settingsEnabled : credentialsEnabled)
              }
            >
              <legend>
                {t(scope === 'settings' ? 'syncSettings' : 'syncCredentials')}
              </legend>
              <button onClick={() => void run(() => fetchPreview(scope))}>
                {t(scope === 'settings' ? 'syncPreviewSettings' : 'syncPreviewCredentials')}
              </button>
              <button
                onClick={() =>
                  void run(async () => {
                    await invoke("sync_push", {
                      scope,
                      ...(scope === "settings"
                        ? { preferences: getPreferences() }
                        : {}),
                    });
                    if (alive.current)
                      setMessage(scope === 'settings' ? 'syncSettingsUploaded' : 'syncCredentialsUploaded');
                  })
                }
              >
                {t(scope === 'settings' ? 'syncUploadSettings' : 'syncUploadCredentials')}
              </button>
            </fieldset>
          ))}
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await invoke("sync_forget");
                if (alive.current) {
                  setConfigured(false);
                  setGenerated("");
                  setPreview(undefined);
                  setMessage('syncDisconnected');
                }
              })
            }
          >
            {t('syncDisconnect')}
          </button>
        </div>
      )}
      {preview && (
        <section aria-label={t('syncReviewRegion')}>
          <h3>{t(preview.scope === 'settings' ? 'syncReviewSettings' : 'syncReviewCredentials')}</h3>
          <p>
            {t('syncReviewHint')}
          </p>
          {preview.hosts.map((host) => (
            <article key={host.id}>
              <strong>{host.name}</strong>
              <p>
                {host.username}@{host.hostname}:{host.port}
              </p>
              <code>{host.fingerprint || t('syncNoFingerprint')}</code>
              {host.jumpHostId && <p>{t('syncBastion')} {host.jumpHostId}</p>}
              {host.forwardAgent && (
                <p>{t('syncForwardAgent')}</p>
              )}
              <p>
                {host.addHost ? `${t('syncAddHost')} ` : ''}
                {host.importCredentials ? t('syncImportCredentials') : ''}
                {host.trustFingerprint
                  ? ` ${t('syncTrustFingerprint')}`
                  : ""}
              </p>
            </article>
          ))}
          {preview.conflicts.map((conflict, index) => (
            <p key={index}>
              {conflict.id}: {conflict.reason}
            </p>
          ))}
          <button disabled={busy} onClick={() => void run(apply)}>
            {t('syncApply')}
          </button>
          <button disabled={busy} onClick={() => setPreview(undefined)}>
            {t('syncCancel')}
          </button>
        </section>
      )}
      {message && <p role="status">{typeof message === 'string' ? t(message) : t('syncImported', {
        hosts:t('syncHostCount',{count:message.hostsAdded,value:formatNumber(message.hostsAdded)}),
        credentials:t('syncCredentialCount',{count:message.credentialsAdded,value:formatNumber(message.credentialsAdded)}),
      })}</p>}
      {error && (
        <p role="alert" className="inline-error">
          {uiErrorText(error)}
        </p>
      )}
    </section>
  );
}
