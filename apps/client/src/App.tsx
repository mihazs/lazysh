import {
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Bot,
  ChevronRight,
  Command,
  FolderOpen,
  GitCompareArrows,
  KeyRound,
  Layers,
  Menu,
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
import { FilesPanel, DiffPanel, MuxPanel, errorMessage } from "./SessionTools";
import AgentPanel from "./AgentPanel";

const TerminalPane = lazy(() => import("./TerminalPane"));

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

type View = "terminal" | "agents" | "files" | "diff" | "sessions";
const views = [
  { id: "terminal" as const, label: "Terminal", Icon: TerminalSquare },
  { id: "agents" as const, label: "Agents", Icon: Bot },
  { id: "files" as const, label: "Files", Icon: FolderOpen },
  { id: "diff" as const, label: "Diff", Icon: GitCompareArrows },
  { id: "sessions" as const, label: "Sessions", Icon: Layers },
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
  save,
  close,
}: {
  initial: Host | null;
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
  connected,
  close,
}: {
  host: Host;
  connected: (session: LiveSession) => void;
  close: () => void;
}) {
  const [method, setMethod] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [trust, setTrust] = useState<string | null>(null);
  const connecting = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function connect(accept = false) {
    if (connecting.current) return;
    connecting.current = true;
    setBusy(true);
    setError("");
    let session: LiveSession | undefined;
    try {
      if (accept && trust) {
        await api.trustHostKey(host.id, trust);
        setTrust(null);
      }
      const credentials: Credentials =
        method === "password"
          ? { password }
          : { privateKey, ...(passphrase ? { passphrase } : {}) };
      const pending = await prepareSession(
        host.id,
        host.name,
        `${host.username}@${host.hostname}`,
      );
      session = pending.session;
      const result = await api.connect(host.id, credentials, pending.onEvent);
      pending.establish(result.sessionId);
      if (!alive.current) {
        await api.disconnect(result.sessionId);
        session.terminal.dispose();
        return;
      }
      setPassword("");
      setPrivateKey("");
      setPassphrase("");
      connected(session);
    } catch (e) {
      session?.terminal.dispose();
      const detail = e as SshError;
      if (detail?.kind === "unknown_host_key" && detail.fingerprint)
        setTrust(detail.fingerprint);
      else {
        setTrust(null);
        setError(
          detail?.kind === "host_key_changed"
            ? "The host key changed. Connection blocked. Verify the server independently before replacing this host."
            : errorMessage(e),
        );
      }
    } finally {
      connecting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return (
    <Dialog
      title={trust ? "Verify this host" : `Connect to ${host.name}`}
      close={() => {
        if (!busy) close();
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
              {host.hostname}:{host.port}
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
            changes. Your credentials have not been sent.
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
          {method === "password" ? (
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
            </>
          )}
          <p className="security-note">
            <KeyRound size={15} /> Credentials stay in memory and are cleared
            after connection.
          </p>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="subtle-button"
              disabled={busy}
              onClick={close}
            >
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
  const [sidebar, setSidebar] = useState(false);
  const [loaded, setLoaded] = useState(!native);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const active = sessions.find((session) => session.id === activeId);

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
    setSessions((previous) => [...previous, session]);
    setActiveId(session.id);
    setView("terminal");
    setConnectingHost(null);
    void loadHosts();
  }
  async function attachTmux(source: LiveSession, name: string) {
    const pending = await prepareSession(
      source.hostId,
      `${source.name} / ${name}`,
      source.destination,
    );
    try {
      const result = await api.attachTmux(source.id, name, pending.onEvent);
      pending.establish(result.sessionId);
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
          <small>
            lazysh <span>0.1.0 · alpha</span>
          </small>
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
            <span className="connection-label">
              <span
                className={`status-dot ${active?.connected ? "" : "status-idle"}`}
              />
              {active?.connected ? "SSH connected" : "No active connection"}
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
              </Suspense>
              {active.connected && view === "agents" && (
                <AgentPanel key={active.id} sessionId={active.id} />
              )}
              {active.connected && view === "files" && (
                <FilesPanel key={active.id} sessionId={active.id} />
              )}
              {active.connected && view === "diff" && (
                <DiffPanel key={active.id} sessionId={active.id} />
              )}
              {active.connected && view === "sessions" && (
                <MuxPanel
                  key={active.id}
                  sessionId={active.id}
                  onAttach={(name) => attachTmux(active, name)}
                />
              )}
              {!active.connected && view !== "terminal" && (
                <div className="panel-empty">
                  <Unplug size={28} />
                  <h3>This connection has ended.</h3>
                  <p>Connect again from Hosts to read live data.</p>
                </div>
              )}
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
          initial={editor === "new" ? null : editor}
          save={saveHost}
          close={() => setEditor(null)}
        />
      )}
      {connectingHost && (
        <ConnectDialog
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
    </div>
  );
}
