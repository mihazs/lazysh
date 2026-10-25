import {
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  Activity,
  ChevronRight,
  Command,
  FolderOpen,
  GitCompareArrows,
  KeyRound,
  Layers,
  Menu,
  MessageSquare,
  Settings,
  Globe,
  Paperclip,
  Mic,
  Cloud,
  Share2,
  Ellipsis,
  Bell,
  Smartphone,
  Pencil,
  Plus,
  Search,
  Server,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import {
  api,
  native,
  type Credentials,
  type Host,
  type SshError,
  type SshEvent,
} from "./bridge";
import type { LiveSession } from "./terminal";
import { FilesPanel, MuxPanel, errorMessage } from "./SessionTools";
import AgentPanel from "./AgentPanel";
import PreferencesPanel from "./PreferencesPanel";
import { useClientAppearance } from "./appearance";
import CredentialsPanel from "./CredentialsPanel";
import { readWorkspace, saveWorkspace, type SessionIntent } from "./workspace";
import NotificationPanel, { NotificationMonitor } from "./NotificationPanel";

const TerminalPane = lazy(() => import("./TerminalPane"));
const ChatPanel = lazy(() => import("./ChatPanel"));
const UsagePanel = lazy(() => import("./UsagePanel"));
const PreviewPanel = lazy(() => import("./PreviewPanel"));
const RepositoryPanel = lazy(() => import("./RepositoryPanel"));
const AttachmentPanel = lazy(() => import("./AttachmentPanel"));
const VoicePanel = lazy(() => import("./VoicePanel"));
const SyncPanel = lazy(() => import("./SyncPanel"));
const SharePanel = lazy(() => import("./SharePanel"));
const AboutPanel = lazy(() => import("./AboutPanel"));
const DevicePanel = lazy(() => import("./DevicePanel"));

async function prepareSession(
  hostId: string,
  name: string,
  destination: string,
) {
  const { createTerminal } = await import("./terminal");
  const session: LiveSession = {
    id: "",
    hostId,
    name,
    destination,
    terminal: createTerminal(),
    connected: true,
  };
  let pendingBytes = 0;
  const acknowledge = (bytes: number) => {
    if (!session.connected) return;
    if (!session.id) {
      pendingBytes += bytes;
      return;
    }
    void api
      .ackOutput(session.id, bytes)
      .catch((error) =>
        window.dispatchEvent(
          new CustomEvent("lazysh-error", { detail: errorMessage(error) }),
        ),
      );
  };
  const onEvent = (event: SshEvent) => {
    if (event.type === "data")
      session.terminal.write(new Uint8Array(event.data), () =>
        acknowledge(event.data.length),
      );
    else {
      session.connected = false;
      session.message = event.message || "Connection closed";
      window.dispatchEvent(new Event("lazysh-session-change"));
    }
  };
  const establish = (id: string) => {
    session.id = id;
    if (pendingBytes) {
      acknowledge(pendingBytes);
      pendingBytes = 0;
    }
  };
  return { session, onEvent, establish };
}

type View =
  | "terminal"
  | "agents"
  | "files"
  | "diff"
  | "sessions"
  | "chat"
  | "usage"
  | "preview"
  | "attachments"
  | "voice"
  | "devices";
const views = [
  { id: "terminal" as const, label: "Terminal", Icon: TerminalSquare },
  { id: "agents" as const, label: "Agents", Icon: Bot },
  { id: "chat" as const, label: "Transcript", Icon: MessageSquare },
  { id: "usage" as const, label: "Usage", Icon: Activity },
  { id: "files" as const, label: "Files", Icon: FolderOpen },
  { id: "diff" as const, label: "Diff", Icon: GitCompareArrows },
  { id: "sessions" as const, label: "Sessions", Icon: Layers },
  { id: "preview" as const, label: "Preview", Icon: Globe },
  { id: "attachments" as const, label: "Attach", Icon: Paperclip },
  { id: "voice" as const, label: "Dictate", Icon: Mic },
  { id: "devices" as const, label: "Devices", Icon: Smartphone },
];

function Dialog({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ) ?? [],
      );
    const controls = focusable();
    (
      controls.find((control) => control.matches("input, textarea")) ??
      controls[0]
    )?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const items = focusable();
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    const current = ref.current;
    current?.addEventListener("keydown", keydown);
    return () => {
      current?.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, []);
  return (
    <div className="dialog-backdrop">
      <div
        ref={ref}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="dialog-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label={`Close ${title}`}
            onClick={close}
          >
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function validateHost(
  host: Pick<Host, "hostname" | "username" | "port" | "name">,
) {
  if (!host.name.trim()) return "Give this host a name.";
  if (!host.hostname.trim() || /[\s/@\x00-\x1f]/.test(host.hostname))
    return "Enter a hostname or IP address without a username, path, or spaces.";
  if (!host.username.trim() || /[\s\x00-\x1f]/.test(host.username))
    return "Enter a username without spaces.";
  if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535)
    return "Port must be between 1 and 65535.";
  return "";
}

function HostEditor({
  initial,
  hosts,
  save,
  close,
}: {
  initial: Host | null;
  hosts: Host[];
  save: (host: Host) => Promise<void>;
  close: () => void;
}) {
  const [host, setHost] = useState<Host>(
    initial ?? {
      id: crypto.randomUUID(),
      name: "",
      hostname: "",
      port: 22,
      username: "",
    },
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [protection, setProtection] = useState({
    available: false,
    reason: "Checking device support…",
  });
  useEffect(() => {
    let alive = true;
    void invoke<{ available: boolean; reason: string }>("credential_protection")
      .then((value) => {
        if (alive)
          setProtection({
            available: value.available === true,
            reason: value.reason,
          });
      })
      .catch(() => {
        if (alive)
          setProtection({
            available: false,
            reason: "Biometric protection is unavailable on this device.",
          });
      });
    return () => {
      alive = false;
    };
  }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const next = {
      ...host,
      name: host.name.trim(),
      hostname: host.hostname.trim(),
      username: host.username.trim(),
    };
    const invalid = validateHost(next);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await save(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={initial ? "Edit host" : "Add a host"}
      close={() => {
        if (!busy) close();
      }}
    >
      <form onSubmit={(event) => void submit(event)} className="form-stack">
        <p className="muted">
          Connect directly to a machine you control. No relay, no account.
        </p>
        <label>
          Name
          <input
            value={host.name}
            onChange={(e) => setHost({ ...host, name: e.target.value })}
            placeholder="Home workstation"
            required
            maxLength={80}
          />
        </label>
        <div className="form-columns">
          <label>
            Hostname or IP
            <input
              value={host.hostname}
              onChange={(e) => setHost({ ...host, hostname: e.target.value })}
              placeholder="workstation.local"
              required
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <label className="port-field">
            Port
            <input
              type="number"
              min="1"
              max="65535"
              value={host.port || ""}
              onChange={(e) =>
                setHost({ ...host, port: Number(e.target.value) })
              }
              required
            />
          </label>
        </div>
        <label>
          Username
          <input
            value={host.username}
            onChange={(e) => setHost({ ...host, username: e.target.value })}
            placeholder="Your SSH username"
            required
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        {initial?.fingerprint && (
          <p className="security-note">
            <ShieldCheck size={15} /> Host key is pinned. Changing the
            destination requires verification again.
          </p>
        )}
        <label>
          SSH bastion
          <select
            value={host.jumpHostId || ""}
            onChange={(event) =>
              setHost({ ...host, jumpHostId: event.target.value || null })
            }
          >
            <option value="">Connect directly</option>
            {hosts
              .filter(
                (candidate) =>
                  candidate.id !== host.id && !candidate.jumpHostId,
              )
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} ({candidate.username}@{candidate.hostname})
                </option>
              ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={host.forwardAgent === true}
            onChange={(event) =>
              setHost({ ...host, forwardAgent: event.target.checked })
            }
          />
          Forward this connection’s private-key identity
        </label>
        <label>
          <input
            type="checkbox"
            checked={host.biometricUnlock === true}
            disabled={!protection.available && !host.biometricUnlock}
            onChange={(event) =>
              setHost({ ...host, biometricUnlock: event.target.checked })
            }
          />
          Require biometrics for saved credentials
        </label>
        <p className="security-note">{protection.reason}</p>
        {host.forwardAgent && (
          <p className="security-note">
            Programs on this host can request signatures with your selected
            identity while connected. Your other keys and local SSH agent are
            not exposed. Requires private-key authentication.
          </p>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="subtle-button"
            onClick={close}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="primary-button" disabled={busy}>
            {busy ? "Saving…" : "Save host"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ConnectDialog({
  host,
  hosts,
  connected,
  close,
}: {
  host: Host;
  hosts: Host[];
  connected: (session: LiveSession) => void;
  close: () => void;
}) {
  const [method, setMethod] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [rememberCredentials, setRememberCredentials] = useState(false);
  const [savedCredentials, setSavedCredentials] = useState(false);
  const [storedCredentials, setStoredCredentials] = useState(
    host.credentialsStored === true,
  );
  const [useSavedCredentials, setUseSavedCredentials] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [trust, setTrust] = useState<string | null>(null);
  const [trustHostId, setTrustHostId] = useState(host.id);
  const [savedJump, setSavedJump] = useState(true);
  const [jumpPassword, setJumpPassword] = useState("");
  const [exportedIdentity, setExportedIdentity] = useState("");
  const [transport, setTransport] = useState<"ssh" | "mosh" | "et">("ssh");
  const [moshAvailable, setMoshAvailable] = useState(false);
  const [etAvailable, setEtAvailable] = useState(false);
  const [etServer, setEtServer] = useState("etterminal");
  const [etPort, setEtPort] = useState(2022);
  const [moshServer, setMoshServer] = useState("mosh-server");
  const [moshPortMin, setMoshPortMin] = useState(60000);
  const [moshPortMax, setMoshPortMax] = useState(61000);
  const exportGeneration = useRef(0);
  const trustHost = hosts.find((item) => item.id === trustHostId) || host;
  const connecting = useRef(false);
  const connectingSessions = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    const hide = () => {
      exportGeneration.current += 1;
      setExportedIdentity("");
      if (!connecting.current) setBusy(false);
      void invoke("cancel_credential_auth").catch(() => {});
    };
    const visibility = () => {
      if (document.visibilityState !== "visible") hide();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", hide);
    return () => {
      exportGeneration.current += 1;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", hide);
    };
  }, []);
  useEffect(() => {
    alive.current = true;
    void invoke<{ mosh: boolean; et: boolean }>("transport_capabilities")
      .then((value) => {
        if (alive.current)
          setMoshAvailable(
            value?.mosh === true && !host.jumpHostId && !host.forwardAgent,
          );
        if (alive.current)
          setEtAvailable(
            value?.et === true && !host.jumpHostId && !host.forwardAgent,
          );
      })
      .catch(() => {});
    void invoke<boolean>("has_credentials", { hostId: host.id })
      .then((saved) => {
        if (alive.current) setSavedCredentials(saved === true);
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      void invoke("cancel_credential_auth").catch(() => {});
      for (const id of connectingSessions.current)
        void api.disconnect(id).catch(() => {});
      connectingSessions.current.clear();
    };
  }, []);

  async function connect(accept = false) {
    if (connecting.current) return;
    connecting.current = true;
    setBusy(true);
    setError("");
    let session: LiveSession | undefined;
    let control: Awaited<ReturnType<typeof prepareSession>> | undefined;
    try {
      if (accept && trust) {
        await api.trustHostKey(trustHostId, trust);
        setTrust(null);
      }
      const credentials: Credentials = useSavedCredentials
        ? {}
        : method === "password"
          ? { password }
          : { privateKey, ...(passphrase ? { passphrase } : {}) };
      const pending = await prepareSession(
        host.id,
        host.name,
        `${host.username}@${host.hostname}`,
      );
      session = pending.session;
      const result =
        rememberCredentials ||
        useSavedCredentials ||
        (host.jumpHostId && !savedJump)
          ? await api.connect(host.id, credentials, pending.onEvent, {
              rememberCredentials,
              useSavedCredentials,
              ...(host.jumpHostId && !savedJump
                ? { jumpCredentials: { password: jumpPassword } }
                : {}),
            })
          : await api.connect(host.id, credentials, pending.onEvent);
      pending.establish(result.sessionId);
      connectingSessions.current.add(result.sessionId);
      if (!alive.current) {
        await api.disconnect(result.sessionId);
        session.terminal.dispose();
        return;
      }
      if (transport !== "ssh") {
        control = pending;
        const upgradedSession = await prepareSession(
          host.id,
          host.name,
          `${host.username}@${host.hostname} · ${transport === "mosh" ? "Mosh" : "ET"}`,
        );
        session = upgradedSession.session;
        if (transport === "mosh")
          session.mosh = {
            serverPath: moshServer,
            portMin: moshPortMin,
            portMax: moshPortMax,
          };
        else session.et = { serverPath: etServer, port: etPort };
        const upgraded =
          transport === "et"
            ? await api.connectEt(
                result.sessionId,
                { serverPath: etServer, port: etPort },
                upgradedSession.onEvent,
              )
            : await api.connectMosh(
                result.sessionId,
                {
                  serverPath: moshServer,
                  portMin: moshPortMin,
                  portMax: moshPortMax,
                },
                upgradedSession.onEvent,
              );
        upgradedSession.establish(upgraded.sessionId);
        connectingSessions.current.add(upgraded.sessionId);
        await api.disconnect(result.sessionId);
        connectingSessions.current.delete(result.sessionId);
        control.session.terminal.dispose();
        control = undefined;
        if (!alive.current) {
          await api.disconnect(upgraded.sessionId);
          session.terminal.dispose();
          return;
        }
      }
      setPassword("");
      setPrivateKey("");
      setPassphrase("");
      connectingSessions.current.clear();
      connected(session);
    } catch (e) {
      if (session?.id) await api.disconnect(session.id).catch(() => {});
      if (control) {
        await api.disconnect(control.session.id).catch(() => {});
        control.session.terminal.dispose();
      }
      session?.terminal.dispose();
      const detail = e as SshError;
      if (detail?.kind === "unknown_host_key" && detail.fingerprint) {
        setTrustHostId(detail.hostId || host.id);
        setTrust(detail.fingerprint);
      } else {
        setTrust(null);
        setError(
          detail?.kind === "host_key_changed"
            ? "The host key changed. Connection blocked. Verify the server independently before replacing this host."
            : errorMessage(e),
        );
      }
    } finally {
      connectingSessions.current.clear();
      connecting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return (
    <Dialog
      title={trust ? "Verify this host" : `Connect to ${host.name}`}
      close={() => {
        void invoke("cancel_credential_auth").catch(() => {});
        close();
      }}
    >
      {trust ? (
        <div className="form-stack">
          <div className="host-key-icon">
            <ShieldCheck size={27} />
          </div>
          <p>
            This is your first connection to{" "}
            <strong>
              {trustHost.hostname}:{trustHost.port}
            </strong>
            . Check this fingerprint against the server through a trusted
            channel.
          </p>
          <div className="fingerprint">
            <span>Server public key · SHA-256</span>
            <code>{trust}</code>
          </div>
          <p className="muted">
            lazysh will pin this key and reject future connections if it
            changes. Credentials for this server have not been sent.
          </p>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button className="subtle-button" disabled={busy} onClick={close}>
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void connect(true)}
            >
              {busy ? "Connecting…" : "Trust key and connect"}
            </button>
          </div>
        </div>
      ) : (
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <p className="destination">
            <Server size={15} />
            {host.username}@{host.hostname}:{host.port}
          </p>
          <label>
            Transport
            <select
              value={transport}
              disabled={busy}
              onChange={(event) =>
                setTransport(event.target.value as "ssh" | "mosh" | "et")
              }
            >
              <option value="ssh">SSH</option>
              <option value="mosh" disabled={!moshAvailable}>
                Mosh{!moshAvailable ? " — unavailable for this connection" : ""}
              </option>
              <option value="et" disabled={!etAvailable}>
                Eternal Terminal
                {!etAvailable ? " — unavailable for this connection" : ""}
              </option>
            </select>
          </label>
          {transport === "et" && (
            <fieldset disabled={busy}>
              <legend>Eternal Terminal over TCP</legend>
              <p>
                SSH verifies the host and starts a fresh ET session. The host
                must already run its ET server.
              </p>
              <label>
                ET terminal path
                <input
                  required
                  maxLength={4096}
                  value={etServer}
                  onChange={(event) => setEtServer(event.target.value)}
                />
              </label>
              <label>
                ET server port
                <input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  value={etPort}
                  onChange={(event) => setEtPort(Number(event.target.value))}
                />
              </label>
            </fieldset>
          )}
          {transport === "mosh" && (
            <fieldset disabled={busy}>
              <legend>Mosh over UDP</legend>
              <p>
                SSH verifies the host and starts its Mosh server. UDP must reach
                the same host. A failed Mosh connection will not silently switch
                transports.
              </p>
              <label>
                Mosh server path
                <input
                  value={moshServer}
                  required
                  maxLength={4096}
                  onChange={(event) => setMoshServer(event.target.value)}
                />
              </label>
              <label>
                First UDP port
                <input
                  type="number"
                  required
                  min={1}
                  max={65535}
                  value={moshPortMin}
                  onChange={(event) =>
                    setMoshPortMin(Number(event.target.value))
                  }
                />
              </label>
              <label>
                Last UDP port
                <input
                  type="number"
                  required
                  min={moshPortMin}
                  max={Math.min(65535, moshPortMin + 1000)}
                  value={moshPortMax}
                  onChange={(event) =>
                    setMoshPortMax(Number(event.target.value))
                  }
                />
              </label>
            </fieldset>
          )}
          {host.jumpHostId && (
            <fieldset>
              <legend>
                Bastion:{" "}
                {hosts.find((item) => item.id === host.jumpHostId)?.name ||
                  host.jumpHostId}
              </legend>
              <label>
                <input
                  type="checkbox"
                  checked={savedJump}
                  onChange={(event) => setSavedJump(event.target.checked)}
                />
                Use bastion’s saved credentials
              </label>
              {savedJump ? (
                <p>
                  Connect to the bastion directly and save its credentials
                  first.
                </p>
              ) : (
                <label>
                  Bastion password
                  <input
                    type="password"
                    required
                    autoComplete="off"
                    value={jumpPassword}
                    onChange={(event) => setJumpPassword(event.target.value)}
                  />
                </label>
              )}
            </fieldset>
          )}
          <div
            className="segmented"
            role="group"
            aria-label="Authentication method"
          >
            <button
              type="button"
              aria-pressed={method === "password"}
              onClick={() => setMethod("password")}
            >
              Password
            </button>
            <button
              type="button"
              aria-pressed={method === "key"}
              onClick={() => setMethod("key")}
            >
              Private key
            </button>
          </div>
          {(savedCredentials || storedCredentials) && (
            <div>
              {savedCredentials && (
                <label>
                  <input
                    type="checkbox"
                    checked={useSavedCredentials}
                    onChange={(event) =>
                      setUseSavedCredentials(event.target.checked)
                    }
                  />
                  Use saved credentials
                </label>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void invoke("forget_credentials", { hostId: host.id })
                    .then(() => {
                      setSavedCredentials(false);
                      setStoredCredentials(false);
                      setUseSavedCredentials(false);
                      setExportedIdentity("");
                    })
                    .catch((e) => setError(errorMessage(e)));
                }}
              >
                Forget saved credentials
              </button>
            </div>
          )}
          {host.biometricUnlock && storedCredentials && (
            <div>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  const generation = ++exportGeneration.current;
                  void invoke<{ privateKey: string }>("export_saved_identity", {
                    hostId: host.id,
                  })
                    .then((result) => {
                      if (
                        alive.current &&
                        generation === exportGeneration.current
                      )
                        setExportedIdentity(result.privateKey);
                    })
                    .catch((error) => {
                      if (
                        alive.current &&
                        generation === exportGeneration.current
                      )
                        setError(errorMessage(error));
                    })
                    .finally(() => {
                      if (
                        alive.current &&
                        generation === exportGeneration.current
                      )
                        setBusy(false);
                    });
                }}
              >
                Export private key with biometrics
              </button>
              {exportedIdentity && (
                <>
                  <label>
                    Exported private key
                    <textarea
                      readOnly
                      autoComplete="off"
                      spellCheck={false}
                      value={exportedIdentity}
                    />
                  </label>
                  <button type="button" onClick={() => setExportedIdentity("")}>
                    Hide exported key
                  </button>
                </>
              )}
            </div>
          )}
          {useSavedCredentials ? (
            <p>Credentials will be read from this device’s secure store.</p>
          ) : method === "password" ? (
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                required
              />
            </label>
          ) : (
            <>
              <label>
                Private key (OpenSSH or PEM)
                <textarea
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  rows={7}
                  spellCheck={false}
                  autoComplete="off"
                  required
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              </label>
              <label>
                Key passphrase (if encrypted)
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <details>
                <summary>Generate or inspect an identity</summary>
                <CredentialsPanel
                  onUse={(credentials) => {
                    setPrivateKey(credentials.privateKey || "");
                    setPassphrase(credentials.passphrase || "");
                    setMethod("key");
                  }}
                />
              </details>
            </>
          )}
          <p className="security-note">
            <KeyRound size={15} /> Credentials stay in memory unless you choose
            to save them in this device’s secure store.
          </p>
          {!useSavedCredentials && (
            <label>
              <input
                type="checkbox"
                checked={rememberCredentials}
                onChange={(event) =>
                  setRememberCredentials(event.target.checked)
                }
              />
              Save credentials on this device after connecting
            </label>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="subtle-button" onClick={close}>
              Cancel
            </button>
            <button className="primary-button" disabled={busy}>
              {busy ? "Connecting…" : "Connect"}
              <ChevronRight size={16} />
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export default function App() {
  useClientAppearance();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<View>("terminal");
  const [editor, setEditor] = useState<Host | "new" | null>(null);
  const [connectingHost, setConnectingHost] = useState<Host | null>(null);
  const [deleting, setDeleting] = useState<Host | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [palette, setPalette] = useState(false);
  const [preferences, setPreferences] = useState(false);
  const [sync, setSync] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [mobileTools, setMobileTools] = useState(false);
  const [about, setAbout] = useState(false);
  const [inbox, setInbox] = useState(false);
  const [previousWorkspace, setPreviousWorkspace] = useState(readWorkspace);
  const [restoring, setRestoring] = useState(false);
  const restoringRef = useRef(false);
  const [sidebar, setSidebar] = useState(false);
  const [loaded, setLoaded] = useState(!native);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const active = sessions.find((session) => session.id === activeId);

  function persistWorkspace(next: SessionIntent[]) {
    try {
      saveWorkspace(next);
    } catch {
      setError("Workspace restoration could not be saved on this device.");
    }
  }
  async function restoreWorkspace() {
    if (restoringRef.current) return;
    restoringRef.current = true;
    setRestoring(true);
    setError("");
    const restored: LiveSession[] = [];
    const remaining: SessionIntent[] = [];
    const failures: string[] = [];
    for (const intent of previousWorkspace) {
      const host = hosts.find((item) => item.id === intent.hostId);
      if (!host || intent.attached?.kind === "zellij") {
        remaining.push(intent);
        continue;
      }
      let shell: Awaited<ReturnType<typeof prepareSession>> | undefined;
      let child: Awaited<ReturnType<typeof prepareSession>> | undefined;
      try {
        shell = await prepareSession(
          host.id,
          host.name,
          `${host.username}@${host.hostname}`,
        );
        const connected = await api.connect(host.id, {}, shell.onEvent, {
          useSavedCredentials: true,
        });
        shell.establish(connected.sessionId);
        if (intent.et) {
          child = await prepareSession(
            host.id,
            host.name,
            `${host.username}@${host.hostname} · ET`,
          );
          const result = await api.connectEt(
            shell.session.id,
            intent.et,
            child.onEvent,
          );
          child.establish(result.sessionId);
          child.session.et = intent.et;
          await api.disconnect(shell.session.id);
          shell.session.terminal.dispose();
          restored.push(child.session);
        } else if (intent.mosh) {
          child = await prepareSession(
            host.id,
            host.name,
            `${host.username}@${host.hostname} · Mosh`,
          );
          const result = await api.connectMosh(
            shell.session.id,
            intent.mosh,
            child.onEvent,
          );
          child.establish(result.sessionId);
          child.session.mosh = intent.mosh;
          await api.disconnect(shell.session.id);
          shell.session.terminal.dispose();
          restored.push(child.session);
        } else if (intent.attached) {
          child = await prepareSession(
            host.id,
            `${host.name} / ${intent.attached.name}`,
            shell.session.destination,
          );
          const attached =
            intent.attached.kind === "tmux"
              ? await api.attachTmux(
                  shell.session.id,
                  intent.attached.name,
                  child.onEvent,
                )
              : await api.attachMultiplexer(
                  shell.session.id,
                  intent.attached.kind,
                  intent.attached.name,
                  child.onEvent,
                );
          child.establish(attached.sessionId);
          child.session.attached = intent.attached;
          await api.disconnect(shell.session.id);
          shell.session.terminal.dispose();
          restored.push(child.session);
        } else restored.push(shell.session);
      } catch (error) {
        for (const pending of [child, shell])
          if (pending) {
            if (pending.session.id)
              await api.disconnect(pending.session.id).catch(() => {});
            pending.session.terminal.dispose();
          }
        remaining.push(intent);
        failures.push(`${host.name}: ${errorMessage(error)}`);
      }
    }
    const next = [...sessionsRef.current, ...restored];
    setSessions(next);
    if (restored.length) {
      setActiveId(restored[0].id);
      setView("terminal");
    }
    setPreviousWorkspace(remaining);
    setRestoring(false);
    restoringRef.current = false;
    if (restored.length) persistWorkspace([...next, ...remaining]);
    if (failures.length) setError(failures.join("\n"));
  }

  useEffect(() => {
    const stage = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (
        !detail ||
        typeof detail !== "object" ||
        !("sessionId" in detail) ||
        !("text" in detail) ||
        typeof detail.sessionId !== "string" ||
        typeof detail.text !== "string" ||
        detail.text.length > 65536 ||
        !detail.text.trim()
      )
        return;
      if (
        !sessionsRef.current.some(
          (session) => session.id === detail.sessionId && session.connected,
        )
      )
        return;
      setActiveId(detail.sessionId);
      setView("terminal");
    };
    window.addEventListener("lazysh-prompt-draft", stage);
    const openInbox = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (
        !detail ||
        typeof detail !== "object" ||
        !("sessionId" in detail) ||
        typeof detail.sessionId !== "string"
      )
        return;
      if (
        !sessionsRef.current.some(
          (session) => session.id === detail.sessionId && session.connected,
        )
      )
        return;
      setActiveId(detail.sessionId);
      setView("agents");
      setInbox(false);
    };
    window.addEventListener("lazysh-inbox-open", openInbox);
    return () => {
      window.removeEventListener("lazysh-prompt-draft", stage);
      window.removeEventListener("lazysh-inbox-open", openInbox);
    };
  }, []);

  async function loadHosts() {
    if (!native) return;
    try {
      setHosts(await api.listHosts());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => {
    void loadHosts();
  }, []);
  useEffect(() => {
    const rerender = () => setSessions((previous) => [...previous]);
    const displayError = (event: Event) =>
      setError(String((event as CustomEvent).detail));
    window.addEventListener("lazysh-session-change", rerender);
    window.addEventListener("lazysh-error", displayError);
    return () => {
      window.removeEventListener("lazysh-session-change", rerender);
      window.removeEventListener("lazysh-error", displayError);
    };
  }, []);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((value) => !value);
      }
      if (/^[1-9]$/.test(event.key)) {
        const target = sessionsRef.current[Number(event.key) - 1];
        if (target) {
          event.preventDefault();
          setActiveId(target.id);
          setView("terminal");
        }
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, []);

  async function saveHost(host: Host) {
    await api.saveHost(host);
    await loadHosts();
    setEditor(null);
  }
  async function deleteHost() {
    if (!deleting) return;
    try {
      await api.deleteHost(deleting.id);
      await loadHosts();
      setDeleting(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function closeSession(session: LiveSession) {
    try {
      await api.disconnect(session.id);
      session.terminal.dispose();
      persistWorkspace(
        sessionsRef.current.filter((item) => item.id !== session.id),
      );
      setSessions((previous) =>
        previous.filter((item) => item.id !== session.id),
      );
      if (activeId === session.id)
        setActiveId(
          sessions.find((item) => item.id !== session.id)?.id ?? null,
        );
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  function chooseHost(host: Host) {
    setConnectingHost(host);
    setPalette(false);
    setSidebar(false);
  }
  function sessionConnected(session: LiveSession) {
    persistWorkspace([...sessionsRef.current, session]);
    setSessions((previous) => [...previous, session]);
    setActiveId(session.id);
    setView("terminal");
    setConnectingHost(null);
    void loadHosts();
  }
  async function attachTmux(
    source: LiveSession,
    name: string,
    kind: "tmux" | "herdr" | "zellij" = "tmux",
  ) {
    const pending = await prepareSession(
      source.hostId,
      `${source.name} / ${name}`,
      source.destination,
    );
    try {
      const result =
        kind === "tmux"
          ? await api.attachTmux(source.id, name, pending.onEvent)
          : await api.attachMultiplexer(source.id, kind, name, pending.onEvent);
      pending.establish(result.sessionId);
      pending.session.attached = { kind, name };
      sessionConnected(pending.session);
    } catch (error) {
      pending.session.terminal.dispose();
      throw error;
    }
  }
  const shownHosts = hosts.filter((host) =>
    `${host.name} ${host.hostname} ${host.username}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );

  return (
    <div className="app-shell">
      <aside
        className={`sidebar ${sidebar ? "sidebar-open" : ""}`}
        aria-label="Hosts and connections"
      >
        <div className="brand">
          <span className="brand-mark">
            l<span>_</span>
          </span>
          <span>
            lazysh<small>your agents, within reach</small>
          </span>
          <button
            className="icon-button sidebar-close"
            aria-label="Close hosts"
            onClick={() => setSidebar(false)}
          >
            <X size={18} />
          </button>
        </div>
        <button className="search-button" onClick={() => setPalette(true)}>
          <Search size={15} />
          <span>Jump to a host</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="sidebar-heading">
          <span>HOSTS</span>
          <button
            className="icon-button"
            aria-label="Add host"
            disabled={!native}
            onClick={() => setEditor("new")}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="host-list">
          {!loaded ? (
            <p className="sidebar-hint">Loading hosts…</p>
          ) : hosts.length === 0 ? (
            <p className="sidebar-hint">
              Your machines live here.
              <br />
              Add a host to get started.
            </p>
          ) : (
            hosts.map((host) => (
              <div
                className={`host-item ${active?.hostId === host.id ? "host-active" : ""}`}
                key={host.id}
              >
                <button
                  className="host-connect"
                  aria-label={`Connect to ${host.name}`}
                  onClick={() => chooseHost(host)}
                >
                  <span className="host-symbol">
                    <Server size={17} />
                  </span>
                  <span>
                    <strong>{host.name}</strong>
                    <small>
                      {host.username}@{host.hostname}
                    </small>
                  </span>
                  {sessions.some(
                    (session) =>
                      session.hostId === host.id && session.connected,
                  ) && <span className="status-dot" aria-label="Connected" />}
                </button>
                <div className="host-actions">
                  <button
                    className="icon-button"
                    aria-label={`Edit ${host.name}`}
                    onClick={() => setEditor(host)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Delete ${host.name}`}
                    onClick={() => setDeleting(host)}
                    disabled={sessions.some(
                      (session) => session.hostId === host.id,
                    )}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        <button
          className="add-host-button"
          disabled={!native}
          onClick={() => setEditor("new")}
        >
          <Plus size={16} /> Add a host
        </button>
        <div className="sidebar-bottom">
          <div>
            <ShieldCheck size={15} />
            <span>Direct connection. Local first.</span>
          </div>
          <button
            className="about-button"
            onClick={() => {
              setAbout(true);
              setSidebar(false);
            }}
          >
            About lazysh · 0.1.0
          </button>
        </div>
      </aside>
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="Close host menu"
          onClick={() => setSidebar(false)}
        />
      )}
      <main className="workspace">
        <header className="workspace-header">
          <button
            className="icon-button mobile-menu"
            aria-label="Open hosts"
            onClick={() => setSidebar(true)}
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumb">
            <span>Workspace</span>
            {active && (
              <>
                <ChevronRight size={13} />
                <strong>{active.name}</strong>
              </>
            )}
          </div>
          <div className="header-right">
            <button
              className="icon-button mobile-tools"
              aria-label="Workspace tools"
              onClick={() => setMobileTools(true)}
            >
              <Ellipsis size={18} />
            </button>
            <button
              className="icon-button"
              aria-label="Shareable uploads"
              disabled={!native}
              onClick={() => setSharing(true)}
            >
              <Share2 size={16} />
            </button>
            <button
              className="icon-button"
              aria-label="Notification inbox"
              disabled={!native}
              onClick={() => setInbox(true)}
            >
              <Bell size={16} />
            </button>
            <button
              className="icon-button"
              aria-label="Encrypted sync"
              disabled={!native}
              onClick={() => setSync(true)}
            >
              <Cloud size={16} />
            </button>
            <button
              className="icon-button"
              aria-label="Preferences"
              onClick={() => setPreferences(true)}
            >
              <Settings size={16} />
            </button>
            <span className="connection-label">
              <span
                className={`status-dot ${active?.connected ? "" : "status-idle"}`}
              />
              {active?.connected
                ? active.mosh
                  ? "Mosh connected"
                  : active.et
                    ? "ET connected"
                    : "SSH connected"
                : "No active connection"}
            </span>
            <button
              className="icon-button"
              aria-label="Search hosts"
              onClick={() => setPalette(true)}
            >
              <Command size={16} />
            </button>
          </div>
        </header>
        {!native && (
          <div className="browser-banner" role="status">
            Browser preview · SSH connections require the native lazysh app. Run{" "}
            <code>bun run dev</code> to connect.
          </div>
        )}
        {native && previousWorkspace.length > 0 && (
          <div className="browser-banner">
            <button
              disabled={restoring || !loaded}
              onClick={() => void restoreWorkspace()}
            >
              {restoring ? "Restoring…" : "Restore previous workspace"}
            </button>
            <span>
              Uses saved credentials; tmux and Herdr reattach. Open Zellij
              sessions from Sessions.
            </span>
            <button
              disabled={restoring}
              onClick={() => {
                setPreviousWorkspace([]);
                persistWorkspace(sessionsRef.current);
              }}
            >
              Dismiss
            </button>
          </div>
        )}
        {error && (
          <div className="global-error" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {sessions.length > 0 && (
          <div
            className="session-tabs"
            role="tablist"
            aria-label="SSH connections"
          >
            {sessions.map((session) => (
              <div
                className={`session-tab ${activeId === session.id ? "session-tab-active" : ""}`}
                key={session.id}
              >
                <button
                  role="tab"
                  aria-selected={activeId === session.id}
                  onClick={() => setActiveId(session.id)}
                >
                  <span
                    className={`status-dot ${session.connected ? "" : "status-idle"}`}
                  />
                  {session.name}
                </button>
                <button
                  className="icon-button"
                  aria-label={`Disconnect ${session.name}`}
                  onClick={() => void closeSession(session)}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <button
              className="icon-button"
              aria-label="New connection"
              onClick={() => setPalette(true)}
            >
              <Plus size={16} />
            </button>
          </div>
        )}
        {active ? (
          <>
            <div className="session-toolbar">
              <nav className="view-tabs" aria-label="Session views">
                {views.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    aria-current={view === id ? "page" : undefined}
                    onClick={() => setView(id)}
                  >
                    <Icon size={15} />
                    <span>{label}</span>
                  </button>
                ))}
              </nav>
              <button
                className="icon-button disconnect-button"
                aria-label={`End ${active.name} connection`}
                onClick={() => void closeSession(active)}
              >
                <Unplug size={16} />
              </button>
            </div>
            <div className="session-body">
              <Suspense
                fallback={
                  <p className="loading" role="status">
                    Opening terminal…
                  </p>
                }
              >
                {sessions.map((session) => (
                  <TerminalPane
                    key={session.id}
                    session={session}
                    active={activeId === session.id && view === "terminal"}
                    reportError={setError}
                  />
                ))}
                {active.connected && view === "agents" && (
                  <AgentPanel key={active.id} sessionId={active.id} />
                )}
                {active.connected && view === "usage" && (
                  <UsagePanel key={active.id} sessionId={active.id} />
                )}
                {active.connected && view === "chat" && (
                  <ChatPanel
                    key={active.id}
                    sessionId={active.id}
                    onOpenTerminal={() => setView("terminal")}
                  />
                )}
                {active.connected && view === "preview" && (
                  <PreviewPanel key={active.id} sessionId={active.id} />
                )}
                {active.connected && view === "attachments" && (
                  <AttachmentPanel key={active.id} sessionId={active.id} />
                )}
                {active.connected && view === "voice" && (
                  <VoicePanel key={active.id} sessionId={active.id} />
                )}
                {active.connected && view === "devices" && (
                  <DevicePanel key={active.id} sessionId={active.id} />
                )}
                {active.connected && view === "files" && (
                  <FilesPanel key={active.id} sessionId={active.id} />
                )}
                {active.connected && view === "diff" && (
                  <RepositoryPanel key={active.id} sessionId={active.id} />
                )}
                {active.connected && view === "sessions" && (
                  <MuxPanel
                    key={active.id}
                    sessionId={active.id}
                    attached={active.attached}
                    onAttach={(name, kind) => attachTmux(active, name, kind)}
                  />
                )}
                {!active.connected && view !== "terminal" && (
                  <div className="panel-empty">
                    <Unplug size={28} />
                    <h3>This connection has ended.</h3>
                    <p>Connect again from Hosts to read live data.</p>
                  </div>
                )}
              </Suspense>
            </div>
            <footer className="workspace-footer">
              <span>
                <ShieldCheck size={12} />
                {active.destination}
              </span>
              <span>
                {active.connected ? "SSH" : "Disconnected"}
                <i />
                UTF-8
                <i />
                xterm-256color
              </span>
            </footer>
          </>
        ) : (
          <div className="welcome">
            <div className="welcome-content">
              <div className="welcome-terminal">
                <span>
                  l<span>_</span>
                </span>
                <div className="terminal-corner" />
              </div>
              <p className="welcome-kicker">
                A little closer to your machines.
              </p>
              <h1>
                Good work doesn’t
                <br />
                need a desk.
              </h1>
              <p className="welcome-copy">
                Your terminal, your agents, your own infrastructure.
                <br />
                Connect over SSH and pick up where you left off.
              </p>
              <button
                className="primary-button welcome-connect"
                disabled={!native}
                onClick={() =>
                  hosts.length ? setPalette(true) : setEditor("new")
                }
              >
                <Plus size={17} />
                {hosts.length ? "Connect to a host" : "Add your first host"}
                <ChevronRight size={16} />
              </button>
              <div className="welcome-features">
                <span>
                  <TerminalSquare size={16} />A real terminal
                </span>
                <span>
                  <Bot size={16} />
                  Built for agents
                </span>
                <span>
                  <ShieldCheck size={16} />
                  No session relay
                </span>
              </div>
            </div>
            <div className="welcome-bottom">
              <span>Works with the tools you already use.</span>
              <div>
                Claude Code <i /> Codex <i /> OpenCode <i /> tmux
              </div>
            </div>
          </div>
        )}
      </main>
      {editor && (
        <HostEditor
          hosts={hosts}
          initial={editor === "new" ? null : editor}
          save={saveHost}
          close={() => setEditor(null)}
        />
      )}
      {connectingHost && (
        <ConnectDialog
          hosts={hosts}
          host={connectingHost}
          connected={sessionConnected}
          close={() => setConnectingHost(null)}
        />
      )}
      {deleting && (
        <Dialog title="Delete host" close={() => setDeleting(null)}>
          <div className="form-stack">
            <p>
              Remove <strong>{deleting.name}</strong> and its pinned host key
              from lazysh? Nothing on the remote machine will be changed.
            </p>
            <div className="dialog-actions">
              <button
                className="subtle-button"
                onClick={() => setDeleting(null)}
              >
                Cancel
              </button>
              <button
                className="danger-button"
                onClick={() => void deleteHost()}
              >
                Delete host
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {palette && (
        <Dialog
          title="Jump to a host"
          close={() => {
            setPalette(false);
            setSearch("");
          }}
        >
          <div className="palette-search">
            <Search size={18} />
            <input
              aria-label="Search saved hosts"
              placeholder="Search hosts or addresses…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>
          <div className="palette-list">
            {shownHosts.map((host) => (
              <button key={host.id} onClick={() => chooseHost(host)}>
                <Server size={18} />
                <span>
                  <strong>{host.name}</strong>
                  <small>
                    {host.username}@{host.hostname}
                  </small>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
            {shownHosts.length === 0 && (
              <p className="muted">
                {native
                  ? "No matching hosts. Add one to start a connection."
                  : "Open the native app to manage SSH hosts."}
              </p>
            )}
          </div>
          <button
            className="add-host-button"
            disabled={!native}
            onClick={() => {
              setPalette(false);
              setEditor("new");
            }}
          >
            <Plus size={16} /> Add a new host
          </button>
        </Dialog>
      )}
      {preferences && (
        <Dialog title="Preferences" close={() => setPreferences(false)}>
          <PreferencesPanel />
        </Dialog>
      )}
      {native && <NotificationMonitor sessions={sessions} />}
      {inbox && (
        <Dialog title="Notification inbox" close={() => setInbox(false)}>
          <NotificationPanel sessions={sessions} />
        </Dialog>
      )}
      {about && (
        <Dialog title="About lazysh" close={() => setAbout(false)}>
          <Suspense fallback={<p>Loading license…</p>}>
            <AboutPanel />
          </Suspense>
        </Dialog>
      )}
      {mobileTools && (
        <Dialog title="Workspace tools" close={() => setMobileTools(false)}>
          <div className="form-stack">
            <button
              disabled={!native}
              onClick={() => {
                setMobileTools(false);
                setInbox(true);
              }}
            >
              Open notification inbox
            </button>
            <button
              disabled={!native}
              onClick={() => {
                setMobileTools(false);
                setSync(true);
              }}
            >
              Open encrypted sync
            </button>
            <button
              disabled={!native}
              onClick={() => {
                setMobileTools(false);
                setSharing(true);
              }}
            >
              Open shareable uploads
            </button>
            <button
              onClick={() => {
                setMobileTools(false);
                setPalette(true);
              }}
            >
              Search saved hosts
            </button>
          </div>
        </Dialog>
      )}
      {sharing && (
        <Dialog title="Shareable uploads" close={() => setSharing(false)}>
          <Suspense fallback={<p>Loading sharing…</p>}>
            <SharePanel />
          </Suspense>
        </Dialog>
      )}
      {sync && (
        <Dialog title="Encrypted sync" close={() => setSync(false)}>
          <Suspense fallback={<p>Opening sync…</p>}>
            <SyncPanel onHostsChanged={() => void loadHosts()} />
          </Suspense>
        </Dialog>
      )}
    </div>
  );
}
