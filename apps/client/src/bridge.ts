import { protectedInvoke as invoke, sessionOutput } from './access';
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
  connectLocal: (onEvent:(event:SshEvent)=>void) => createSession('local_connect',{cols:100,rows:30},onEvent),
  connectEt: (sessionId: string, options: {serverPath?: string; port?: number}, onEvent: (event: SshEvent) => void) => {
    return createRemoteSession("connect_et", {sessionId, options, cols:100, rows:30},onEvent);
  },
  connectMosh: (sessionId: string, options: {serverPath?: string; portMin?: number; portMax?: number}, onEvent: (event: SshEvent) => void) => {
    return createRemoteSession("connect_mosh", {sessionId, options, cols:100, rows:30},onEvent);
  },
  openWebUrl: (url: string) => invoke<void>("open_web_url", { url }),
  attachMultiplexer: (sessionId: string, kind: MultiplexerKind, name: string, onEvent: (event: SshEvent) => void) => {
    return createRemoteSession('attach_multiplexer', { sessionId, kind, name, cols: 100, rows: 30 },onEvent);
  },
  listHosts: () => invoke<Host[]>("list_hosts"),
  saveHost: (host: Host) => invoke<Host>("save_host", { host }),
  deleteHost: (hostId: string) => invoke<void>("delete_host", { hostId }),
  trustHostKey: (hostId: string, fingerprint: string) =>
    invoke<void>("trust_host_key", { hostId, fingerprint }),
  connect: (
    hostId: string,
    credentials: Credentials,
    onEvent: (event: SshEvent) => void,
    options: { rememberCredentials?: boolean; useSavedCredentials?: boolean; jumpCredentials?: Credentials } = {},
  ) => {
    return createSession("connect", {
      hostId,
      ...credentials,
      ...options,
      cols: 100,
      rows: 30,
    },onEvent);
  },
  adoptSession: (sessionId:string) => invoke<void>('adopt_session',{sessionId}),
  write: (sessionId: string, data: string) =>
    invoke<void>(sessionId.startsWith('local:') ? 'local_write' : "write_stdin", { sessionId, data }),
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
  uploadFile: (sessionId: string, path: string, data: number[]) =>
    remoteInvoke<void>("upload_file", { sessionId, path, data }),
  diff: (sessionId: string, path: string, staged = false) =>
    remoteInvoke<string>("get_diff", { sessionId, path, staged }),
  muxSessions: (sessionId: string) =>
    remoteInvoke<MuxSession[]>("list_multiplexer_sessions", { sessionId }),
  attachTmux: (
    sessionId: string,
    name: string,
    onEvent: (event: SshEvent) => void,
  ) => {
    return createRemoteSession("attach_tmux", {
      sessionId,
      name,
      cols: 100,
      rows: 30,
    },onEvent);
  },
};
