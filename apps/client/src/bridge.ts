import { protectedInvoke as invoke, sessionOutput, guardAccessCallback } from './access';
import { Channel, invoke as acknowledgeInvoke, isTauri } from "@tauri-apps/api/core";
import { registerSessionOutput } from './pendingSessions';

export type TransportMode = 'auto' | 'ssh' | 'mosh' | 'et';
export type UsageFreshness = "fresh" | "stale" | "unknown";
export type RecordedUsageContext = {
  source: "codex_token_count"; usedTokens: number | null; limitTokens: number | null;
  recordedAt: string | null; freshness: UsageFreshness;
};
export type RecordedProviderWindow = {
  provider: "codex"; accountId: null; limitId: string | null; kind: "primary" | "secondary";
  usedPercent: number; windowMinutes: number | null; resetsAt: string | null;
  recordedAt: string | null; freshness: UsageFreshness;
};
export type MoshOptions = {serverPath: string; portMin: number; portMax: number};
export type EtOptions = {serverPath: string; port: number};
export type AutoOptions = {mosh: MoshOptions; et: EtOptions};
export type Host = {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  fingerprint?: string | null;
  jumpHostId?: string | null;
  credentialsStored?: boolean;
  forwardAgent?: boolean;
  biometricUnlock?: boolean;
  defaultMultiplexer?: {kind: MultiplexerKind; name: string} | null;
  transport?: TransportMode | null;
  mosh?: MoshOptions | null;
  et?: EtOptions | null;
};
export type SshEvent =
  | { type: "data"; data: number[] }
  | { type: "closed"; message?: string };
export type SshError = { kind: string; message: string; fingerprint?: string; hostId?: string };
export type FileEntry = { name: string; isDir: boolean; size: number };
export type MuxSession = {
  id: string;
  name: string;
  windows: number;
  attached: boolean;
};
export type Credentials = {
  password?: string;
  privateKey?: string;
  passphrase?: string;
};
export type MultiplexerKind = 'tmux' | 'herdr' | 'zellij';
export type HerdrNavigationTarget =
  | {kind:'workspace';workspace:string}
  | {kind:'tab';workspace:string;tab:string}
  | {kind:'pane';workspace:string;tab:string;pane:string;terminal:string};
export type TmuxJumpSnapshot = {
  generation: string;
  current: { sessionId: string; windowId: string };
  sessions: { id: string; name: string; restoreName: string | null; windows: { id: string; index: number; name: string }[] }[];
};

export const native = isTauri();
function remoteInvoke<T>(command:string, args:{sessionId:string}&Record<string,unknown>):Promise<T> {
  if(args.sessionId.startsWith('local:')) return Promise.reject(new Error('This tool requires an SSH connection.'));
  return invoke<T>(command,args);
}
function createSession(command: string, args: Record<string,unknown>, onEvent: (event:SshEvent)=>void) {
  const events = new Channel<SshEvent>();
  const deliver = sessionOutput(onEvent); events.onmessage = deliver;
  return invoke<{sessionId:string}>(command, {...args,events}).then(result=>{
    registerSessionOutput(result.sessionId,deliver.dispose); return result;
  }, error=>{deliver.dispose();throw error;});
}
function createRemoteSession(command:string,args:{sessionId:string}&Record<string,unknown>,onEvent:(event:SshEvent)=>void) {
  if(args.sessionId.startsWith('local:'))return Promise.reject(new Error('This tool requires an SSH connection.'));
  return createSession(command,args,onEvent);
}
export const api = {
  accountUsage: (sessionId:string) => invoke<import("./accountUsageReport").AccountUsageResponse>("account_usage", {sessionId}),
  companionHooks: (sessionId:string,request:{agent:'claude'|'codex'|'opencode';action:'status'|'install'|'remove';profileRoot:string;expectedPlan?:string}) => remoteInvoke<unknown>('companion_hooks',{sessionId,request}),
  installCompanion: (sessionId:string,onProgress:(value:unknown)=>void) => {
    if(sessionId.startsWith('local:'))return Promise.reject(new Error('This tool requires an SSH connection.'));
    const progress=new Channel<unknown>();progress.onmessage=guardAccessCallback(onProgress);
    return remoteInvoke<unknown>('install_companion',{sessionId,progress}).finally(()=>{progress.onmessage=()=>{};});
  },
  clipboardIsAndroid: () => invoke<boolean>('clipboard_is_android'),
  clipboardRead: (request: {token: string; kind: 'text' | 'image'}) => invoke<unknown>('clipboard_read', {request}),
  clipboardCancel: (token: string) => acknowledgeInvoke<void>('clipboard_cancel', {token}),
  connectLocal: (onEvent:(event:SshEvent)=>void, launchReceipt?:string) => createSession('local_connect',{cols:100,rows:30,...(launchReceipt ? {launchReceipt} : {})},onEvent),
  connectEt: (sessionId: string, options: {serverPath?: string; port?: number}, onEvent: (event: SshEvent) => void) => {
    return createRemoteSession("connect_et", {sessionId, options, cols:100, rows:30},onEvent);
  },
  connectMosh: (sessionId: string, options: {serverPath?: string; portMin?: number; portMax?: number}, onEvent: (event: SshEvent) => void) => {
    return createRemoteSession("connect_mosh", {sessionId, options, cols:100, rows:30},onEvent);
  },
  openWebUrl: (url: string) => invoke<void>("open_web_url", { url }),
  attachDefaultMultiplexer: (sessionId:string,target:NonNullable<Host['defaultMultiplexer']>,onEvent:(event:SshEvent)=>void) =>
    createRemoteSession('attach_multiplexer',{sessionId,...target,createIfMissing:true,cols:100,rows:30},onEvent),
  attachMultiplexer: (sessionId: string, kind: MultiplexerKind, name: string, onEvent: (event: SshEvent) => void) => {
    return createRemoteSession('attach_multiplexer', { sessionId, kind, name, cols: 100, rows: 30 },onEvent);
  },
  listHosts: () => invoke<Host[]>("list_hosts"),
  saveHost: (host: Host) => invoke<Host>("save_host", { host }),
  deleteHost: (hostId: string) => invoke<void>("delete_host", { hostId }),
  trustHostKey: (hostId: string, fingerprint: string, launchReceipt?:string) =>
    invoke<void>("trust_host_key", { hostId, fingerprint, ...(launchReceipt ? {launchReceipt} : {}) }),
  connect: (
    hostId: string,
    credentials: Credentials,
    onEvent: (event: SshEvent) => void,
    options: { rememberCredentials?: boolean; useSavedCredentials?: boolean; jumpCredentials?: Credentials; launchReceipt?:string } = {},
  ) => {
    return createSession("connect", {
      hostId,
      ...credentials,
      ...options,
      cols: 100,
      rows: 30,
    },onEvent);
  },
  restoreFileTransfer: (sessionId:string, credentials:Credentials, options:{useSavedCredentials?:boolean}={}) =>
    remoteInvoke<{schemaVersion:1;status:'restored'}>('restore_file_transfer',{sessionId,...credentials,...options}),
  restoreHostTools: (sessionId:string, credentials:Credentials, options:{useSavedCredentials?:boolean}={}) =>
    remoteInvoke<{schemaVersion:1;status:'restored'}>('restore_host_tools',{sessionId,...credentials,...options}),
  adoptSession: (sessionId:string) => invoke<void>('adopt_session',{sessionId}),
  write: (sessionId: string, data: string) =>
    invoke<void>(sessionId.startsWith('local:') ? 'local_write' : "write_stdin", { sessionId, data }),
  writeSequence: (sessionId: string, steps: string[]) =>
    invoke<void>(sessionId.startsWith('local:') ? 'local_write' : 'write_stdin', {sessionId, data:'', steps}),
  zellijNavigate: (sessionId: string, name: string, type: 'nextTab' | 'previousTab' | 'nextPane' | 'previousPane') =>
    invoke<void>('zellij_action', {sessionId, name, action:{type}}),
  ackOutput: (sessionId: string, bytes: number) =>
    // Native permits only bounded accounting for already-delivered bytes across lock generations.
    acknowledgeInvoke<void>(sessionId.startsWith('local:') ? 'local_ack' : "ack_output", { sessionId, bytes }),
  resize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>(sessionId.startsWith('local:') ? 'local_resize' : "resize", { sessionId, cols, rows }),
  disconnect: (sessionId: string) => invoke<void>(sessionId.startsWith('local:') ? 'local_disconnect' : "disconnect", { sessionId }),
  listDirectory: (sessionId: string, path: string) =>
    remoteInvoke<FileEntry[]>("list_directory", { sessionId, path }),
  readFile: (sessionId: string, path: string) =>
    remoteInvoke<string>("read_file", { sessionId, path }),
  hostClipboardCopy: (sessionId: string, uploadId: string) =>
    remoteInvoke<void>("host_clipboard_copy", {sessionId,uploadId}),
  reserveUpload: (sessionId: string, size: number) =>
    remoteInvoke<{uploadId:string}>("upload_reserve", { sessionId, size }),
  cancelUpload: (sessionId: string, uploadId: string) =>
    remoteInvoke<{outcome:'cancellation_requested'|'unknown_or_settled'}>("upload_cancel", { sessionId, uploadId }),
  uploadFile: (sessionId: string, path: string, data: number[], uploadId: string) =>
    remoteInvoke<{path:string}>("upload_file", { sessionId, path, data, uploadId }),
  diff: (sessionId: string, path: string, staged = false) =>
    remoteInvoke<string>("get_diff", { sessionId, path, staged }),
  muxSessions: (sessionId: string, tmuxServer?: string) =>
    remoteInvoke<MuxSession[]>("list_multiplexer_sessions", { sessionId, ...(tmuxServer === undefined ? {} : {tmuxServer}) }),
  tmuxJumpSnapshot: (sessionId: string) => remoteInvoke<TmuxJumpSnapshot>('tmux_jump_snapshot', { sessionId }),
  tmuxJump: (sessionId: string, generation: string, targetSessionId: string, windowId: string) =>
    remoteInvoke<TmuxJumpSnapshot>('tmux_jump', { sessionId, generation, targetSessionId, windowId }),
  attachTmux: (
    sessionId: string,
    name: string,
    onEvent: (event: SshEvent) => void,
    tmuxServer?: string,
  ) => {
    return createRemoteSession("attach_tmux", {
      ...(tmuxServer === undefined ? {} : {tmuxServer}),
      sessionId,
      name,
      cols: 100,
      rows: 30,
    },onEvent);
  },
};
