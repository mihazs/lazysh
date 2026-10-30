import {captureUiError, LocalUiError, uiErrorText, type UiErrorCause} from './i18n/localError';
import {t, useUi} from './i18n/core';
import {appVersion} from './version';
import bedModeMark from '../../../brand/lazysh/svg/icon-gradient.svg';
import {useClientLocale} from './i18n/useClientLocale';
import {nativeLocale} from './i18n/nativeLocale';
import {NativeLocaleNotice} from './i18n/NativeLocaleNotice';
import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { bindProtectedApi, bindProtectedInvoke, captureAccess, useProtectedInvoke, type AccessLease } from './access';
import AccessShell, { type SessionRegistry } from './AccessShell';
import ThemeLinkPanel from './ThemeLinkPanel';
import {captureLaunchError, ownedLaunchError, useDesktopLaunch, type DesktopHostLaunch, type DesktopMuxRequest} from './useDesktopLaunch';
import AccessPanel from './AccessPanel';
import { forgetSession, PendingSessions, retainSession } from './pendingSessions';
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
  api as nativeApi,
  native,
  type Credentials,
  type Host,
  type SshError,
  type SshEvent,
  type TransportMode,
  type AutoOptions,
} from "./bridge";
import type { LiveSession } from "./terminal";
import {attachmentTerminalInput,type AttachmentPathPaste} from './attachmentPaste';
import type { AppleUsageReport } from "./UsagePanel";
import {useAccountUsage} from "./useAccountUsage";
import {AccountUsageBar,AccountUsageDetails} from "./AccountUsage";
import { FilesPanel, MuxPanel, errorMessage } from "./SessionTools";
import AgentPanel, {type ReportedHistorySource} from "./AgentPanel";
import PreferencesPanel from "./PreferencesPanel";
import { useClientAppearance } from "./appearance";
import { usePreferences } from "./preferences";
import CredentialsPanel from "./CredentialsPanel";
import { readWorkspace, saveWorkspace, type SessionIntent } from "./workspace";
import NotificationPanel, { NotificationMonitor } from "./NotificationPanel";
import {appShortcut} from './keyboard';
import { dictationInput, type DirectDictation } from './voiceDelivery';

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
const PushSettingsPanel = lazy(() => import('./PushSettingsPanel'));
const AppleStatusPanel = lazy(() => import('./AppleStatusPanel'));
const TmuxJumpPanel = lazy(() => import('./TmuxJumpPanel'));

function disposeTerminal(session?: LiveSession) {
  if (!session || session.disposed) return;
  session.disposed = true; session.connected = false; forgetSession(session.id); session.terminal.dispose();
}

async function prepareSession(
  hostId: string,
  name: string,
  destination: string,
  lease: AccessLease,
) {
  const { createTerminal } = await import("./terminal");
  lease.assert();
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
    void nativeApi
      .ackOutput(session.id, bytes)
      .catch((error) => {
        if (!session.disposed) window.dispatchEvent(
          new CustomEvent("lazysh-error", { detail: errorMessage(error) }),
        );
      });
  };
  const onEvent = (event: SshEvent) => {
    if (session.disposed) return;
    if (event.type === "data")
      session.terminal.write(new Uint8Array(event.data), () =>
        acknowledge(event.data.length),
      );
    else {
      session.connected = false;
      session.message = event.message || t("appConnectionClosed");
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

const defaultMosh = {serverPath: 'mosh-server', portMin: 60000, portMax: 61000};
const defaultEt = {serverPath: 'etterminal', port: 2022};
const fallbackErrors = new Set([
  'mosh_bootstrap', 'mosh_locale', 'mosh_udp_unreachable', 'mosh_closed',
  'mosh_unsupported', 'mosh_unsupported_route', 'mosh_unsupported_forwarding',
  'et_bootstrap', 'et_unreachable', 'et_closed', 'et_unsupported_handshake',
  'et_unsupported_route', 'et_agent_forwarding',
]);
type Prepared = Awaited<ReturnType<typeof prepareSession>>;
async function selectTransport(
  shell: Prepared, host: Host, mode: TransportMode, options: AutoOptions,
  capabilities: {mosh: boolean; et: boolean; reason?: string},
  lease: AccessLease,
  alive: () => boolean,
  track: (id: string) => void = () => {},
  untrack: (id: string) => void = () => {},
): Promise<Prepared> {
  const api = bindProtectedApi(nativeApi, lease);
  const pending = new PendingSessions(); pending.add(shell.session.id);
  const reasons: string[] = [];
  const ensureAlive = () => { if (!alive()) throw {kind:'cancelled', message:t("appConnectionCancelled")}; };
  for (const kind of mode === 'auto' ? ['mosh', 'et'] as const : mode === 'ssh' ? [] : [mode]) {
    ensureAlive();
    const name = kind === 'mosh' ? 'Mosh' : 'Eternal Terminal';
    if (mode === 'auto') {
      const skip = host.jumpHostId ? t("appBastionRoutesUseSSH") : host.forwardAgent ? t("appSelectedIdentityForwardingRequiresSSH") : !capabilities[kind] ? capabilities.reason || t("appUnavailableInThisAppBuild") : '';
      if (skip) { reasons.push(`${name}: ${skip}`); continue; }
    }
    const child = await prepareSession(host.id, host.name, `${host.username}@${host.hostname} · ${kind === 'mosh' ? 'Mosh' : 'ET'}`, lease);
    try {
      ensureAlive();
      const result = kind === 'mosh'
        ? await api.connectMosh(shell.session.id, options.mosh, child.onEvent)
        : await api.connectEt(shell.session.id, options.et, child.onEvent);
      child.establish(result.sessionId);
      pending.add(result.sessionId);
      track(result.sessionId);
      ensureAlive();
      if (!child.session.connected) throw {kind:'disconnected', message:t("appClosedBeforeConnection", {name})};
      if (kind === 'mosh') child.session.mosh = options.mosh;
      else child.session.et = options.et;
      if (mode === 'auto') {
        child.session.auto = options;
        child.session.transportNotice = t('appAutoSelected', {name, details: reasons.length ? ` ${reasons.join('; ')}.` : ''});
      }
      await pending.close(shell.session.id);
      untrack(shell.session.id);
      disposeTerminal(shell.session);
      pending.delete(child.session.id);
      return child;
    } catch (error) {
      if (child.session.id) {
        await pending.close(child.session.id).catch(() => {});
        untrack(child.session.id);
      }
      disposeTerminal(child.session);
      ensureAlive();
      if (mode !== 'auto' || !fallbackErrors.has((error as SshError)?.kind)) throw error;
      reasons.push(`${name}: ${errorMessage(error)}`);
    }
  }
  ensureAlive();
  if (!shell.session.connected) throw {kind:'disconnected', message:t("appVerifiedSSHControlConnectionHasEnded")};
  if (mode === 'auto') {
    shell.session.auto = options;
    shell.session.transportNotice = t('appAutoSsh', {details:reasons.join('; ')});
  }
  return shell;
}

type NavigationMode = 'connections'|'workspaces'|'agents';
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
  | "devices"
  | "apple";
const views = () => [
  { id: "terminal" as const, label: t("appTerminal"), Icon: TerminalSquare },
  { id: "apple" as const, label: t("appAppleStatus"), Icon: Activity },
  { id: "agents" as const, label: t("appAgents"), Icon: Bot },
  { id: "chat" as const, label: t("appTranscript"), Icon: MessageSquare },
  { id: "usage" as const, label: t("appUsage"), Icon: Activity },
  { id: "files" as const, label: t("appFiles"), Icon: FolderOpen },
  { id: "diff" as const, label: t("appDiff"), Icon: GitCompareArrows },
  { id: "sessions" as const, label: t("appSessions"), Icon: Layers },
  { id: "preview" as const, label: t("appPreview"), Icon: Globe },
  { id: "attachments" as const, label: t("appAttach"), Icon: Paperclip },
  { id: "voice" as const, label: t("appDictate"), Icon: Mic },
  { id: "devices" as const, label: t("appDevices"), Icon: Smartphone },
];

function focusableWithin(container:HTMLElement|null) {
  return Array.from(
        container?.querySelectorAll<HTMLElement>(
          'button, input, textarea, select, summary, a[href], [tabindex]',
        ) ?? [],
      ).filter(control => {
        if (control.tabIndex < 0 || control.matches(':disabled')
          || control.closest('[hidden], [inert]')
          || control.getClientRects().length === 0
          || getComputedStyle(control).visibility !== 'visible') return false;
        // Collapsed details may retain cached layout rects after being opened.
        for (let parent=control.parentElement; parent && parent!==container; parent=parent.parentElement) {
          if (parent.matches('details:not([open])')
            && !parent.querySelector(':scope > summary')?.contains(control)) return false;
        }
        return true;
      })
        .sort((a,b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
}
function cycleFocus(event:KeyboardEvent,items:HTMLElement[]) {
  if(event.key!=='Tab')return;
  const first=items[0],last=items.at(-1);
  if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
  else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
}

function Dialog({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  useUi();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => focusableWithin(ref.current);
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
      cycleFocus(event,focusable());
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
            aria-label={t("appCloseValue1", {value1: title})}
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
  host: Pick<Host, "hostname" | "username" | "port" | "name" | "defaultMultiplexer">,
) {
  if (!host.name.trim()) return t("appGiveThisHostAName");
  if (!host.hostname.trim() || /[\s/@\x00-\x1f]/.test(host.hostname))
    return t("appEnterAHostnameOrIPAddressWithoutAUsername");
  if (!host.username.trim() || /[\s\x00-\x1f]/.test(host.username))
    return t("appEnterAUsernameWithoutSpaces");
  if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535)
    return t("appPortMustBeBetween1And65535");
  const mux=host.defaultMultiplexer;
  if(mux && (!['tmux','herdr','zellij'].includes(mux.kind) || !mux.name.trim() || new TextEncoder().encode(mux.name).length>200 || /[\x00-\x1f\x7f-\x9f]/.test(mux.name) || (mux.kind==='zellij' && mux.name.startsWith('-')) || (mux.kind==='tmux' && /[:.]/.test(mux.name)) || (mux.kind==='herdr' && (!/^[a-zA-Z0-9._-]{1,64}$/.test(mux.name) || /^\.{1,2}$/.test(mux.name)))))return t('defaultMuxInvalid');
  return "";
}

function TransportOptions({mode, options, change, busy = false}: {mode:TransportMode; options:AutoOptions; change:(value:AutoOptions)=>void; busy?:boolean}) {
  useUi();
  const {mosh, et} = options;
  return <>
    {(mode === 'auto' || mode === 'mosh') && <fieldset disabled={busy}>
      <legend>{t("appMoshOverUDP")}</legend>
      <p>{t("appSSHVerifiesTheHostAndStartsItsMoshServer")}</p>
      <label>{t("appMoshServerPath")}<input required maxLength={4096} value={mosh.serverPath} onChange={e=>change({...options,mosh:{...mosh,serverPath:e.target.value}})} /></label>
      <label>{t("appFirstUDPPort")}<input required type="number" min={1} max={65535} value={mosh.portMin} onChange={e=>change({...options,mosh:{...mosh,portMin:Number(e.target.value)}})} /></label>
      <label>{t("appLastUDPPort")}<input required type="number" min={mosh.portMin} max={Math.min(65535,mosh.portMin+1000)} value={mosh.portMax} onChange={e=>change({...options,mosh:{...mosh,portMax:Number(e.target.value)}})} /></label>
    </fieldset>}
    {(mode === 'auto' || mode === 'et') && <fieldset disabled={busy}>
      <legend>{t("appEternalTerminalOverTCP")}</legend>
      <p>{t("appTheHostMustRunEtserverForcedETNeverFalls")}</p>
      <label>{t("appETTerminalPath")}<input required maxLength={4096} value={et.serverPath} onChange={e=>change({...options,et:{...et,serverPath:e.target.value}})} /></label>
      <label>{t("appETServerPort")}<input required type="number" min={1} max={65535} value={et.port} onChange={e=>change({...options,et:{...et,port:Number(e.target.value)}})} /></label>
    </fieldset>}
    {mode === 'auto' && <p className="security-note">{t("appAutoTriesMoshThenEternalTerminalThenSSHAfter")}</p>}
  </>;
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
  useUi();
  const invoke = useProtectedInvoke();
  const [editorLease] = useState(captureAccess);
  const [idCopy, setIdCopy] = useState<'copied'|'failed'|null>(null);
  const copyGeneration=useRef(0);
  useEffect(()=>()=>{copyGeneration.current++;},[]);
  async function copyHostId() {
    if(!initial || !editorLease.current())return;
    const current=++copyGeneration.current;
    try {
      await navigator.clipboard.writeText(initial.id);
      if(current===copyGeneration.current && editorLease.current())setIdCopy('copied');
    } catch {
      if(current===copyGeneration.current && editorLease.current())setIdCopy('failed');
    }
  }
  const [host, setHost] = useState<Host>(
    initial ?? {
      id: crypto.randomUUID(),
      name: "",
      hostname: "",
      port: 22,
      username: "",
      transport: "auto",
    },
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [protection, setProtection] = useState({
    available: false,
    reason: t("appCheckingDeviceSupport"),
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
            reason: t("appBiometricProtectionIsUnavailableOnThisDevice"),
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
      title={initial ? t("appEditHost") : t("appAddAHost")}
      close={() => {
        if (!busy) close();
      }}
    >
      <form onSubmit={(event) => void submit(event)} className="form-stack">
        <p className="muted">{t("appConnectDirectlyToAMachineYouControlNoRelay")}</p>
        {initial && <><label>{t('desktopLaunchHostId')}<input readOnly value={initial.id}/></label>
          <button type="button" className="subtle-button" onClick={()=>{void copyHostId();}}>{t('desktopLaunchCopyHostId')}</button>
          {idCopy && <p role="status">{t(idCopy==='copied'?'desktopLaunchHostIdCopied':'desktopLaunchHostIdCopyFailed')}</p>}</>}
        <label>{t("appName")}<input
            value={host.name}
            onChange={(e) => setHost({ ...host, name: e.target.value })}
            placeholder={t("appHomeWorkstation")}
            required
            maxLength={80}
          />
        </label>
        <div className="form-columns">
          <label>{t("appHostnameOrIP")}<input
              value={host.hostname}
              onChange={(e) => setHost({ ...host, hostname: e.target.value })}
              placeholder="workstation.local"
              required
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <label className="port-field">{t("appPort")}<input
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
        <label>{t("appUsername")}<input
            value={host.username}
            onChange={(e) => setHost({ ...host, username: e.target.value })}
            placeholder={t("appYourSSHUsername")}
            required
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <label>{t('defaultMuxLabel')}<select value={host.defaultMultiplexer?.kind ?? ''} disabled={busy} onChange={event=>setHost({...host,defaultMultiplexer:event.target.value ? {kind:event.target.value as 'tmux'|'herdr'|'zellij',name:host.defaultMultiplexer?.name ?? ''} : undefined})}>
          <option value="">{t('defaultMuxNone')}</option><option value="tmux">tmux</option><option value="herdr">Herdr</option><option value="zellij">Zellij</option>
        </select></label>
        {host.defaultMultiplexer && <>
          <label>{t('defaultMuxName')}<input required maxLength={200} value={host.defaultMultiplexer.name} disabled={busy} onChange={event=>setHost({...host,defaultMultiplexer:{...host.defaultMultiplexer!,name:event.target.value}})} autoCapitalize="none" autoCorrect="off" spellCheck={false}/></label>
          <p className="security-note">{t('defaultMuxSsh')}</p><p className="muted">{t('defaultMuxCreate')}</p>
        </>}
        <label>{t("appPreferredTransport")}<select value={host.transport ?? 'ssh'} disabled={busy} onChange={event=>setHost({...host, transport:event.target.value as TransportMode})}>
            <option value="auto">{t("appAutoMoshThenETThenSSH")}</option>
            <option value="ssh">SSH</option><option value="mosh">{t("appMoshForced")}</option><option value="et">{t("appEternalTerminalForced")}</option>
          </select>
        </label>
        <TransportOptions mode={host.transport ?? 'ssh'} busy={busy}
          options={{mosh:host.mosh ?? defaultMosh, et:host.et ?? defaultEt}}
          change={options=>setHost({...host,...options})} />
        {initial?.fingerprint && (
          <p className="security-note">
            <ShieldCheck size={15} />{" "}{t("appHostKeyIsPinnedChangingTheDestinationRequiresVerification")}</p>
        )}
        <label>{t("appSSHBastion")}<select
            value={host.jumpHostId || ""}
            onChange={(event) =>
              setHost({ ...host, jumpHostId: event.target.value || null })
            }
          >
            <option value="">{t("appConnectDirectly")}</option>
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
          />{t("appForwardThisConnectionSPrivateKeyIdentity")}</label>
        <label>
          <input
            type="checkbox"
            checked={host.biometricUnlock === true}
            disabled={!protection.available && !host.biometricUnlock}
            onChange={(event) =>
              setHost({ ...host, biometricUnlock: event.target.checked })
            }
          />{t("appRequireBiometricsForSavedCredentials")}</label>
        <p className="security-note">{protection.reason}</p>
        {host.forwardAgent && (
          <p className="security-note">{t("appProgramsOnThisHostCanRequestSignaturesWithYour")}</p>
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
          >{t("appCancel")}</button>
          <button className="primary-button" disabled={busy}>
            {busy ? t("appSaving") : t("appSaveHost")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ConnectDialog({
  host,
  hosts,
  connected,
  close,
  launch,
  recovery,
}: {
  host: Host;
  hosts: Host[];
  connected: (session: LiveSession) => void;
  close: () => void;
  launch?: DesktopHostLaunch;
  recovery?: {sessionId:string;restored:()=>void};
}) {
  useUi();
  const [lease] = useState(() => launch?.lease ?? captureAccess());
  const invoke = useMemo(() => bindProtectedInvoke(lease), [lease]);
  const api = useMemo(() => bindProtectedApi(nativeApi, lease), [lease]);
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
  const [error, setError] = useState<UiErrorCause>("");
  const [trust, setTrust] = useState<string | null>(null);
  const [trustHostId, setTrustHostId] = useState(host.id);
  const [savedJump, setSavedJump] = useState(true);
  const [jumpPassword, setJumpPassword] = useState("");
  const [exportedIdentity, setExportedIdentity] = useState("");
  // Explicit launch receipts keep their original directory/multiplexer semantics.
  const defaultMultiplexer=launch || recovery ? undefined : host.defaultMultiplexer;
  const [transport, setTransport] = useState<TransportMode>(recovery || launch?.mux || defaultMultiplexer ? "ssh" : host.transport ?? "ssh");
  const [moshAvailable, setMoshAvailable] = useState(false);
  const [etAvailable, setEtAvailable] = useState(false);
  const [capabilitiesReady, setCapabilitiesReady] = useState(false);
  const [capabilityReason, setCapabilityReason] = useState('');
  const [etServer, setEtServer] = useState(host.et?.serverPath ?? defaultEt.serverPath);
  const [etPort, setEtPort] = useState(host.et?.port ?? defaultEt.port);
  const [moshServer, setMoshServer] = useState(host.mosh?.serverPath ?? defaultMosh.serverPath);
  const [moshPortMin, setMoshPortMin] = useState(host.mosh?.portMin ?? defaultMosh.portMin);
  const [moshPortMax, setMoshPortMax] = useState(host.mosh?.portMax ?? defaultMosh.portMax);
  const exportGeneration = useRef(0);
  const trustHost = hosts.find((item) => item.id === trustHostId) || host;
  const connecting = useRef(false);
  const connectingSessions = useRef(new PendingSessions());
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
      .catch(() => { if (alive.current) setCapabilityReason(t("appTransportCapabilityCheckFailed")); })
      .finally(() => { if (alive.current) setCapabilitiesReady(true); });
    void invoke<boolean>("has_credentials", { hostId: host.id })
      .then((saved) => {
        if (alive.current) setSavedCredentials(saved === true);
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      void invoke("cancel_credential_auth").catch(() => {});
      for (const id of connectingSessions.current)
        void connectingSessions.current.close(id).catch(() => {});
      connectingSessions.current.clear();
    };
  }, []);

  async function connect(accept = false) {
    if (connecting.current || (transport === 'auto' && !capabilitiesReady)) return;
    connecting.current = true;
    setBusy(true);
    setError("");
    let session: LiveSession | undefined;
    let bootstrap: LiveSession | undefined;
    try {
      if (accept && trust) {
        await (launch ? api.trustHostKey(trustHostId, trust, launch.receipt).catch(error=>{throw ownedLaunchError(error) ?? error;})
          : api.trustHostKey(trustHostId, trust));
        setTrust(null);
      }
      const credentials: Credentials = useSavedCredentials
        ? {}
        : method === "password"
          ? { password }
          : { privateKey, ...(passphrase ? { passphrase } : {}) };
      if(recovery) {
        const result=await api.restoreFileTransfer(recovery.sessionId,credentials,{useSavedCredentials});
        if(!result || typeof result!=='object' || result.schemaVersion!==1 || result.status!=='restored' || Object.keys(result).some(key=>!['schemaVersion','status'].includes(key)))throw new LocalUiError('attachmentRestoreInvalid');
        if(alive.current && lease.current()) {setPassword('');setPrivateKey('');setPassphrase('');recovery.restored();}
        return;
      }
      const pending = await prepareSession(
        host.id,
        host.name,
        `${host.username}@${host.hostname}`,
        lease,
      );
      session = pending.session;
      const result =
        rememberCredentials ||
        useSavedCredentials ||
        (host.jumpHostId && !savedJump) || launch
          ? await api.connect(host.id, credentials, pending.onEvent, {
              ...((rememberCredentials || useSavedCredentials || (host.jumpHostId && !savedJump)) ? {rememberCredentials,useSavedCredentials} : {}),
              ...(launch ? {launchReceipt:launch.receipt} : {}),
              ...(host.jumpHostId && !savedJump
                ? { jumpCredentials: { password: jumpPassword } }
                : {}),
            }).catch(error=>{throw launch ? ownedLaunchError(error) ?? error : error;})
          : await api.connect(host.id, credentials, pending.onEvent);
      pending.establish(result.sessionId);
      connectingSessions.current.add(result.sessionId);
      if (!alive.current || !lease.current()) {
        await connectingSessions.current.close(result.sessionId);
        disposeTerminal(session);
        return;
      }
      let selected: Prepared;
      if(defaultMultiplexer) {
        bootstrap=pending.session;
        const child=await prepareSession(host.id,`${host.name} / ${defaultMultiplexer.name}`,pending.session.destination,lease);
        session=child.session;
        const result=await api.attachDefaultMultiplexer(pending.session.id,defaultMultiplexer,child.onEvent);
        child.establish(result.sessionId);connectingSessions.current.add(result.sessionId);
        if(!alive.current || !lease.current() || !child.session.connected)throw {kind:'disconnected',message:t('defaultMuxClosed')};
        child.session.attached={...defaultMultiplexer};
        await connectingSessions.current.close(pending.session.id);
        disposeTerminal(pending.session);bootstrap=undefined;
        selected=child;
      } else selected = await selectTransport(pending, host, transport, {
        mosh: {serverPath: moshServer, portMin: moshPortMin, portMax: moshPortMax},
        et: {serverPath: etServer, port: etPort},
      }, {mosh: moshAvailable, et: etAvailable, reason:capabilityReason}, lease, () => alive.current && lease.current(),
      (id) => connectingSessions.current.add(id),
      (id) => connectingSessions.current.delete(id));
      session = selected.session;
      if (!alive.current || !lease.current()) {
        await connectingSessions.current.close(session.id);
        disposeTerminal(session);
        return;
      }
      setPassword("");
      setPrivateKey("");
      setPassphrase("");
      connectingSessions.current.clear();
      connected(session);
    } catch (e) {
      await connectingSessions.current.closeAll().catch(() => {});
      disposeTerminal(session);
      disposeTerminal(bootstrap);
      if (!alive.current || !lease.current()) return;
      const detail = e as SshError;
      if (!recovery && detail?.kind === "unknown_host_key" && detail.fingerprint) {
        setTrustHostId(detail.hostId || host.id);
        setTrust(detail.fingerprint);
      } else {
        setTrust(null);
        setError(
          detail?.kind === "host_key_changed"
            ? t("appHostKeyChanged")
            : captureUiError(e),
        );
      }
    } finally {
      connectingSessions.current.clear();
      connecting.current = false;
      if (alive.current && lease.current()) setBusy(false);
    }
  }

  async function cancel() {
    void invoke("cancel_credential_auth").catch(() => {});
    try {
      if(launch)await invoke('desktop_launch_cancel',{receipt:launch.receipt}).catch(error=>{throw captureLaunchError(error);});
      if(alive.current && lease.current())close();
    } catch(error) { if(alive.current && lease.current())setError(captureUiError(error)); }
  }
  return (
    <Dialog
      title={recovery ? t("attachmentRestoreTitle",{value1:host.name}) : trust ? t("appVerifyThisHost") : t("appConnectToValue1", {value1: host.name})}
      close={() => {void cancel();}}
    >
      {trust ? (
        <div className="form-stack">
          <div className="host-key-icon">
            <ShieldCheck size={27} />
          </div>
          <p>{t("appThisIsYourFirstConnectionTo")}{" "}
            <strong>
              {trustHost.hostname}:{trustHost.port}
            </strong>{t("appCheckThisFingerprintAgainstTheServerThroughATrusted")}</p>
          <div className="fingerprint">
            <span>{t("appServerPublicKeySHA256")}</span>
            <code>{trust}</code>
          </div>
          <p className="muted">{t("appLazyshWillPinThisKeyAndRejectFutureConnections")}</p>
          {error && (
            <p className="inline-error" role="alert">
              {uiErrorText(error)}
            </p>
          )}
          <div className="dialog-actions">
            <button className="subtle-button" disabled={busy} onClick={()=>{void cancel();}}>{t("appCancel")}</button>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void connect(true)}
            >
              {busy ? t("appConnecting") : t("appTrustKeyAndConnect")}
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
          {!recovery && <label>{t("appTransport")}<select
              value={transport}
              disabled={busy || !!launch?.mux || !!defaultMultiplexer}
              onChange={(event) =>
                setTransport(event.target.value as TransportMode)
              }
            >
              <option value="auto">{t("appAutoMoshThenETThenSSH")}</option>
              <option value="ssh">SSH</option>
              <option value="mosh" disabled={!moshAvailable}>
                Mosh{!moshAvailable ? t("appUnavailableForThisConnection") : ""}
              </option>
              <option value="et" disabled={!etAvailable}>
                Eternal Terminal
                {!etAvailable ? t("appUnavailableForThisConnection") : ""}
              </option>
            </select>
          </label>}
          {launch?.mux && <p className="security-note">{t('desktopLaunchMuxSsh')}</p>}
          {defaultMultiplexer && <p className="security-note">{t('defaultMuxConnecting',{kind:defaultMultiplexer.kind,name:defaultMultiplexer.name})} {t('defaultMuxSsh')}</p>}
          {!recovery && <TransportOptions mode={transport} busy={busy}
            options={{mosh:{serverPath:moshServer,portMin:moshPortMin,portMax:moshPortMax},et:{serverPath:etServer,port:etPort}}}
            change={({mosh,et}) => {setMoshServer(mosh.serverPath);setMoshPortMin(mosh.portMin);setMoshPortMax(mosh.portMax);setEtServer(et.serverPath);setEtPort(et.port);}} />}
          {!recovery && host.jumpHostId && (
            <fieldset>
              <legend>{t("appBastion")}{" "}
                {hosts.find((item) => item.id === host.jumpHostId)?.name ||
                  host.jumpHostId}
              </legend>
              <label>
                <input
                  type="checkbox"
                  checked={savedJump}
                  onChange={(event) => setSavedJump(event.target.checked)}
                />{t("appUseBastionSSavedCredentials")}</label>
              {savedJump ? (
                <p>{t("appConnectToTheBastionDirectlyAndSaveItsCredentials")}</p>
              ) : (
                <label>{t("appBastionPassword")}<input
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
            aria-label={t("appAuthenticationMethod")}
          >
            <button
              type="button"
              aria-pressed={method === "password"}
              onClick={() => setMethod("password")}
            >{t("appPassword")}</button>
            <button
              type="button"
              aria-pressed={method === "key"}
              onClick={() => setMethod("key")}
            >{t("appPrivateKey")}</button>
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
                  />{t("appUseSavedCredentials")}</label>
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
              >{t("appForgetSavedCredentials")}</button>
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
              >{t("appExportPrivateKeyWithBiometrics")}</button>
              {exportedIdentity && (
                <>
                  <label>{t("appExportedPrivateKey")}<textarea
                      readOnly
                      autoComplete="off"
                      spellCheck={false}
                      value={exportedIdentity}
                    />
                  </label>
                  <button type="button" onClick={() => setExportedIdentity("")}>{t("appHideExportedKey")}</button>
                </>
              )}
            </div>
          )}
          {useSavedCredentials ? (
            <p>{t("appCredentialsWillBeReadFromThisDeviceSSecure")}</p>
          ) : method === "password" ? (
            <label>{t("appPassword")}<input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                required
              />
            </label>
          ) : (
            <>
              <label>{t("appPrivateKeyOpenSSHOrPEM")}<textarea
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  rows={7}
                  spellCheck={false}
                  autoComplete="off"
                  required
                  placeholder={t("appBEGINOPENSSHPRIVATEKEY")}
                />
              </label>
              <label>{t("appKeyPassphraseIfEncrypted")}<input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <details>
                <summary>{t("appGenerateOrInspectAnIdentity")}</summary>
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
            <KeyRound size={15} />{" "}{t("appCredentialsStayInMemoryUnlessYouChooseToSave")}</p>
          {!recovery && !useSavedCredentials && (
            <label>
              <input
                type="checkbox"
                checked={rememberCredentials}
                onChange={(event) =>
                  setRememberCredentials(event.target.checked)
                }
              />{t("appSaveCredentialsOnThisDeviceAfterConnecting")}</label>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {uiErrorText(error)}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="subtle-button" onClick={()=>{void cancel();}}>{t("appCancel")}</button>
            <button className="primary-button" disabled={busy || (transport === 'auto' && !capabilitiesReady)}>
              {busy ? t("appConnecting") : t(recovery ? "attachmentRestore" : "appConnect")}
              <ChevronRight size={16} />
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export default function App() {
  useUi();
  const locale=useClientLocale();
  return <div className="app-viewport">
    <NativeLocaleNotice state={locale} retry={()=>void nativeLocale.refresh().catch(()=>{})}/>
    <AccessShell native={native}>{registry => <WorkspaceApp registry={registry} />}</AccessShell>
  </div>;
}

function WorkspaceApp({ registry }: { registry: SessionRegistry }) {
  useUi();
  const invoke = useProtectedInvoke();
  const [lease] = useState(captureAccess);
  const api = useMemo(() => bindProtectedApi(nativeApi, lease), [lease]);
  useClientAppearance();
  const {sessionLayout} = usePreferences();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [localCapability, setLocalCapability] = useState({available:false,reason:t("appCheckingLocalTerminalSupport")});
  const [openingLocal, setOpeningLocal] = useState(false);
  const localOpening = useRef(false);
  const [appleUsage, setAppleUsage] = useState<Record<string,AppleUsageReport>>({});
  const [sessions, updateSessions] = useState<LiveSession[]>(() => registry.sessions);
  const [activeId, updateActiveId] = useState<string | null>(() => registry.activeId);
  function setSessions(value: LiveSession[] | ((current: LiveSession[]) => LiveSession[])) {
    registry.sessions = typeof value === 'function' ? value(registry.sessions) : value;
    updateSessions(registry.sessions);
  }
  function setActiveId(value: string | null) { registry.activeId = value; updateActiveId(value); }
  const [view, setView] = useState<View>("terminal");
  const [editor, setEditor] = useState<Host | "new" | null>(null);
  const [connectingHost, setConnectingHost] = useState<Host | null>(null);
  const [fileRecovery,setFileRecovery]=useState<{sessionId:string;host:Host;restored:()=>void}|null>(null);
  const [hostLaunch, setHostLaunch] = useState<DesktopHostLaunch>();
  const [muxLaunch, setMuxLaunch] = useState<DesktopMuxRequest>();
  const [deleting, setDeleting] = useState<Host | null>(null);
  const [error, setError] = useState<UiErrorCause>("");
  const [search, setSearch] = useState("");
  const [palette, setPalette] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [pushSettings, setPushSettings] = useState(false);
  const [preferences, setPreferences] = useState(false);
  const [themeLinkTarget,setThemeLinkTarget] = useState<HTMLDivElement|null>(null);
  const [sync, setSync] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [mobileTools, setMobileTools] = useState(false);
  const [about, setAbout] = useState(false);
  const [inbox, setInbox] = useState(false);
  const [previousWorkspace, setPreviousWorkspace] = useState(() => registry.sessions.length ? [] : readWorkspace());
  const [restoring, setRestoring] = useState(false);
  const restoringRef = useRef(false);
  const mounted = useRef(true);
  const restoringSessions = useRef(new PendingSessions());
  const [sidebar, setSidebar] = useState(false);
  const [wideSidebar,setWideSidebar]=useState(()=>typeof window.matchMedia==='function'?!window.matchMedia('(max-width: 600px)').matches:true);
  const [navigation,setNavigation]=useState<Record<string,{mode:NavigationMode;agents:boolean}>>({});
  const navigationOwner=useRef({sessionId:null as string|null,agents:false});
  const pickerOwner=useRef({source:'',visible:false,revision:0});
  const [pickerState,setPickerState]=useState<{owner:object;busy:boolean}>();
  const navigationRef=useRef<HTMLElement>(null),navigationTrigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    if(typeof window.matchMedia!=='function')return;
    const media=window.matchMedia('(max-width: 600px)');
    const changed=()=>setWideSidebar(!media.matches);changed();media.addEventListener('change',changed);
    return()=>media.removeEventListener('change',changed);
  },[]);
  useEffect(()=>{
    if(wideSidebar || !sidebar)return;
    navigationRef.current?.querySelector<HTMLButtonElement>('.sidebar-close')?.focus();
    const keydown=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setSidebar(false);}
      else cycleFocus(event,focusableWithin(navigationRef.current));
    };
    const node=navigationRef.current;node?.addEventListener('keydown',keydown);
    return()=>{node?.removeEventListener('keydown',keydown);if(window.matchMedia?.('(max-width: 600px)').matches)navigationTrigger.current?.focus();};
  },[sidebar,wideSidebar]);
  const [loaded, setLoaded] = useState(!native);
  useEffect(()=>{
    const live=new Set(sessions.filter(session=>session.connected).map(session=>session.id));
    setNavigation(previous=>Object.keys(previous).every(id=>id==='' || live.has(id))?previous:Object.fromEntries(Object.entries(previous).filter(([id])=>id==='' || live.has(id))));
  },[sessions]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [reportedHistory,setReportedHistory]=useState<ReportedHistorySource>();
  const currentView = useRef({activeId,view});
  currentView.current = {activeId,view};
  const closingSessions=useRef(new Set<string>());
  const [closingIds,setClosingIds]=useState<string[]>([]);
  useEffect(()=>{
    setReportedHistory(source=>source && (source.sessionId!==activeId || view!=='chat' || !source.lease.current())?undefined:source);
  },[activeId,view]);
  function openReportedHistory(source:ReportedHistorySource) {
    if(!mounted.current || !source.lease.current() || currentView.current.activeId!==source.sessionId || !navigationOwner.current.agents
      || !sessionsRef.current.some(session=>session.id===source.sessionId && session.connected && !session.local))return;
    setReportedHistory(source);setView('chat');setSidebar(false);
  }
  const directContext = useRef({sessionId:activeId,generation:0});
  if(directContext.current.sessionId!==activeId)
    directContext.current={sessionId:activeId,generation:directContext.current.generation+1};
  const directGeneration=directContext.current.generation;
  const directBlocked=closingSessions.current.has(activeId ?? "");
  function deliverDictation(request: DirectDictation): Promise<void> {
    const data = dictationInput(request.text,request.autoSend);
    const live = sessionsRef.current.find(session=>session.id===request.sessionId && session.connected);
    if (!mounted.current || !live || currentView.current.activeId!==request.sessionId
      || currentView.current.view!=='voice' || document.visibilityState!=='visible'
      || directBlocked || closingSessions.current.has(request.sessionId)
      || directContext.current.generation!==directGeneration || !request.claim())
      return Promise.reject(new LocalUiError("appDirectDictationCancelledBecauseThisSessionIsNoLonger"));
    return api.write(live.id,data);
  }
  function pasteAttachmentPath(request:AttachmentPathPaste):Promise<void>{
    const live=sessionsRef.current.find(session=>session.id===request.sessionId&&session.connected&&!session.disposed);
    if(!mounted.current||!lease.current()||!live||live!==active||currentView.current.activeId!==request.sessionId
      ||currentView.current.view!=='attachments'||document.visibilityState!=='visible'||closingSessions.current.has(request.sessionId))
      return Promise.reject(new LocalUiError('attachmentPasteUnavailable'));
    const data=attachmentTerminalInput(request.path,live.terminal.modes.bracketedPasteMode,live.terminal.options.ignoreBracketedPasteMode);
    if(!request.claim())return Promise.reject(new LocalUiError('attachmentPasteUnavailable'));
    return api.write(live.id,data);
  }
  const active = sessions.find((session) => session.id === activeId);
  const accountUsage=useAccountUsage(active?.connected ? active.id : null);
  const navigationEntry=navigation[activeId??'']??{mode:'connections' as const,agents:false};
  const pendingMuxRequest=view==='sessions' && muxLaunch?.sessionId===activeId;
  const compactTerminal=!!active && !wideSidebar && view==='terminal';
  const sessionViews=active ? views().filter(({id})=>!active.local || id==='terminal' || id==='voice' || id==='usage') : [];
  const sidebarShown=wideSidebar || sidebar;
  const navigationCovered=!!fileRecovery || !!editor || !!connectingHost || !!deleting || palette || switcher || pushSettings || preferences || sync || sharing || mobileTools || about || inbox;
  const remoteActive=!!active?.connected && !active.local;
  const agentsVisible=sidebarShown && !navigationCovered && remoteActive && navigationEntry.mode==='agents';
  navigationOwner.current={sessionId:activeId,agents:agentsVisible};
  const pickerVisible=sidebarShown && !navigationCovered && remoteActive && navigationEntry.mode==='workspaces' && active?.attached?.kind==='tmux' && view!=='sessions';
  if(pickerOwner.current.source!==(activeId??'') || pickerOwner.current.visible!==pickerVisible)
    pickerOwner.current={source:activeId??'',visible:pickerVisible,revision:pickerOwner.current.revision+1};
  const currentPickerOwner=pickerOwner.current;
  const pickerInFlight=pickerVisible && (pickerState?.owner!==currentPickerOwner || pickerState.busy);
  function showNavigation(mode:NavigationMode) {
    if(mode!=='connections' && pendingMuxRequest)return;
    if(mode==='agents' && !remoteActive)return;
    const id=activeId??'';
    setNavigation(previous=>({...previous,[id]:{mode,agents:mode==='agents'||previous[id]?.agents===true}}));
    if(mode!=='connections')setView('terminal');
    setSidebar(true);
  }
  function chooseLiveSession(id:string) {
    if(pendingMuxRequest || !sessionsRef.current.some(session=>session.id===id && session.connected))return;
    setActiveId(id);setView('terminal');setSidebar(false);
  }
  function tmuxJumped(sessionId: string, snapshot: import('./bridge').TmuxJumpSnapshot) {
    if (!mounted.current || currentView.current.activeId !== sessionId) return;
    const session = sessionsRef.current.find(item => item.id === sessionId && item.connected && item.attached?.kind === 'tmux');
    const destination = snapshot.sessions.find(item => item.id === snapshot.current.sessionId);
    if (!session?.attached || !destination) return;
    const suffix = ` / ${session.attached.name}`;
    if (session.name.endsWith(suffix)) session.name = `${session.name.slice(0, -suffix.length)} / ${destination.name}`;
    session.attached = {...session.attached, kind:'tmux', name:destination.name, restoreName:destination.restoreName};
    persistWorkspace(sessionsRef.current);
    setSessions([...sessionsRef.current]);
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void restoringSessions.current.closeAll().catch(()=>{});
      restoringSessions.current.clear();
    };
  }, []);

  useEffect(()=>{
    let alive=true;
    if(native) void invoke<{available:boolean;reason:string}>('local_capability').then(value=>{
      if(alive && value && typeof value.available==='boolean') setLocalCapability(value);
    }).catch(()=>{if(alive)setLocalCapability({available:false,reason:t("appLocalTerminalCapabilityIsUnavailable")});});
    else setLocalCapability({available:false,reason:t("appLocalTerminalsRequireTheNativeDesktopApp")});
    return()=>{alive=false;};
  },[]);
  useEffect(()=>{if(active?.local && view!=='terminal' && view!=='voice' && view!=='usage')setView('terminal');},[active?.id,active?.local,view]);
  const launchBusy=!!fileRecovery || openingLocal || !!connectingHost || !!editor || !!deleting || palette || switcher || pickerInFlight || (!wideSidebar && sidebar)
    || pushSettings || preferences || sync || sharing || mobileTools || about || inbox || restoring
    || (view==='sessions' && muxLaunch?.sessionId===activeId);
  useDesktopLaunch(native,localCapability.available,launchBusy,
    receipt=>openLocalTerminal(receipt),setError,async launch=>{
      launch.lease.assert();
      setHostLaunch(launch);setConnectingHost(launch.hosts[0]);setPalette(false);setSidebar(false);
    });
  async function openLocalTerminal(launchReceipt?:string) {
    if(localOpening.current || !localCapability.available)return;
    localOpening.current=true;setOpeningLocal(true);setError('');
    let pending:Prepared|undefined;
    const ownership = new PendingSessions();
    try {
      pending=await prepareSession('', t("appLocalTerminal"), t("appThisDeviceLocalShell"),lease);
      pending.session.local=true;
      const result=await (launchReceipt ? api.connectLocal(pending.onEvent,launchReceipt).catch(error=>{throw captureLaunchError(error);}) : api.connectLocal(pending.onEvent));
      pending.establish(result.sessionId);
      ownership.add(result.sessionId);
      if(!mounted.current){await ownership.close(result.sessionId);disposeTerminal(pending.session);return;}
      sessionConnected(pending.session);setPalette(false);setSidebar(false);
      ownership.delete(result.sessionId);
    }catch(error){
      await ownership.closeAll().catch(()=>{});
      disposeTerminal(pending?.session);
      if(mounted.current)setError(launchReceipt ? captureUiError(error) : errorMessage(error));
    }finally{localOpening.current=false;if(mounted.current)setOpeningLocal(false);}
  }

  function persistWorkspace(next: SessionIntent[]) {
    try {
      saveWorkspace(next);
    } catch {
      setError(t("appWorkspaceRestorationCouldNotBeSavedOnThisDevice"));
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
      if (!mounted.current) break;
      if(intent.local) {
        let pending:Prepared|undefined;
        try {
          if(!localCapability.available)throw new Error(localCapability.reason);
          pending=await prepareSession('', t("appLocalTerminal"), t("appThisDeviceLocalShell"),lease);pending.session.local=true;
          const result=await api.connectLocal(pending.onEvent);pending.establish(result.sessionId);
          restoringSessions.current.add(result.sessionId);
          if(!mounted.current)throw new Error(t("appLocalRestorationCancelled"));
          restored.push(pending.session);
        }catch(error){
          if(pending?.session.id){await restoringSessions.current.close(pending.session.id).catch(()=>{});}
          disposeTerminal(pending?.session);remaining.push(intent);failures.push(t("appLocalFailure", {details:errorMessage(error)}));
        }
        continue;
      }
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
          lease,
        );
        const connected = await api.connect(host.id, {}, shell.onEvent, {
          useSavedCredentials: true,
        });
        shell.establish(connected.sessionId);
        restoringSessions.current.add(connected.sessionId);
        if (!mounted.current) throw {kind:'cancelled',message:t("appWorkspaceRestorationCancelled")};
        if (intent.auto || intent.et || intent.mosh) {
          const capabilities = await invoke<{mosh:boolean;et:boolean}>('transport_capabilities').catch(()=>({mosh:false,et:false,reason:t("appTransportCapabilityCheckFailed")}));
          child = await selectTransport(shell, host, intent.auto ? 'auto' : intent.et ? 'et' : 'mosh',
            intent.auto ?? {mosh:intent.mosh ?? defaultMosh,et:intent.et ?? defaultEt}, capabilities, lease, ()=>mounted.current && lease.current(),
            id=>restoringSessions.current.add(id),id=>restoringSessions.current.delete(id));
          restored.push(child.session);
        } else if (intent.attached) {
          child = await prepareSession(
            host.id,
            `${host.name} / ${intent.attached.name}`,
            shell.session.destination,
            lease,
          );
          const attached =
            intent.attached.kind === "tmux"
              ? await api.attachTmux(
                  shell.session.id,
                  intent.attached.name,
                  child.onEvent,
                  intent.attached.tmuxServer,
                )
              : await api.attachMultiplexer(
                  shell.session.id,
                  intent.attached.kind,
                  intent.attached.name,
                  child.onEvent,
                );
          child.establish(attached.sessionId);
          restoringSessions.current.add(attached.sessionId);
          if (!mounted.current) throw {kind:'cancelled',message:t("appWorkspaceRestorationCancelled")};
          child.session.attached = intent.attached;
          await restoringSessions.current.close(shell.session.id);
          restoringSessions.current.delete(shell.session.id);
          disposeTerminal(shell.session);
          restored.push(child.session);
        } else restored.push(shell.session);
      } catch (error) {
        for (const pending of [child, shell])
          if (pending) {
            if (pending.session.id)
              await restoringSessions.current.close(pending.session.id).catch(() => {});
            restoringSessions.current.delete(pending.session.id);
            disposeTerminal(pending.session);
          }
        remaining.push(intent);
        failures.push(`${host.name}: ${errorMessage(error)}`);
      }
    }
    if (!mounted.current) {
      for (const pending of restored) {
        await restoringSessions.current.close(pending.id).catch(()=>{});
        disposeTerminal(pending);
      }
      restoringSessions.current.clear();
      return;
    }
    restoringSessions.current.clear();
    const next = [...sessionsRef.current, ...restored];
    setSessions(next);
    for (const session of restored) adoptRetained(session);
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
          (session) => session.id === detail.sessionId && session.connected && !session.local,
        )
      )
        return;
      const target=detail.sessionId;
      setActiveId(target);
      setNavigation(previous=>({...previous,[target]:{mode:'agents',agents:true}}));
      setView('terminal');setSidebar(true);
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
    const displayError = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      setError(detail instanceof LocalUiError ? detail : String(detail));
    };
    window.addEventListener("lazysh-session-change", rerender);
    window.addEventListener("lazysh-error", displayError);
    return () => {
      window.removeEventListener("lazysh-session-change", rerender);
      window.removeEventListener("lazysh-error", displayError);
    };
  }, []);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const shortcut = appShortcut(event);
      if (!shortcut) return;
      if (shortcut.action === 'session') {
        const target = sessionsRef.current[shortcut.index];
        if (!target) return;
        setActiveId(target.id);
      } else if (shortcut.action === 'palette') setPalette(true);
      else if (shortcut.action === 'switcher') setSwitcher(true);
      else if (shortcut.action === 'newConnection') {
        if (!native) return;
        if (hosts.length) setPalette(true); else setEditor('new');
      } else {
        const current = sessionsRef.current.find(session=>session.id===activeId);
        if (!current) return;
        void closeSession(current);
      }
      event.preventDefault();
    };
    const terminalAction = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== 'object' || !('sessionId' in detail) || !('action' in detail)
        || detail.sessionId !== activeId || (detail.action !== 'nextSession' && detail.action !== 'previousSession')) return;
      const current = sessionsRef.current.findIndex(session=>session.id===activeId && session.connected);
      if (current < 0 || !sessionsRef.current.length) return;
      const offset = detail.action === 'nextSession' ? 1 : -1;
      setActiveId(sessionsRef.current[(current+offset+sessionsRef.current.length)%sessionsRef.current.length].id);
      setView('terminal');
    };
    window.addEventListener("keydown", keyboard);
    window.addEventListener('lazysh-terminal-action', terminalAction);
    return () => {
      window.removeEventListener("keydown", keyboard);
      window.removeEventListener('lazysh-terminal-action', terminalAction);
    };
  }, [activeId, hosts.length]);

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
    if(closingSessions.current.has(session.id))return;
    closingSessions.current.add(session.id);
    setClosingIds([...closingSessions.current]);
    const context=directContext.current;
    if(context.sessionId===session.id)context.generation++;
    try {
      await api.disconnect(session.id);
      session.connected=false;
      disposeTerminal(session);
      setAppleUsage(previous=>{const next={...previous};delete next[session.id];return next;});
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
    } finally {
      closingSessions.current.delete(session.id);
      if(mounted.current)setClosingIds([...closingSessions.current]);
    }
  }
  function chooseHost(host: Host) {
    setHostLaunch(undefined);
    setConnectingHost(host);
    setPalette(false);
    setSidebar(false);
  }
  function sessionConnected(session: LiveSession, launch?:DesktopHostLaunch) {
    launch?.lease.assert();
    persistWorkspace([...sessionsRef.current, session]);
    setSessions((previous) => [...previous, session]);
    adoptRetained(session);
    setActiveId(session.id);
    if(launch?.mux)setMuxLaunch(Object.freeze({sessionId:session.id,lease:launch.lease,mux:launch.mux}));
    setView(launch?.mux ? "sessions" : "terminal");
    setConnectingHost(null);setHostLaunch(undefined);
    if(!session.local)void loadHosts();
  }
  function adoptRetained(session: LiveSession) {
    // The persistent registry owns the terminal before native adoption can succeed or become stale.
    retainSession(session.id);
    void api.adoptSession(session.id).catch(() => {
      // Native revokes pending sessions itself. Never tear down an already-adopted terminal on a stale acknowledgement.
      if (mounted.current) setError(t("appCouldNotConfirmTheConnectionCheckThisTerminalBefore"));
    });
  }
  async function attachTmux(
    source: LiveSession,
    name: string,
    kind: "tmux" | "herdr" | "zellij" = "tmux",
    tmuxServer?: string,
    owner:AccessLease=lease,
  ) {
    const sourceApi=bindProtectedApi(nativeApi,owner);
    const pending = await prepareSession(
      source.hostId,
      `${source.name} / ${name}`,
      source.destination,
      owner,
    );
    const ownership = new PendingSessions();
    try {
      const result =
        kind === "tmux"
          ? await sourceApi.attachTmux(source.id, name, pending.onEvent, tmuxServer)
          : await sourceApi.attachMultiplexer(source.id, kind, name, pending.onEvent);
      pending.establish(result.sessionId);
      ownership.add(result.sessionId);
      pending.session.attached = { kind, name, ...(tmuxServer === undefined ? {} : {tmuxServer}) };
      owner.assert();
      sessionConnected(pending.session);
      ownership.delete(result.sessionId);
    } catch (error) {
      await ownership.closeAll().catch(()=>{});
      disposeTerminal(pending.session);
      throw error;
    }
  }
  const shownHosts = hosts.filter((host) =>
    `${host.name} ${host.hostname} ${host.username}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );

  const workspaceRestoreControls = <>
    <button
      disabled={restoring || !loaded}
      onClick={() => {setMobileTools(false);void restoreWorkspace();}}
    >
      {restoring ? t("appRestoring") : t("appRestorePreviousWorkspace")}
    </button>
    <span>{t("appUsesSavedCredentialsTmuxAndHerdrReattachOpenZellij")}</span>
    <button
      disabled={restoring}
      onClick={() => {
        setPreviousWorkspace([]);
        persistWorkspace(sessionsRef.current);
      }}
    >{t("appDismiss")}</button>
  </>;
  return (
    <div className="app-shell">
      <aside
        ref={navigationRef}
        data-navigation={navigationEntry.mode}
        className={`sidebar ${sidebar ? "sidebar-open" : ""}`}
        aria-label={t("appHostsAndConnections")}
      >
        <div className="brand">
          <img className="brand-mark" src={bedModeMark} alt="" aria-hidden="true" width={35} height={35}/>
          <span>
            lazysh<small>{t("appYourAgentsWithinReach")}</small>
          </span>
          <button
            className="icon-button sidebar-close"
            aria-label={t("appCloseHosts")}
            onClick={() => setSidebar(false)}
          >
            <X size={18} />
          </button>
        </div>
        <nav className="workspace-navigation-modes" aria-label={t('navigationTitle')}>
          {(['connections','workspaces','agents'] as const).map(mode=><button key={mode} className="subtle-button" aria-current={navigationEntry.mode===mode?'page':undefined} aria-label={mode==='agents'?t('navigationAgents'):undefined} disabled={(mode!=='connections' && pendingMuxRequest) || (mode==='agents' && !remoteActive)} onClick={()=>showNavigation(mode)}>{t(mode==='connections'?'navigationConnections':mode==='workspaces'?'navigationWorkspaces':'appAgents')}</button>)}
        </nav>
        <div className="navigation-connections" hidden={navigationEntry.mode!=='connections'}>
        <button className="search-button" onClick={() => setPalette(true)}>
          <Search size={15} />
          <span>{t("appJumpToAHost")}</span>
          <kbd>{t("appK")}</kbd>
        </button>
        <button className="search-button" disabled={!localCapability.available || openingLocal}
          title={localCapability.reason} onClick={()=>void openLocalTerminal()}>
          <TerminalSquare size={15}/><span>{openingLocal?t("appOpeningLocalTerminal"):t("appOpenLocalTerminal")}</span>
        </button>
        <div className="sidebar-heading">
          <span>{t("appHOSTS")}</span>
          <button
            className="icon-button"
            aria-label={t("appAddHost")}
            disabled={!native}
            onClick={() => setEditor("new")}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="host-list">
          {!loaded ? (
            <p className="sidebar-hint">{t("appLoadingHosts")}</p>
          ) : hosts.length === 0 ? (
            <p className="sidebar-hint">{t("appYourMachinesLiveHere")}<br />{t("appAddAHostToGetStarted")}</p>
          ) : (
            hosts.map((host) => (
              <div
                className={`host-item ${active?.hostId === host.id ? "host-active" : ""}`}
                key={host.id}
              >
                <button
                  className="host-connect"
                  aria-label={t("appConnectToValue1", {value1: host.name})}
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
                  ) && <span className="status-dot" aria-label={t("appConnected")} />}
                </button>
                <div className="host-actions">
                  <button
                    className="icon-button"
                    aria-label={t("appEditValue1", {value1: host.name})}
                    onClick={() => setEditor(host)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={t("appDeleteValue1", {value1: host.name})}
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
          <Plus size={16} />{" "}{t("appAddAHost")}</button>
        </div>
        {navigationEntry.mode==='workspaces' && <div className="workspace-navigation-content">
          <h3>{t('navigationLiveSessions')}</h3>
          <div className="workspace-live-sessions" role="group" aria-label={t('navigationLiveSessions')}>
            {sessions.filter(session=>session.connected).map(session=><button className="subtle-button" key={session.id} aria-current={activeId===session.id?'location':undefined} disabled={pendingMuxRequest} onClick={()=>chooseLiveSession(session.id)}><strong>{session.name}</strong><small>{session.destination}</small></button>)}
            {!sessions.some(session=>session.connected) && <p>{t('navigationNoSessions')}</p>}
          </div>
          {remoteActive && <>
            <button className="subtle-button" disabled={pendingMuxRequest} onClick={()=>{setView('sessions');setSidebar(false);}}>{t('navigationManageSessions')}</button>
            {active?.attached?.kind!=='tmux' && <p className="muted">{t('navigationManagerHint')}</p>}
            {view==='sessions' && <p role="status">{t('navigationManagerOpen')}</p>}
          </>}
          {pickerVisible && active && <Suspense fallback={<p role="status">{t('appReadingTmuxDestinations')}</p>}><TmuxJumpPanel key={active.id} sessionId={active.id} onClose={()=>{if(!wideSidebar)setSidebar(false);}} onJump={snapshot=>tmuxJumped(active.id,snapshot)} onBusyChange={busy=>{
            if(mounted.current && pickerOwner.current===currentPickerOwner)setPickerState({owner:currentPickerOwner,busy});
          }}/></Suspense>}
        </div>}
        {active?.connected && !active.local && navigationEntry.agents && <div className="workspace-navigation-agents" hidden={!agentsVisible}>
          <AgentPanel key={active.id} sessionId={active.id} visible={agentsVisible} onUseReportedHistory={openReportedHistory}/>
        </div>}
        <div className="sidebar-bottom">
          <div>
            <ShieldCheck size={15} />
            <span>{t("appDirectConnectionLocalFirst")}</span>
          </div>
          <button
            className="about-button"
            onClick={() => {
              setAbout(true);
              setSidebar(false);
            }}
          >{t("appAboutLazyshVersion", {version: appVersion})}</button>
        </div>
      </aside>
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label={t("appCloseHostMenu")}
          onClick={() => setSidebar(false)}
        />
      )}
      <main className={`workspace${compactTerminal ? " workspace-terminal-focus" : ""}`} data-single-session={sessions.length===1} inert={!wideSidebar && sidebar}>
        {native && <ThemeLinkPanel target={themeLinkTarget} />}
        <header className="workspace-header">
          <button
            ref={navigationTrigger}
            className="icon-button mobile-menu"
            aria-label={t("appOpenHosts")}
            onClick={() => setSidebar(true)}
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumb">
            <span>{t("appWorkspace")}</span>
            {active && (
              <>
                <ChevronRight size={13} />
                <button className="session-switcher-trigger" title={active.name} aria-label={t("appSwitchTerminalSession")} onClick={() => setSwitcher(true)}>{active.name}</button>
              </>
            )}
          </div>
          <div className="header-right">
            <button
              className="icon-button mobile-tools"
              aria-label={t("appWorkspaceTools")}
              onClick={() => setMobileTools(true)}
            >
              <Ellipsis size={18} />
            </button>
            <button
              className="icon-button"
              aria-label={t("appShareableUploads")}
              disabled={!native}
              onClick={() => setSharing(true)}
            >
              <Share2 size={16} />
            </button>
            <button
              className="icon-button"
              aria-label={t("appNotificationInbox")}
              disabled={!native}
              onClick={() => setInbox(true)}
            >
              <Bell size={16} />
            </button>
            <button
              className="icon-button"
              aria-label={t("appEncryptedSync")}
              disabled={!native}
              onClick={() => setSync(true)}
            >
              <Cloud size={16} />
            </button>
            <button
              className="icon-button preferences-button"
              aria-label={t("appPreferences")}
              onClick={() => setPreferences(true)}
            >
              <Settings size={16} />
            </button>
            <span className="connection-label">
              <span
                className={`status-dot ${active?.connected ? "" : "status-idle"}`}
              />
              {active?.connected
                ? active.local ? t("appLocalTerminal") : active.mosh
                  ? t("appMoshConnected")
                  : active.et
                    ? t("appETConnected")
                    : t("appSSHConnected")
                : t("appNoActiveConnection")}
            </span>
            <button
              className="icon-button"
              aria-label={t("appSearchHosts")}
              onClick={() => setPalette(true)}
            >
              <Command size={16} />
            </button>
          </div>
        </header>
        {!native && (
          <div className="browser-banner" role="status">{t("appBrowserPreviewSSHConnectionsRequireTheNativeLazyshApp")}{" "}
            <code>bun run dev</code>{" "}{t("appToConnect")}</div>
        )}
        {native && previousWorkspace.length > 0 && (
          <div className="browser-banner workspace-restore">{workspaceRestoreControls}</div>
        )}
        {error && (
          <div className="global-error" role="alert">
            <span>{uiErrorText(error)}</span>
            <button
              className="icon-button"
              aria-label={t("appDismissError")}
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {active?.transportNotice && <div className="browser-banner" role="status">{active.transportNotice}</div>}
        {sessions.length > 0 && (
          <div
            className="session-tabs"
            role="tablist"
            aria-label={t("appTerminalConnections")}
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
                  aria-label={t("appDisconnectValue1", {value1: session.name})}
                  disabled={closingIds.includes(session.id)}
                  onClick={() => void closeSession(session)}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <button
              className="icon-button"
              aria-label={t("appNewConnection")}
              onClick={() => setPalette(true)}
            >
              <Plus size={16} />
            </button>
          </div>
        )}
        {active ? (
          <>
            <div className="session-toolbar">
              <nav className="view-tabs" aria-label={t("appSessionViews")}>
                {sessionViews.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    aria-current={(id==='agents'?agentsVisible:view===id) ? "page" : undefined}
                    disabled={id==='agents' && pendingMuxRequest}
                    onClick={() => id==='agents'?showNavigation('agents'):setView(id)}
                  >
                    <Icon size={15} />
                    <span>{label}</span>
                  </button>
                ))}
              </nav>
              {active.connected && !active.local && active.attached?.kind === 'tmux' && <button className="subtle-button" onClick={() => showNavigation('workspaces')}>{t("appJumpTo")}</button>}
              <button
                className="icon-button disconnect-button"
                aria-label={t("appEndValue1Connection", {value1: active.name})}
                disabled={closingIds.includes(active.id)}
                onClick={() => void closeSession(active)}
              >
                <Unplug size={16} />
              </button>
            </div>
            {active.local && <p className="security-note">{t("appLocalShellOnThisDeviceSSHHostToolsRemote")}</p>}
            {active.attached?.restoreName === null && <p className="security-note" role="status">{t("appUnsupportedTmuxRestoreName")}</p>}
            <div className="session-body">
              <Suspense
                fallback={
                  <p className="loading" role="status">{t("appOpeningTerminal")}</p>
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
                {active.connected && view === "usage" && (
                  <>
                  <AccountUsageDetails model={accountUsage}/>
                  {!active.local && <UsagePanel key={active.id} sessionId={active.id} onShareAppleUsage={report=>setAppleUsage(previous=>({...previous,[active.id]:report}))} />}
                  </>
                )}
                {active.connected && !active.local && view === "chat" && (
                  <ChatPanel
                    key={active.id}
                    sessionId={active.id}
                    onOpenTerminal={() => setView("terminal")}
                    reportedHistory={reportedHistory?.sessionId===active.id ? reportedHistory : undefined}
                    terminalInput={native && (active.attached?.kind==='tmux' || active.attached?.kind==='herdr') ? {backend:active.attached.kind,hostLabel:active.destination,terminalLabel:active.name}:undefined}
                  />
                )}
                {active.connected && !active.local && view === "preview" && (
                  <PreviewPanel key={active.id} sessionId={active.id} />
                )}
                {active.connected && !active.local && view === "attachments" && (
                  <AttachmentPanel key={active.id} sessionId={active.id} onPastePath={pasteAttachmentPath} onRestoreFileTransfer={active.mosh && hosts.some(host=>host.id===active.hostId) ? restored=>{const host=hosts.find(host=>host.id===active.hostId);if(host)setFileRecovery({sessionId:active.id,host,restored});}:undefined} />
                )}
                {active.connected && view === "voice" && (
                  <VoicePanel key={active.id} sessionId={active.id} onDirectDictation={deliverDictation} />
                )}
                {active.connected && !active.local && view === "devices" && (
                  <DevicePanel key={active.id} sessionId={active.id} />
                )}
                {active.connected && !active.local && view === "files" && (
                  <FilesPanel key={active.id} sessionId={active.id} />
                )}
                {active.connected && !active.local && view === "diff" && (
                  <RepositoryPanel key={active.id} sessionId={active.id} />
                )}
                {active.connected && !active.local && <div hidden={view!=='apple'}><AppleStatusPanel key={active.id} sessionId={active.id} usage={appleUsage[active.id] ?? null} onReview={()=>showNavigation('agents')} /></div>}
                {active.connected && !active.local && view === "sessions" && (
                  <MuxPanel
                    key={active.id}
                    sessionId={active.id}
                    attached={active.attached}
                    requested={muxLaunch?.sessionId===active.id ? muxLaunch : undefined}
                    onAttach={(name, kind, server) => attachTmux(active, name, kind, server,
                      muxLaunch?.sessionId===active.id ? muxLaunch.lease : lease)}
                  />
                )}
                {!active.connected && view !== "terminal" && (
                  <div className="panel-empty">
                    <Unplug size={28} />
                    <h3>{t("appThisConnectionHasEnded")}</h3>
                    <p>{t("appConnectAgainFromHostsToReadLiveData")}</p>
                  </div>
                )}
              </Suspense>
            </div>
            <footer className="workspace-footer">
              {active.connected && <AccountUsageBar model={accountUsage} onOpen={()=>{setView('usage');setSidebar(false);}}/>}
              <span>
                {active.local ? <TerminalSquare size={12}/> : <ShieldCheck size={12} />}
                {active.destination}
              </span>
              <span>
                {active.connected ? active.local ? t("appLocalPTY") : active.mosh ? "Mosh" : active.et ? "ET" : "SSH" : t("appDisconnected")}
                <i />{t("appUTF8")}<i />{t("appXterm256color")}</span>
            </footer>
          </>
        ) : (
          <div className="welcome">
            <div className="welcome-content">
              <img className="welcome-brand-mark" src={bedModeMark} alt="lazysh" width={112} height={112}/>
              <p className="welcome-kicker">{t("appALittleCloserToYourMachines")}</p>
              <h1>{t("appGoodWorkDoesnT")}<br />{t("appNeedADesk")}</h1>
              <p className="welcome-copy">{t("appYourTerminalYourAgentsYourOwnInfrastructure")}<br />{t("appConnectOverSSHAndPickUpWhereYouLeft")}</p>
              <button
                className="primary-button welcome-connect"
                disabled={!native}
                onClick={() =>
                  hosts.length ? setPalette(true) : setEditor("new")
                }
              >
                <Plus size={17} />
                {hosts.length ? t("appConnectToAHost") : t("appAddYourFirstHost")}
                <ChevronRight size={16} />
              </button>
              <div className="welcome-features">
                <span>
                  <TerminalSquare size={16} />{t("appARealTerminal")}</span>
                <span>
                  <Bot size={16} />{t("appBuiltForAgents")}</span>
                <span>
                  <ShieldCheck size={16} />{t("appNoSessionRelay")}</span>
              </div>
            </div>
            <div className="welcome-bottom">
              <span>{t("appWorksWithTheToolsYouAlreadyUse")}</span>
              <div>{t("appClaudeCode")}{" "}<i />{" "}{t("appCodex")}{" "}<i />{" "}{t("appOpenCode")}{" "}<i />{" "}{t("appTmux")}</div>
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
      {fileRecovery && <ConnectDialog key={`file-recovery-${fileRecovery.sessionId}`} host={fileRecovery.host} hosts={hosts} connected={()=>{}} recovery={{sessionId:fileRecovery.sessionId,restored:()=>{fileRecovery.restored();setFileRecovery(null);}}} close={()=>setFileRecovery(null)} />}
      {connectingHost && (
        <ConnectDialog
          key={connectingHost.id}
          hosts={hostLaunch ? [...hostLaunch.hosts] : hosts}
          host={connectingHost}
          launch={hostLaunch}
          connected={session=>sessionConnected(session,hostLaunch)}
          close={() => {setConnectingHost(null);setHostLaunch(undefined);}}
        />
      )}
      {deleting && (
        <Dialog title={t("appDeleteHost")} close={() => setDeleting(null)}>
          <div className="form-stack">
            <p>{t("appRemove")}{" "}<strong>{deleting.name}</strong>{" "}{t("appAndItsPinnedHostKeyFromLazyshNothingOn")}</p>
            <div className="dialog-actions">
              <button
                className="subtle-button"
                onClick={() => setDeleting(null)}
              >{t("appCancel")}</button>
              <button
                className="danger-button"
                onClick={() => void deleteHost()}
              >{t("appDeleteHost")}</button>
            </div>
          </div>
        </Dialog>
      )}
      {palette && (
        <Dialog
          title={t("appJumpToAHost")}
          close={() => {
            setPalette(false);
            setSearch("");
          }}
        >
          <div className="palette-search">
            <Search size={18} />
            <input
              aria-label={t("appSearchSavedHosts")}
              placeholder={t("appSearchHostsOrAddresses")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>
          <div className="palette-list">
            <button disabled={!localCapability.available || openingLocal} title={localCapability.reason} onClick={()=>void openLocalTerminal()}><TerminalSquare size={18}/><span>{t("appLocalTerminalThisDevice")}</span></button>
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
                  ? t("appNoMatchingHostsAddOneToStartAConnection")
                  : t("appOpenTheNativeAppToManageSSHHosts")}
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
            <Plus size={16} />{" "}{t("appAddANewHost")}</button>
        </Dialog>
      )}
      {preferences && (
        <Dialog title={t("appPreferences")} close={() => setPreferences(false)}>
          <div className="preferences-content">
          <div ref={setThemeLinkTarget} />
          {native && <section aria-label={t('defaultMuxLabel')}>
            <h3>{t('defaultMuxLabel')}</h3>
            <p>{t('defaultMuxPreferencesHint')}</p>
            {hosts.map(host => <button type="button" key={host.id} onClick={()=>{setPreferences(false);setEditor(host);}}>{t('appEditValue1',{value1:host.name})}</button>)}
            {!hosts.length && <button type="button" onClick={()=>{setPreferences(false);setEditor('new');}}>{t('appAddHost')}</button>}
          </section>}
          <PreferencesPanel />
          <AccessPanel />
          <button type="button" onClick={()=>{setPreferences(false);setPushSettings(true);}}>{t("appRemotePushSettings")}</button>
          </div>
        </Dialog>
      )}
      {pushSettings && <Dialog title={t("appRemotePushSettings")} close={()=>setPushSettings(false)}>
        <Suspense fallback={<p>{t("appLoadingPushSettings")}</p>}><PushSettingsPanel /></Suspense>
      </Dialog>}

      {switcher && <Dialog title={t("appSwitchTerminalSession")} close={()=>setSwitcher(false)}>
        <div className="session-switcher" data-layout={sessionLayout}>
          {sessions.map(session=><button className="session-choice" key={session.id} type="button" aria-current={session.id === activeId ? "true" : undefined} onClick={()=>{setActiveId(session.id);setSwitcher(false);setView('terminal');}}><span className="session-choice-name">{session.name}</span><span className="session-choice-destination">{session.destination}</span></button>)}
          <p>{t("sessionCount", {count: sessions.length})}</p>
          {!sessions.length && <p>{t("appNoTerminalSessionsAreOpen")}</p>}
        </div>
      </Dialog>}
      {native && <NotificationMonitor sessions={sessions.filter(session=>!session.local)} />}
      {inbox && (
        <Dialog title={t("appNotificationInbox")} close={() => setInbox(false)}>
          <NotificationPanel sessions={sessions.filter(session=>!session.local)} />
        </Dialog>
      )}
      {about && (
        <Dialog title={t("appAboutLazysh")} close={() => setAbout(false)}>
          <Suspense fallback={<p>{t("appLoadingLicense")}</p>}>
            <AboutPanel />
          </Suspense>
        </Dialog>
      )}
      {mobileTools && (
        <Dialog title={t("appWorkspaceTools")} close={() => setMobileTools(false)}>
          <div className="form-stack">
            {active && <>
              <nav className="mobile-session-views" aria-label={t('appSessionViews')}>
                {sessionViews.map(({id,label,Icon})=><button type="button" key={id} aria-current={(id==='agents'?agentsVisible:view===id)?'page':undefined} disabled={id==='agents'&&pendingMuxRequest} onClick={()=>{setMobileTools(false);if(id==='agents')showNavigation('agents');else setView(id);}}><Icon size={16}/><span>{label}</span></button>)}
              </nav>
              <button type="button" onClick={()=>{setMobileTools(false);setPalette(true);}}>{t('appNewConnection')}</button>
              {active.connected && !active.local && active.attached?.kind==='tmux' && <button type="button" onClick={()=>{setMobileTools(false);showNavigation('workspaces');}}>{t('appJumpTo')}</button>}
              <button type="button" disabled={closingIds.includes(active.id)} onClick={()=>{setMobileTools(false);void closeSession(active);}}>{t('appEndValue1Connection',{value1:active.name})}</button>
            </>}
            {compactTerminal && native && previousWorkspace.length>0 && <section className="mobile-workspace-restore" aria-label={t('appRestorePreviousWorkspace')}>{workspaceRestoreControls}</section>}
            <button type="button" onClick={()=>{setMobileTools(false);setPreferences(true);}}>{t('appPreferences')}</button>
            <button onClick={()=>{setMobileTools(false);setPushSettings(true);}}>{t("appRemotePushSettings")}</button>
            <button
              disabled={!native}
              onClick={() => {
                setMobileTools(false);
                setInbox(true);
              }}
            >{t("appOpenNotificationInbox")}</button>
            <button
              disabled={!native}
              onClick={() => {
                setMobileTools(false);
                setSync(true);
              }}
            >{t("appOpenEncryptedSync")}</button>
            <button
              disabled={!native}
              onClick={() => {
                setMobileTools(false);
                setSharing(true);
              }}
            >{t("appOpenShareableUploads")}</button>
            <button
              onClick={() => {
                setMobileTools(false);
                setPalette(true);
              }}
            >{t("appSearchSavedHosts")}</button>
          </div>
        </Dialog>
      )}
      {sharing && (
        <Dialog title={t("appShareableUploads")} close={() => setSharing(false)}>
          <Suspense fallback={<p>{t("appLoadingSharing")}</p>}>
            <SharePanel />
          </Suspense>
        </Dialog>
      )}
      {sync && (
        <Dialog title={t("appEncryptedSync")} close={() => setSync(false)}>
          <Suspense fallback={<p>{t("appOpeningSync")}</p>}>
            <SyncPanel onHostsChanged={() => void loadHosts()} />
          </Suspense>
        </Dialog>
      )}
    </div>
  );
}
