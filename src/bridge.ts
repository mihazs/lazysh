import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

export type Host = {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  fingerprint?: string | null;
};
export type SshEvent =
  | { type: "data"; data: number[] }
  | { type: "closed"; message?: string };
export type SshError = { kind: string; message: string; fingerprint?: string };
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

export const native = isTauri();
export const api = {
  listHosts: () => invoke<Host[]>("list_hosts"),
  saveHost: (host: Host) => invoke<Host>("save_host", { host }),
  deleteHost: (hostId: string) => invoke<void>("delete_host", { hostId }),
  trustHostKey: (hostId: string, fingerprint: string) =>
    invoke<void>("trust_host_key", { hostId, fingerprint }),
  connect: (
    hostId: string,
    credentials: Credentials,
    onEvent: (event: SshEvent) => void,
  ) => {
    const events = new Channel<SshEvent>();
    events.onmessage = onEvent;
    return invoke<{ sessionId: string }>("connect", {
      hostId,
      ...credentials,
      cols: 100,
      rows: 30,
      events,
    });
  },
  write: (sessionId: string, data: string) =>
    invoke<void>("write_stdin", { sessionId, data }),
  ackOutput: (sessionId: string, bytes: number) =>
    invoke<void>("ack_output", { sessionId, bytes }),
  resize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("resize", { sessionId, cols, rows }),
  disconnect: (sessionId: string) => invoke<void>("disconnect", { sessionId }),
  listDirectory: (sessionId: string, path: string) =>
    invoke<FileEntry[]>("list_directory", { sessionId, path }),
  readFile: (sessionId: string, path: string) =>
    invoke<string>("read_file", { sessionId, path }),
  uploadFile: (sessionId: string, path: string, data: number[]) =>
    invoke<void>("upload_file", { sessionId, path, data }),
  diff: (sessionId: string, path: string, staged = false) =>
    invoke<string>("get_diff", { sessionId, path, staged }),
  muxSessions: (sessionId: string) =>
    invoke<MuxSession[]>("list_multiplexer_sessions", { sessionId }),
  attachTmux: (
    sessionId: string,
    name: string,
    onEvent: (event: SshEvent) => void,
  ) => {
    const events = new Channel<SshEvent>();
    events.onmessage = onEvent;
    return invoke<{ sessionId: string }>("attach_tmux", {
      sessionId,
      name,
      cols: 100,
      rows: 30,
      events,
    });
  },
};
