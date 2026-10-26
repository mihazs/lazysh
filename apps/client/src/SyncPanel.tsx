import { useProtectedInvoke } from './access';
import {applyPreferenceIntent} from './i18n/nativeLocale';
import { useEffect, useRef, useState } from "react";

import {
  getPreferences,
  parsePreferences,
} from "./preferences";
import { errorMessage } from "./SessionTools";

type Scope = "settings" | "credentials";
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
    throw new Error("Invalid sync preview.");
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
    throw new Error("Invalid sync preview.");
  for (const host of preview.hosts) {
    if (
      !host ||
      typeof host.addHost !== "boolean" ||
      typeof host.importCredentials !== "boolean" ||
      !Number.isInteger(host.port) ||
      host.port < 1 ||
      host.port > 65535
    )
      throw new Error("Invalid synced host.");
    for (const key of ["id", "name", "hostname", "username"] as const)
      if (typeof host[key] !== "string" || host[key].length > 4096)
        throw new Error("Invalid synced host.");
    if (
      host.fingerprint !== undefined &&
      (typeof host.fingerprint !== "string" || host.fingerprint.length > 256)
    )
      throw new Error("Invalid synced identity.");
    if (
      (host.jumpHostId !== undefined &&
        (typeof host.jumpHostId !== "string" ||
          host.jumpHostId.length > 100)) ||
      (host.forwardAgent !== undefined &&
        typeof host.forwardAgent !== "boolean") ||
      (host.trustFingerprint !== undefined &&
        typeof host.trustFingerprint !== "boolean")
    )
      throw new Error("Invalid synced routing.");
  }
  for (const conflict of preview.conflicts)
    if (
      !conflict ||
      typeof conflict.id !== "string" ||
      typeof conflict.reason !== "string" ||
      conflict.reason.length > 4096
    )
      throw new Error("Invalid sync conflict.");
  return preview;
}

export default function SyncPanel({
  onHostsChanged,
}: {
  onHostsChanged: () => void;
}) {
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
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
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
          setError(errorMessage(e));
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
    setMessage("");
    try {
      await action();
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
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
    setMessage("Encrypted sync configured. Nothing has been uploaded.");
  }
  async function fetchPreview(scope: Scope) {
    const value = parseSyncPreview(await invoke("sync_preview", { scope }));
    if (value.scope !== scope) throw new Error("Sync scope did not match.");
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
    setMessage(
      `Imported ${result.hostsAdded} hosts and ${result.credentialsAdded} credential entries.`,
    );
  }
  return (
    <section className="preferences-panel" aria-label="Encrypted sync">
      <p>
        Use your own HTTPS WebDAV directory. Settings and credentials are
        encrypted separately before upload. Sync runs only when you choose an
        action.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(configure);
        }}
      >
        <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
          <label>
            WebDAV directory
            <input
              type="url"
              required
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://dav.example/lazysh/"
            />
          </label>
          <label>
            WebDAV username
            <input
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            WebDAV password
            <input
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label>
            Recovery key from another device
            <input
              type="password"
              autoComplete="off"
              value={recoveryKey}
              onChange={(event) => setRecoveryKey(event.target.value)}
              placeholder={
                configured
                  ? "Leave empty to keep this device’s key"
                  : "Leave empty to create a new identity"
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={settingsEnabled}
              onChange={(event) => setSettingsEnabled(event.target.checked)}
            />
            Enable settings sync
          </label>
          <label>
            <input
              type="checkbox"
              checked={credentialsEnabled}
              onChange={(event) => setCredentialsEnabled(event.target.checked)}
            />
            Enable credentials sync
          </label>
          <button disabled={busy}>Configure sync</button>
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
                throw new Error("Invalid recovery key response.");
              if (alive.current) setGenerated(result.recoveryKey);
            })
          }
        >
          Show recovery key
        </button>
      )}
      {generated && (
        <div>
          <p>
            Keep this recovery key to enroll another device. It decrypts your
            synced data.
          </p>
          <textarea readOnly aria-label="Recovery key" value={generated} />
          <button onClick={() => setGenerated("")}>Hide recovery key</button>
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
                {scope === "settings" ? "Settings" : "Credentials"}
              </legend>
              <button onClick={() => void run(() => fetchPreview(scope))}>
                Preview remote {scope}
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
                      setMessage(`Encrypted ${scope} uploaded.`);
                  })
                }
              >
                Upload {scope}
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
                  setMessage(
                    "This device is disconnected from sync. Remote data was not deleted.",
                  );
                }
              })
            }
          >
            Disconnect sync on this device
          </button>
        </div>
      )}
      {preview && (
        <section aria-label="Review sync changes">
          <h3>Review {preview.scope}</h3>
          <p>
            Existing hosts and pins stay unchanged. Review imported identities
            before applying.
          </p>
          {preview.hosts.map((host) => (
            <article key={host.id}>
              <strong>{host.name}</strong>
              <p>
                {host.username}@{host.hostname}:{host.port}
              </p>
              <code>{host.fingerprint || "No saved fingerprint"}</code>
              {host.jumpHostId && <p>Bastion: {host.jumpHostId}</p>}
              {host.forwardAgent && (
                <p>Selected-key forwarding is enabled for this host.</p>
              )}
              <p>
                {host.addHost ? "Add host. " : ""}
                {host.importCredentials ? "Import saved credentials." : ""}
                {host.trustFingerprint
                  ? " Enroll this imported fingerprint."
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
            Apply reviewed changes
          </button>
          <button disabled={busy} onClick={() => setPreview(undefined)}>
            Cancel import
          </button>
        </section>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </section>
  );
}
