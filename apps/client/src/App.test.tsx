// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Host } from "./bridge";

const mocks = vi.hoisted(() => ({
  api: {
    listHosts: vi.fn(),
    saveHost: vi.fn(),
    deleteHost: vi.fn(),
    trustHostKey: vi.fn(),
    connect: vi.fn(),
    connectLocal: vi.fn(),
    connectMosh: vi.fn(),
    connectEt: vi.fn(),
    disconnect: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    ackOutput: vi.fn(),
    adoptSession: vi.fn(),
    muxSessions: vi.fn(),
    attachTmux: vi.fn(),
    tmuxJumpSnapshot: vi.fn(),
    tmuxJump: vi.fn(),
  },
  terminal: { write: vi.fn(), dispose: vi.fn() },
  invoke: vi.fn(),
  appleProps: vi.fn(),
  voiceProps: vi.fn(),
  lockEvent: undefined as undefined | ((event: { payload: unknown }) => void),
}));
let generationBase=0;
const unlockedStatus = () => ({initialized:true,supported:true,reason:'',enabled:false,locked:false,generation:String(generationBase),nonce:'a'.repeat(64)});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...request:[string,unknown?,unknown?]) => {
  const [command]=request;
  if(command==='app_lock_status')return Promise.resolve(unlockedStatus());
  if(command==='app_lock_ready')return Promise.resolve();
  return mocks.invoke(...request);
} }));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async (_name:string,callback:(event:{payload:unknown})=>void)=>{
  mocks.lockEvent=callback;return()=>{mocks.lockEvent=undefined;};
})}));
vi.mock("./bridge", () => ({ native: true, api: mocks.api }));
vi.mock("./terminal", () => ({ createTerminal: () => mocks.terminal }));
vi.mock("./TerminalPane", () => ({
  default: ({ active }: { active: boolean }) =>
    active ? <div>Live SSH terminal</div> : null,
}));
vi.mock("./AgentPanel", () => ({ default: () => <div>Agent companion</div> }));
vi.mock('./PushSettingsPanel',()=>({default:()=> <div>Native push registration controls</div>}));
vi.mock('./AppleStatusPanel',async()=>{
  const {useState}=await import('react');
  return {default:(props:{sessionId:string;usage?:unknown;onReview:()=>void})=>{
    const [sharing,setSharing]=useState(false);mocks.appleProps(props);
    return <div>Apple controls for {props.sessionId}<button onClick={props.onReview}>Review Apple approval</button><button onClick={()=>setSharing(true)}>Start test Apple sharing</button>{sharing && <p>Apple sharing remains active</p>}</div>;
  }};
});
vi.mock('./UsagePanel',()=>({default:({onShareAppleUsage}:{onShareAppleUsage?:(report:unknown)=>void})=><button onClick={()=>onShareAppleUsage?.({recordedAt:'2026-10-25T12:00:00Z',freshness:'fresh',inputTokens:11,outputTokens:9,cacheReadTokens:null,cacheWriteTokens:2,observedAt:'2026-10-25T12:01:00Z',receivedAt:1792929660000})}>Use latest report for Watch</button>}));
vi.mock('./VoicePanel',()=>({default:(props:{sessionId:string;onDirectDictation:(request:import('./voiceDelivery').DirectDictation)=>Promise<void>})=>{mocks.voiceProps(props);return <div>Voice for {props.sessionId}</div>;}}));
import App, { validateHost } from "./App";

const host: Host = {
  id: "home",
  name: "Home",
  hostname: "home.local",
  port: 22,
  username: "dev",
};

beforeEach(() => {
  generationBase+=10;
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", {
    setItem: vi.fn(),
    getItem: vi.fn(),
    removeItem: vi.fn(),
    length: 0,
  });
  vi.stubGlobal("sessionStorage", {
    setItem: vi.fn(),
    getItem: vi.fn(),
    removeItem: vi.fn(),
    length: 0,
  });
  mocks.api.listHosts.mockResolvedValue([host]);
  mocks.invoke.mockResolvedValue(false);
  mocks.api.disconnect.mockResolvedValue(undefined);
  mocks.api.adoptSession.mockResolvedValue(undefined);
  mocks.api.trustHostKey.mockResolvedValue(undefined);
  mocks.api.ackOutput.mockResolvedValue(undefined);
  mocks.terminal.write.mockImplementation(
    (_data: Uint8Array, callback?: () => void) => callback?.(),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openConnection() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Connect to Home" }),
  );
  await user.type(screen.getByLabelText("Password"), "temporary-secret");
  return user;
}

it('keeps the existing terminal session while clearing tool views across native lock', async () => {
  mocks.api.connect.mockResolvedValue({sessionId:'retained-ssh'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  await user.click(screen.getByRole('button',{name:'Transcript'}));
  await act(async()=>mocks.lockEvent!({payload:{initialized:true,supported:true,reason:'',enabled:true,locked:true,generation:String(generationBase+1)}}));
  expect(screen.queryByText('Live SSH terminal')).toBeNull();expect(screen.queryByRole('tab')).toBeNull();
  await act(async()=>mocks.lockEvent!({payload:{initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(generationBase+2),nonce:'b'.repeat(64)}}));
  await screen.findByText('Live SSH terminal');
  expect(screen.getAllByRole('tab')).toHaveLength(1);expect(mocks.api.connect).toHaveBeenCalledOnce();
  expect(mocks.api.disconnect).not.toHaveBeenCalled();expect(mocks.terminal.dispose).not.toHaveBeenCalled();
});

it('does not register a late pre-lock connection into the retained session registry', async () => {
  let finish!:(value:{sessionId:string})=>void;
  mocks.api.connect.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await act(async()=>mocks.lockEvent!({payload:{initialized:true,supported:true,reason:'',enabled:true,locked:true,generation:String(generationBase+1)}}));
  await act(async()=>mocks.lockEvent!({payload:{initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(generationBase+2),nonce:'b'.repeat(64)}}));
  await act(async()=>finish({sessionId:'stale-ssh'}));
  await screen.findByRole('button',{name:'Connect to Home'});
  expect(screen.queryByRole('tab')).toBeNull();expect(screen.queryByText('Live SSH terminal')).toBeNull();
});

it('tears down known pending bootstrap IDs on lock while retaining an adopted terminal and suppressing disposed replay',async()=>{
  enableTransports();
  mocks.api.connect.mockResolvedValueOnce({sessionId:'adopted-live-lock-test'}).mockResolvedValueOnce({sessionId:'pending-bootstrap-lock-test'});
  let finish!:(value:{sessionId:string})=>void;let replay!:(event:unknown)=>void;
  mocks.api.connectMosh.mockImplementation((_parent,_options,onEvent)=>{replay=onEvent;return new Promise(resolve=>{finish=resolve;});});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');await waitFor(()=>expect(mocks.api.adoptSession).toHaveBeenCalledWith('adopted-live-lock-test'));
  await user.click(screen.getByRole('button',{name:'Connect to Home'}));
  await user.type(screen.getByLabelText('Password'),'second-secret');await user.selectOptions(screen.getByLabelText('Transport'),'auto');
  await user.click(screen.getByRole('button',{name:'Connect'}));await waitFor(()=>expect(mocks.api.connectMosh).toHaveBeenCalled());
  await act(async()=>mocks.lockEvent!({payload:{initialized:true,supported:true,reason:'',enabled:true,locked:true,generation:String(generationBase+1)}}));
  expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'pending-bootstrap-lock-test'});
  expect(mocks.invoke).not.toHaveBeenCalledWith('disconnect',{sessionId:'adopted-live-lock-test'});
  await act(async()=>finish({sessionId:'late-pending-lock-test'}));
  await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'late-pending-lock-test'}));
  mocks.terminal.write.mockClear();replay({type:'data',data:[115,101,99,114,101,116]});expect(mocks.terminal.write).not.toHaveBeenCalled();
  await act(async()=>mocks.lockEvent!({payload:{initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(generationBase+2),nonce:'b'.repeat(64)}}));
  await screen.findByText('Live SSH terminal');expect(screen.getAllByRole('tab')).toHaveLength(1);
  expect(mocks.api.adoptSession).toHaveBeenCalledTimes(1);
});

it('closes known pending restoration IDs when lock revokes the old mount',async()=>{
  enableTransports();
  vi.mocked(localStorage.getItem).mockImplementation(key=>key==='lazysh.workspace.v1'?JSON.stringify([{hostId:'home',mosh:{serverPath:'mosh-server',portMin:60000,portMax:61000}}]):null);
  mocks.api.connect.mockResolvedValue({sessionId:'restoration-pending-lock-test'});
  let finish!:(value:{sessionId:string})=>void;
  mocks.api.connectMosh.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const user=userEvent.setup();render(<App/>);await screen.findByRole('button',{name:'Connect to Home'});
  await user.click(screen.getByRole('button',{name:'Restore previous workspace'}));await waitFor(()=>expect(mocks.api.connectMosh).toHaveBeenCalled());
  await act(async()=>mocks.lockEvent!({payload:{initialized:true,supported:true,reason:'',enabled:true,locked:true,generation:String(generationBase+1)}}));
  expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'restoration-pending-lock-test'});
  await act(async()=>finish({sessionId:'restoration-late-lock-test'}));
  await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'restoration-late-lock-test'}));
  expect(mocks.api.adoptSession).not.toHaveBeenCalled();
});

describe("host validation", () => {
  it("accepts direct IPv4, IPv6, and tailnet destinations and rejects ambiguous SSH strings", () => {
    for (const hostname of [
      "100.70.0.2",
      "2001:db8::1",
      "machine.tailnet.ts.net",
    ])
      expect(validateHost({ ...host, hostname })).toBe("");
    for (const hostname of [
      "dev@host",
      "host/path",
      "host name",
      "host\noption",
    ])
      expect(validateHost({ ...host, hostname })).not.toBe("");
    for (const port of [0, 65536, 22.5, NaN])
      expect(validateHost({ ...host, port })).not.toBe("");
  });
});

describe("connection flow", () => {
  it("trusts the bastion identity separately and never substitutes the destination password", async () => {
    const jump = {
      ...host,
      id: "jump",
      name: "Gateway",
      hostname: "gateway.local",
    };
    mocks.api.listHosts.mockResolvedValue([
      { ...host, jumpHostId: "jump" },
      jump,
    ]);
    mocks.api.connect
      .mockRejectedValueOnce({
        kind: "unknown_host_key",
        hostId: "jump",
        fingerprint: "SHA256:jump",
        message: "Verify gateway",
      })
      .mockResolvedValueOnce({ sessionId: "routed" });
    const user = await openConnection();
    await user.click(screen.getByLabelText("Use bastion’s saved credentials"));
    await user.type(
      screen.getByLabelText("Bastion password"),
      "gateway-secret",
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("gateway.local:22")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Trust key and connect" }),
    );
    expect(await screen.findByText("Live SSH terminal")).toBeTruthy();
    expect(mocks.api.trustHostKey).toHaveBeenCalledWith("jump", "SHA256:jump");
    expect(mocks.api.connect).toHaveBeenLastCalledWith(
      "home",
      { password: "temporary-secret" },
      expect.any(Function),
      {
        rememberCredentials: false,
        useSavedCredentials: false,
        jumpCredentials: { password: "gateway-secret" },
      },
    );
  });

  it("uses saved native credentials only after explicit selection without exposing their values", async () => {
    mocks.invoke.mockImplementation(
      async (command) => command === "has_credentials",
    );
    mocks.api.connect.mockResolvedValue({ sessionId: "saved" });
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Connect to Home" }),
    );
    await user.click(await screen.findByLabelText("Use saved credentials"));
    expect(screen.queryByLabelText("Password")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Live SSH terminal")).toBeTruthy();
    expect(mocks.api.connect).toHaveBeenCalledWith(
      "home",
      {},
      expect.any(Function),
      { rememberCredentials: false, useSavedCredentials: true },
    );
    expect(window.localStorage.setItem).toHaveBeenCalledExactlyOnceWith(
      "lazysh.workspace.v1",
      '[{"hostId":"home"}]',
    );
    expect(window.sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it("forgets saved credentials before removing the saved-login option", async () => {
    mocks.invoke.mockImplementation(
      async (command) => command === "has_credentials",
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Connect to Home" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Forget saved credentials" }),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Use saved credentials")).toBeNull(),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("forget_credentials", {
      hostId: "home",
    }, { headers: { "X-Lazysh-Access": expect.any(String) } });
  });

  it("requires explicit host-key acceptance before retrying and keeps credentials out of storage", async () => {
    mocks.api.connect
      .mockRejectedValueOnce({
        kind: "unknown_host_key",
        message: "Verify key",
        fingerprint: "SHA256:known-key",
      })
      .mockResolvedValueOnce({ sessionId: "one" });
    const user = await openConnection();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("SHA256:known-key")).toBeTruthy();
    expect(mocks.api.connect).toHaveBeenCalledTimes(1);
    expect(mocks.api.trustHostKey).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Trust key and connect" }),
    );
    expect(await screen.findByText("Live SSH terminal")).toBeTruthy();
    expect(mocks.api.trustHostKey).toHaveBeenCalledWith(
      "home",
      "SHA256:known-key",
    );
    expect(mocks.api.connect).toHaveBeenLastCalledWith(
      "home",
      { password: "temporary-secret" },
      expect.any(Function),
    );
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(window.localStorage.setItem).toHaveBeenCalledExactlyOnceWith(
      "lazysh.workspace.v1",
      '[{"hostId":"home"}]',
    );
    expect(window.sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it("blocks a changed key without offering a trust shortcut", async () => {
    mocks.api.connect.mockRejectedValue({
      kind: "host_key_changed",
      message: "Changed",
      fingerprint: "SHA256:attacker",
    });
    const user = await openConnection();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Connection blocked",
    );
    expect(
      screen.queryByRole("button", { name: "Trust key and connect" }),
    ).toBeNull();
    expect(mocks.api.trustHostKey).not.toHaveBeenCalled();
  });

  it("does not create duplicate sessions while authentication is pending", async () => {
    let resolve: (value: { sessionId: string }) => void = () => {};
    mocks.api.connect.mockImplementation(
      () =>
        new Promise((value) => {
          resolve = value;
        }),
    );
    const user = await openConnection();
    await user.dblClick(screen.getByRole("button", { name: "Connect" }));
    expect(mocks.api.connect).toHaveBeenCalledTimes(1);
    resolve({ sessionId: "one" });
    await screen.findByText("Live SSH terminal");
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("forwards split multibyte output intact and acknowledges consumed bytes after the session is established", async () => {
    mocks.api.connect.mockImplementation(
      async (
        _host: string,
        _credentials: unknown,
        onEvent: (event: unknown) => void,
      ) => {
        const bytes = new TextEncoder().encode("你好");
        onEvent({ type: "data", data: Array.from(bytes.slice(0, 2)) });
        onEvent({ type: "data", data: Array.from(bytes.slice(2)) });
        expect(mocks.api.ackOutput).not.toHaveBeenCalled();
        return { sessionId: "one" };
      },
    );
    const user = await openConnection();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("Live SSH terminal");
    const forwarded = new Uint8Array(
      mocks.terminal.write.mock.calls.flatMap((call) =>
        Array.from(call[0] as Uint8Array),
      ),
    );
    expect(new TextDecoder().decode(forwarded)).toBe("你好");
    expect(mocks.api.ackOutput).toHaveBeenCalledWith("one", 6);
  });

  it("attaches tmux in a separate terminal without injecting input or replacing the original tab", async () => {
    mocks.api.connect.mockResolvedValue({ sessionId: "one" });
    mocks.invoke.mockResolvedValue({
      tmuxAvailable: true,
      herdrAvailable: false,
      zellijAvailable: false,
      sessions: [{ id: "$1", name: "work", windows: [] }],
    });
    mocks.api.attachTmux.mockResolvedValue({ sessionId: "two" });
    const user = await openConnection();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("Live SSH terminal");
    await user.click(screen.getByRole("button", { name: "Sessions" }));
    await user.click(
      await screen.findByRole("button", { name: "Attach work" }),
    );
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(mocks.api.attachTmux).toHaveBeenCalledWith(
      "one",
      "work",
      expect.any(Function),
    );
    expect(mocks.api.write).not.toHaveBeenCalled();
    expect(mocks.api.disconnect).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: /^Home$/ }));
    expect(screen.getByText("Live SSH terminal")).toBeTruthy();
  });

  it('jumps inside the attached display and persists only its destination name for restoration', async () => {
    mocks.api.connect.mockResolvedValue({sessionId:'source'});
    mocks.invoke.mockResolvedValue({tmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,sessions:[{id:'$1',name:'work',windows:[]}]});
    mocks.api.attachTmux.mockResolvedValue({sessionId:'display'});
    const snapshot={generation:'native-only-generation',current:{sessionId:'$1',windowId:'@1'},sessions:[
      {id:'$1',name:'work',windows:[{id:'@1',index:0,name:'agent'}]},
      {id:'$2',name:'destination',windows:[{id:'@2',index:1,name:'build'}]},
    ]};
    mocks.api.tmuxJumpSnapshot.mockResolvedValue(snapshot);
    mocks.api.tmuxJump.mockResolvedValue({...snapshot,current:{sessionId:'$2',windowId:'@2'}});
    const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
    await screen.findByText('Live SSH terminal');expect(screen.queryByRole('button',{name:'Jump To'})).toBeNull();
    await user.click(screen.getByRole('button',{name:'Sessions'}));
    await user.click(await screen.findByRole('button',{name:'Attach work'}));
    await user.click(await screen.findByRole('button',{name:'Jump To'}));
    await user.click(await screen.findByRole('button',{name:'1: build'}));
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Jump To'})).toBeNull());
    expect(mocks.api.tmuxJump).toHaveBeenCalledWith('display','native-only-generation','$2','@2');
    expect(screen.getByRole('tab',{name:'Home / destination'})).toBeTruthy();
    expect(localStorage.setItem).toHaveBeenLastCalledWith('lazysh.workspace.v1',JSON.stringify([{hostId:'home'},{hostId:'home',attached:{kind:'tmux',name:'destination'}}]));
    expect(mocks.api.write).not.toHaveBeenCalled();expect(mocks.api.disconnect).not.toHaveBeenCalled();
  });

  it("only returns output credit after the terminal has consumed a chunk", async () => {
    let consumed: (() => void) | undefined;
    mocks.terminal.write.mockImplementation(
      (_data: Uint8Array, callback?: () => void) => {
        consumed = callback;
      },
    );
    mocks.api.connect.mockImplementation(
      async (
        _host: string,
        _credentials: unknown,
        onEvent: (event: unknown) => void,
      ) => {
        onEvent({ type: "data", data: [97, 98, 99] });
        return { sessionId: "one" };
      },
    );
    const user = await openConnection();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("Live SSH terminal");
    expect(mocks.api.ackOutput).not.toHaveBeenCalled();
    consumed?.();
    expect(mocks.api.ackOutput).toHaveBeenCalledWith("one", 3);
  });
});

it("saves only host metadata through the native API", async () => {
  mocks.api.listHosts.mockResolvedValue([]);
  mocks.api.saveHost.mockResolvedValue(host);
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Add your first host" }));
  await user.type(screen.getByLabelText("Name"), "Home");
  await user.type(screen.getByLabelText("Hostname or IP"), "home.local");
  await user.type(screen.getByLabelText("Username"), "dev");
  await user.click(screen.getByRole("button", { name: "Save host" }));
  await waitFor(() =>
    expect(mocks.api.saveHost).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Home",
        hostname: "home.local",
        username: "dev",
        port: 22,
      }),
    ),
  );
  expect(Object.keys(mocks.api.saveHost.mock.calls[0][0]).sort()).toEqual([
    "hostname",
    "id",
    "name",
    "port",
    "transport",
    "username",
  ]);
});

it("focuses host search when opened with the command palette shortcut", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("button", { name: "Connect to Home" });
  await user.keyboard("{Control>}k{/Control}");
  const search = await screen.findByRole("textbox", {
    name: "Search saved hosts",
  });
  expect(document.activeElement).toBe(search);
  await user.keyboard("missing-host");
  expect(
    await screen.findByText(
      "No matching hosts. Add one to start a connection.",
    ),
  ).toBeTruthy();
});

it("restores an exact tmux workspace through saved credentials without sending shell text", async () => {
  vi.mocked(localStorage.getItem).mockReturnValue(
    JSON.stringify([
      { hostId: "home", attached: { kind: "tmux", name: "durable-agent" } },
    ]),
  );
  mocks.api.connect.mockResolvedValue({ sessionId: "temporary-shell" });
  mocks.api.attachTmux.mockResolvedValue({ sessionId: "restored-agent" });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("button", { name: "Connect to Home" });
  await user.click(
    screen.getByRole("button", { name: "Restore previous workspace" }),
  );
  expect(await screen.findByText("Live SSH terminal")).toBeTruthy();
  expect(mocks.api.connect).toHaveBeenCalledWith(
    "home",
    {},
    expect.any(Function),
    { useSavedCredentials: true },
  );
  expect(mocks.api.attachTmux).toHaveBeenCalledWith(
    "temporary-shell",
    "durable-agent",
    expect.any(Function),
  );
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"temporary-shell"});
  expect(mocks.api.write).not.toHaveBeenCalled();
  expect(localStorage.setItem).toHaveBeenLastCalledWith(
    "lazysh.workspace.v1",
    JSON.stringify([
      { hostId: "home", attached: { kind: "tmux", name: "durable-agent" } },
    ]),
  );
});

it("exports a protected key only on explicit request and clears it when forgotten", async () => {
  mocks.api.listHosts.mockResolvedValue([
    { ...host, biometricUnlock: true, credentialsStored: true },
  ]);
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "has_credentials"
      ? true
      : command === "export_saved_identity"
        ? { privateKey: "test-private-key" }
        : undefined,
  );
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Connect to Home" }),
  );
  expect(mocks.invoke).not.toHaveBeenCalledWith(
    "export_saved_identity",
    expect.anything(), { headers: { "X-Lazysh-Access": expect.any(String) } }
  );
  await user.click(
    screen.getByRole("button", { name: "Export private key with biometrics" }),
  );
  expect(
    (
      (await screen.findByLabelText(
        "Exported private key",
      )) as HTMLTextAreaElement
    ).value,
  ).toBe("test-private-key");
  await user.click(
    screen.getByRole("button", { name: "Forget saved credentials" }),
  );
  await waitFor(() =>
    expect(screen.queryByLabelText("Exported private key")).toBeNull(),
  );
  expect(localStorage.setItem).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.stringContaining("test-private-key"),
  );
});

it("allows cancellation while private key authentication is pending", async () => {
  mocks.api.listHosts.mockResolvedValue([
    { ...host, biometricUnlock: true, credentialsStored: true },
  ]);
  mocks.invoke.mockImplementation((command: string) =>
    command === "export_saved_identity"
      ? new Promise(() => {})
      : Promise.resolve(command === "has_credentials"),
  );
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Connect to Home" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Export private key with biometrics" }),
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.invoke).toHaveBeenCalledWith("cancel_credential_auth", undefined, { headers: { "X-Lazysh-Access": expect.any(String) } });
  expect(
    screen.queryByRole("button", {
      name: "Export private key with biometrics",
    }),
  ).toBeNull();
});

it("clears exported keys on background and rejects a late authentication result", async () => {
  mocks.api.listHosts.mockResolvedValue([
    { ...host, biometricUnlock: true, credentialsStored: true },
  ]);
  let resolveExport: ((value: { privateKey: string }) => void) | undefined;
  mocks.invoke.mockImplementation((command: string) =>
    command === "export_saved_identity"
      ? new Promise((resolve) => {
          resolveExport = resolve;
        })
      : Promise.resolve(command === "has_credentials"),
  );
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Connect to Home" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Export private key with biometrics" }),
  );
  act(() => window.dispatchEvent(new Event("pagehide")));
  await act(async () => resolveExport?.({ privateKey: "late-private-key" }));
  expect(screen.queryByLabelText("Exported private key")).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Export private key with biometrics" }),
  );
  await act(async () => resolveExport?.({ privateKey: "fresh-private-key" }));
  expect(screen.getByLabelText("Exported private key")).toBeTruthy();
  act(() => window.dispatchEvent(new Event("pagehide")));
  expect(screen.queryByLabelText("Exported private key")).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith("cancel_credential_auth", undefined, { headers: { "X-Lazysh-Access": expect.any(String) } });
});

it("hands a verified SSH connection to Mosh before exposing terminal input", async () => {
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "transport_capabilities" ? { mosh: true } : false,
  );
  mocks.api.connect.mockResolvedValue({ sessionId: "ssh-control" });
  mocks.api.connectMosh.mockResolvedValue({ sessionId: "mosh-terminal" });
  const user = await openConnection();
  await user.selectOptions(screen.getByLabelText("Transport"), "mosh");
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByText("Live SSH terminal")).toBeTruthy();
  expect(mocks.api.connectMosh).toHaveBeenCalledWith(
    "ssh-control",
    { serverPath: "mosh-server", portMin: 60000, portMax: 61000 },
    expect.any(Function),
  );
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"ssh-control"});
  expect(localStorage.setItem).toHaveBeenCalledWith(
    "lazysh.workspace.v1",
    JSON.stringify([
      {
        hostId: "home",
        mosh: { serverPath: "mosh-server", portMin: 60000, portMax: 61000 },
      },
    ]),
  );
});

it("closes the SSH bootstrap when forced Mosh fails without falling back", async () => {
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "transport_capabilities" ? { mosh: true } : false,
  );
  mocks.api.connect.mockResolvedValue({ sessionId: "ssh-control" });
  mocks.api.connectMosh.mockRejectedValue(
    new Error("Mosh UDP connection failed"),
  );
  const user = await openConnection();
  await user.selectOptions(screen.getByLabelText("Transport"), "mosh");
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByText("Mosh UDP connection failed")).toBeTruthy();
  expect(screen.queryByText("Live SSH terminal")).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"ssh-control"});
  expect(mocks.api.connect).toHaveBeenCalledTimes(1);
});

it("cancels the SSH control session during Mosh bootstrap and closes a late result", async () => {
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "transport_capabilities" ? { mosh: true } : false,
  );
  mocks.api.connect.mockResolvedValue({ sessionId: "ssh-control" });
  let finish: ((value: { sessionId: string }) => void) | undefined;
  mocks.api.connectMosh.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const user = await openConnection();
  await user.selectOptions(screen.getByLabelText("Transport"), "mosh");
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(mocks.api.connectMosh).toHaveBeenCalled());
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"ssh-control"});
  await act(async () => finish?.({ sessionId: "late-mosh" }));
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"late-mosh"});
  expect(screen.queryByText("Live SSH terminal")).toBeNull();
});

it("opens a fresh ET transport through verified SSH and preserves only reconnect options", async () => {
  mocks.invoke.mockImplementation(async(command:string)=>command==='transport_capabilities'?{et:true,mosh:true}:false);
  mocks.api.connect.mockResolvedValue({sessionId:'ssh-control'});
  mocks.api.connectEt.mockResolvedValue({sessionId:'et-terminal'});
  const user=await openConnection();
  await user.selectOptions(screen.getByLabelText('Transport'),'et');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  expect(await screen.findByText('Live SSH terminal')).toBeTruthy();
  expect(mocks.api.connectEt).toHaveBeenCalledWith('ssh-control',{serverPath:'etterminal',port:2022},expect.any(Function));
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"ssh-control"});
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();
  expect(localStorage.setItem).toHaveBeenCalledWith('lazysh.workspace.v1',JSON.stringify([{hostId:'home',et:{serverPath:'etterminal',port:2022}}]));
});

const autoOptions = {
  mosh: {serverPath:'mosh-server', portMin:60000, portMax:61000},
  et: {serverPath:'etterminal', port:2022},
};
function enableTransports() {
  mocks.invoke.mockImplementation(async(command:string)=>command==='transport_capabilities'?{mosh:true,et:true}:false);
  mocks.api.connect.mockResolvedValue({sessionId:'verified-control'});
}
async function connectAuto() {
  const user = await openConnection();
  await user.selectOptions(screen.getByLabelText('Transport'),'auto');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  return user;
}
it('Auto selects authenticated Mosh first and persists the Auto intention',async()=>{
  enableTransports();
  mocks.api.connectMosh.mockResolvedValue({sessionId:'auto-mosh'});
  await connectAuto();
  expect(await screen.findByText('Auto selected Mosh.')).toBeTruthy();
  expect(mocks.api.connect).toHaveBeenCalledTimes(1);
  expect(mocks.api.connectEt).not.toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"verified-control"});
  expect(localStorage.setItem).toHaveBeenCalledWith('lazysh.workspace.v1',JSON.stringify([{hostId:'home',auto:autoOptions}]));
});
it('Auto reports Mosh UDP failure and tries ET on the same verified SSH connection',async()=>{
  enableTransports();
  mocks.api.connectMosh.mockRejectedValue({kind:'mosh_udp_unreachable',message:'No authenticated UDP reply'});
  mocks.api.connectEt.mockResolvedValue({sessionId:'auto-et'});
  await connectAuto();
  expect(await screen.findByText('Auto selected Eternal Terminal. Mosh: No authenticated UDP reply.')).toBeTruthy();
  expect(mocks.api.connect).toHaveBeenCalledTimes(1);
  expect(mocks.api.connectMosh).toHaveBeenCalledWith('verified-control',autoOptions.mosh,expect.any(Function));
  expect(mocks.api.connectEt).toHaveBeenCalledWith('verified-control',autoOptions.et,expect.any(Function));
});
it('Auto reports both observed failures and keeps the existing SSH terminal',async()=>{
  enableTransports();
  mocks.api.connectMosh.mockRejectedValue({kind:'mosh_bootstrap',message:'Mosh executable is missing'});
  mocks.api.connectEt.mockRejectedValue({kind:'et_unreachable',message:'ET TCP port is closed'});
  await connectAuto();
  expect(await screen.findByText('Auto selected SSH. Mosh: Mosh executable is missing; Eternal Terminal: ET TCP port is closed.')).toBeTruthy();
  expect(mocks.api.connect).toHaveBeenCalledTimes(1);
  expect(mocks.api.disconnect).not.toHaveBeenCalledWith('verified-control');
});
it('Auto stops for SSH host trust without attempting a secondary transport',async()=>{
  enableTransports();
  mocks.api.connect.mockRejectedValue({kind:'unknown_host_key',fingerprint:'SHA256:unverified',message:'Verify this server'});
  await connectAuto();
  expect(await screen.findByText('SHA256:unverified')).toBeTruthy();
  expect(mocks.api.trustHostKey).not.toHaveBeenCalled();
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();
  expect(mocks.api.connectEt).not.toHaveBeenCalled();
});
it.each(['authentication_failed','host_key_changed','cancelled','unclassified'])('Auto stops on %s instead of treating it as transport unavailability',async(kind)=>{
  enableTransports();
  mocks.api.connectMosh.mockRejectedValue({kind,message:'Connection blocked'});
  await connectAuto();
  await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"verified-control"}));
  expect(mocks.api.connectEt).not.toHaveBeenCalled();
  expect(screen.queryByText('Live SSH terminal')).toBeNull();
});
it('Auto never falls back from ET packet authentication failure',async()=>{
  enableTransports();
  mocks.api.connectMosh.mockRejectedValue({kind:'mosh_bootstrap',message:'Mosh not installed'});
  mocks.api.connectEt.mockRejectedValue({kind:'et_authentication',message:'ET packet authentication failed'});
  await connectAuto();
  expect(await screen.findByText('ET packet authentication failed')).toBeTruthy();
  expect(screen.queryByText('Live SSH terminal')).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"verified-control"});
});
it('closing Auto during Mosh prevents a late failed attempt from starting ET',async()=>{
  enableTransports();
  let reject:((error:unknown)=>void)|undefined;
  mocks.api.connectMosh.mockImplementation(()=>new Promise((_resolve,fail)=>{reject=fail;}));
  const user=await connectAuto();
  await waitFor(()=>expect(mocks.api.connectMosh).toHaveBeenCalled());
  await user.click(screen.getByRole('button',{name:'Cancel'}));
  await act(async()=>reject?.({kind:'mosh_udp_unreachable',message:'Late UDP timeout'}));
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"verified-control"});
  expect(mocks.api.connectEt).not.toHaveBeenCalled();
  expect(screen.queryByText('Live SSH terminal')).toBeNull();
});
it('Auto explicitly skips unsupported transports for a bastion route',async()=>{
  enableTransports();
  mocks.api.listHosts.mockResolvedValue([{...host,jumpHostId:'gateway'}]);
  await connectAuto();
  expect(await screen.findByText('Auto selected SSH. Mosh: bastion routes use SSH; Eternal Terminal: bastion routes use SSH.')).toBeTruthy();
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();
  expect(mocks.api.connectEt).not.toHaveBeenCalled();
});
it('loads a named host forced ET preference without changing its connection mode',async()=>{
  enableTransports();
  mocks.api.listHosts.mockResolvedValue([{...host,transport:'et',et:{serverPath:'/opt/etterminal',port:2122}}]);
  mocks.api.connectEt.mockResolvedValue({sessionId:'preferred-et'});
  const user=await openConnection();
  expect((screen.getByLabelText('Transport') as HTMLSelectElement).value).toBe('et');
  expect((screen.getByLabelText('ET terminal path') as HTMLInputElement).value).toBe('/opt/etterminal');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  expect(await screen.findByText('Live SSH terminal')).toBeTruthy();
  expect(mocks.api.connectEt).toHaveBeenCalledWith('verified-control',{serverPath:'/opt/etterminal',port:2122},expect.any(Function));
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();
  expect(mocks.api.saveHost).not.toHaveBeenCalled();
});
it('forced ET fails visibly without falling back to SSH',async()=>{
  enableTransports();
  mocks.api.connectEt.mockRejectedValue({kind:'et_unreachable',message:'ET port unreachable'});
  const user=await openConnection();
  await user.selectOptions(screen.getByLabelText('Transport'),'et');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  expect(await screen.findByText('ET port unreachable')).toBeTruthy();
  expect(screen.queryByText('Live SSH terminal')).toBeNull();
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"verified-control"});
});
it('edits the named host transport and helper options through the native host API',async()=>{
  mocks.api.saveHost.mockResolvedValue(host);
  const user=userEvent.setup();
  render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Edit Home'}));
  await user.selectOptions(screen.getByLabelText('Preferred transport'),'auto');
  await user.clear(screen.getByLabelText('Mosh server path'));
  await user.type(screen.getByLabelText('Mosh server path'),'/opt/mosh-server');
  await user.clear(screen.getByLabelText('ET server port'));
  await user.type(screen.getByLabelText('ET server port'),'2122');
  await user.click(screen.getByRole('button',{name:'Save host'}));
  await waitFor(()=>expect(mocks.api.saveHost).toHaveBeenCalledWith({...host,transport:'auto',mosh:{...autoOptions.mosh,serverPath:'/opt/mosh-server'},et:{...autoOptions.et,port:2122}}));
});
it('restores Auto by probing transports again rather than restoring its last SSH fallback',async()=>{
  enableTransports();
  mocks.api.connectMosh.mockRejectedValue({kind:'mosh_udp_unreachable',message:'UDP blocked again'});
  mocks.api.connectEt.mockResolvedValue({sessionId:'restored-et'});
  vi.mocked(localStorage.getItem).mockImplementation(key=>key==='lazysh.workspace.v1'?JSON.stringify([{hostId:'home',auto:autoOptions}]):null);
  const user=userEvent.setup();
  render(<App/>);
  await screen.findByRole('button',{name:'Connect to Home'});
  await user.click(screen.getByRole('button',{name:'Restore previous workspace'}));
  expect(await screen.findByText('Auto selected Eternal Terminal. Mosh: UDP blocked again.')).toBeTruthy();
  expect(mocks.api.connect).toHaveBeenCalledWith('home',{},expect.any(Function),{useSavedCredentials:true});
  expect(mocks.api.connect).toHaveBeenCalledTimes(1);
});

it('exposes remote push settings from Workspace tools',async()=>{
  const user=userEvent.setup();
  render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Workspace tools'}));
  await user.click(screen.getByRole('button',{name:'Remote push settings'}));
  expect(await screen.findByText('Native push registration controls')).toBeTruthy();
});
it('opens Apple status for the exact active session and routes review to agents',async()=>{
  mocks.api.connect.mockResolvedValue({sessionId:'apple-current'});
  const user=await openConnection();
  await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  await user.click(screen.getByRole('button',{name:'Apple status'}));
  expect(await screen.findByText('Apple controls for apple-current')).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Review Apple approval'}));
  expect(await screen.findByText('Agent companion')).toBeTruthy();
});
it('honors the connection shortcut and protects credential dialogs from global shortcuts',async()=>{
  const user=userEvent.setup();
  render(<App/>);
  await screen.findByRole('button',{name:'Connect to Home'});
  await user.keyboard('{Control>}n{/Control}');
  expect(screen.getByLabelText('Search saved hosts')).toBeTruthy();
  await user.click(screen.getByRole('button',{name:/Home.*dev@home.local/}));
  await user.click(screen.getByLabelText('Password'));
  await user.keyboard('{Control>}k{/Control}');
  expect(screen.queryByLabelText('Search saved hosts')).toBeNull();
  expect(screen.getByLabelText('Password')).toBeTruthy();
});
it('switches tabs by numbered shortcut and accepts gestures only from the active session',async()=>{
  mocks.api.connect.mockResolvedValueOnce({sessionId:'first'}).mockResolvedValueOnce({sessionId:'second'});
  const user=await openConnection();
  await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  await user.click(screen.getByRole('button',{name:'Connect to Home'}));
  await user.type(screen.getByLabelText('Password'),'second-secret');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  await waitFor(()=>expect(screen.getAllByRole('tab',{name:'Home'})).toHaveLength(2));
  const tabs=()=>screen.getAllByRole('tab',{name:'Home'});
  expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
  act(()=>window.dispatchEvent(new CustomEvent('lazysh-terminal-action',{detail:{sessionId:'first',action:'nextSession'}})));
  expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
  act(()=>window.dispatchEvent(new CustomEvent('lazysh-terminal-action',{detail:{sessionId:'second',action:'nextSession'}})));
  expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
  await user.keyboard('{Control>}2{/Control}');
  expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
  await user.keyboard('{Control>}o{/Control}');
  expect(screen.getByText('Switch terminal session')).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Close Switch terminal session'}));
  await user.keyboard('{Control>}w{/Control}');
  await waitFor(()=>expect(mocks.api.disconnect).toHaveBeenCalledWith('second'));
  expect(screen.getAllByRole('tab',{name:'Home'})).toHaveLength(1);
});
it('closes late Auto restoration results when the app unmounts',async()=>{
  enableTransports();
  let complete:((value:{sessionId:string})=>void)|undefined;
  mocks.api.connectMosh.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
  vi.mocked(localStorage.getItem).mockImplementation(key=>key==='lazysh.workspace.v1'?JSON.stringify([{hostId:'home',auto:autoOptions}]):null);
  const user=userEvent.setup();
  const rendered=render(<App/>);
  await screen.findByRole('button',{name:'Connect to Home'});
  await user.click(screen.getByRole('button',{name:'Restore previous workspace'}));
  await waitFor(()=>expect(mocks.api.connectMosh).toHaveBeenCalled());
  rendered.unmount();
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"verified-control"});
  await act(async()=>complete?.({sessionId:'late-restore'}));
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"late-restore"});
  expect(mocks.api.connectEt).not.toHaveBeenCalled();
});

it('waits for native capabilities before starting Auto discovery',async()=>{
  let resolveCapabilities:((value:{mosh:boolean;et:boolean})=>void)|undefined;
  mocks.invoke.mockImplementation((command:string)=>command==='transport_capabilities'?new Promise(resolve=>{resolveCapabilities=resolve;}):Promise.resolve(false));
  mocks.api.connect.mockResolvedValue({sessionId:'verified-control'});
  mocks.api.connectMosh.mockResolvedValue({sessionId:'ready-mosh'});
  const user=await openConnection();
  await user.selectOptions(screen.getByLabelText('Transport'),'auto');
  expect((screen.getByRole('button',{name:'Connect'}) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.api.connect).not.toHaveBeenCalled();
  await act(async()=>resolveCapabilities?.({mosh:true,et:true}));
  await user.click(screen.getByRole('button',{name:'Connect'}));
  expect(await screen.findByText('Auto selected Mosh.')).toBeTruthy();
});

function enableLocal() {
  mocks.invoke.mockImplementation(async(command:string)=>command==='local_capability'?{available:true,reason:'Local desktop shell'}:false);
  mocks.api.connectLocal.mockResolvedValue({sessionId:'local:desktop'});
}
it('opens an explicit local terminal without SSH authentication and hides remote tools',async()=>{
  enableLocal();const user=userEvent.setup();render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Open local terminal'}));
  expect(await screen.findByText('Live SSH terminal')).toBeTruthy();
  expect(mocks.api.connectLocal).toHaveBeenCalledTimes(1);expect(mocks.api.connect).not.toHaveBeenCalled();
  expect(screen.getByText(/Local PTY/)).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Files'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Agents'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Apple status'})).toBeNull();
  expect(screen.queryByText('Apple controls for local:desktop')).toBeNull();
  expect(localStorage.setItem).toHaveBeenCalledWith('lazysh.workspace.v1','[{"local":true}]');
  await user.click(screen.getByRole('button',{name:'Disconnect Local terminal'}));
  expect(mocks.api.disconnect).toHaveBeenCalledWith('local:desktop');
});
it('keeps the local entry unavailable when the native platform reports unsupported',async()=>{
  const user=userEvent.setup();render(<App/>);
  await screen.findByRole('button',{name:'Connect to Home'});
  expect((screen.getByRole('button',{name:'Open local terminal'}) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button',{name:'Open local terminal'}));
  expect(mocks.api.connectLocal).not.toHaveBeenCalled();
});
it('restores local intention through a fresh local PTY without a host lookup or SSH',async()=>{
  enableLocal();vi.mocked(localStorage.getItem).mockImplementation(key=>key==='lazysh.workspace.v1'?'[{"local":true}]':null);
  mocks.api.listHosts.mockResolvedValue([]);
  const user=userEvent.setup();render(<App/>);
  await waitFor(()=>expect((screen.getByRole('button',{name:'Open local terminal'}) as HTMLButtonElement).disabled).toBe(false));
  await user.click(screen.getByRole('button',{name:'Restore previous workspace'}));
  expect(await screen.findByText(/Local PTY/)).toBeTruthy();expect(mocks.api.connectLocal).toHaveBeenCalledTimes(1);
  expect(mocks.api.connect).not.toHaveBeenCalled();
});
it('disconnects a late local startup when the app closes',async()=>{
  enableLocal();let finish:((value:{sessionId:string})=>void)|undefined;
  mocks.api.connectLocal.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const user=userEvent.setup();const view=render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Open local terminal'}));
  await waitFor(()=>expect(mocks.api.connectLocal).toHaveBeenCalled());view.unmount();
  await act(async()=>finish?.({sessionId:'local:late'}));
  expect(mocks.invoke).toHaveBeenCalledWith("local_disconnect", {sessionId:"local:late"});
});

it('keeps explicit Apple sharing mounted across tool navigation and binds the selected usage to its SSH session',async()=>{
  mocks.api.connect.mockResolvedValueOnce({sessionId:'usage-one'}).mockResolvedValueOnce({sessionId:'usage-two'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  await user.click(screen.getByRole('button',{name:'Apple status'}));await user.click(screen.getByRole('button',{name:'Start test Apple sharing'}));
  await user.click(screen.getByRole('button',{name:'Usage'}));await user.click(await screen.findByRole('button',{name:'Use latest report for Watch'}));
  expect(mocks.appleProps).toHaveBeenLastCalledWith(expect.objectContaining({sessionId:'usage-one',usage:{recordedAt:'2026-10-25T12:00:00Z',freshness:'fresh',inputTokens:11,outputTokens:9,cacheReadTokens:null,cacheWriteTokens:2,observedAt:'2026-10-25T12:01:00Z',receivedAt:1792929660000}}));
  await user.click(screen.getByRole('button',{name:'Apple status'}));expect(screen.getByText('Apple sharing remains active')).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Connect to Home'}));await user.type(screen.getByLabelText('Password'),'second-secret');await user.click(screen.getByRole('button',{name:'Connect'}));
  await waitFor(()=>expect(mocks.appleProps).toHaveBeenLastCalledWith(expect.objectContaining({sessionId:'usage-two',usage:null})));
  expect(localStorage.setItem).not.toHaveBeenCalledWith('lazysh.workspace.v1',expect.stringContaining('inputTokens'));
});

async function voiceConnection(id='dictation-current'){
  mocks.api.connect.mockResolvedValue({sessionId:id});mocks.api.write.mockResolvedValue(undefined);
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');await user.click(screen.getByRole('button',{name:'Dictate'}));
  await screen.findByText(`Voice for ${id}`);
  return {user,deliver:mocks.voiceProps.mock.calls.at(-1)![0].onDirectDictation as (request:import('./voiceDelivery').DirectDictation)=>Promise<void>};
}
it('delivers one bounded final payload to the exact current terminal and lets a failed write remain failed',async()=>{
  const {deliver}=await voiceConnection();
  const claim=vi.fn().mockReturnValue(true);
  await deliver({sessionId:'dictation-current',text:'echo 世界',autoSend:true,claim});
  expect(mocks.api.write).toHaveBeenCalledExactlyOnceWith('dictation-current','echo 世界\r');expect(claim).toHaveBeenCalledOnce();
  mocks.api.write.mockRejectedValueOnce(new Error('queue full'));
  await expect(deliver({sessionId:'dictation-current',text:'second',autoSend:false,claim})).rejects.toThrow('queue full');
  expect(mocks.api.write).toHaveBeenCalledTimes(2);
});
it('rejects wrong sessions, unsafe input and foreground/generation changes before any write',async()=>{
  const {deliver}=await voiceConnection();
  const claim=vi.fn().mockReturnValue(true);
  await expect(deliver({sessionId:'other-session',text:'wrong',autoSend:true,claim})).rejects.toThrow('no longer active');expect(claim).not.toHaveBeenCalled();
  expect(()=>deliver({sessionId:'dictation-current',text:'bad\ncommand',autoSend:true,claim})).toThrow('one line');
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
  await expect(deliver({sessionId:'dictation-current',text:'hidden',autoSend:true,claim})).rejects.toThrow('no longer active');
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  claim.mockReturnValue(false);
  await expect(deliver({sessionId:'dictation-current',text:'cancelled',autoSend:true,claim})).rejects.toThrow('no longer active');
  expect(mocks.api.write).not.toHaveBeenCalled();
});
it('rejects a held callback after navigation away, disconnect, or App unmount',async()=>{
  const {deliver,user}=await voiceConnection();const request={sessionId:'dictation-current',text:'old command',autoSend:true,claim:()=>true};
  await user.click(screen.getByRole('button',{name:'Terminal'}));
  await expect(deliver(request)).rejects.toThrow('no longer active');
  await user.click(screen.getByRole('button',{name:'Dictate'}));await screen.findByText('Voice for dictation-current');
  await user.click(screen.getByRole('button',{name:'Disconnect Home'}));
  await expect(deliver(request)).rejects.toThrow('no longer active');
  cleanup();await expect(deliver(request)).rejects.toThrow('no longer active');expect(mocks.api.write).not.toHaveBeenCalled();
});
it('preserves local session identity for direct input',async()=>{
  enableLocal();mocks.api.write.mockResolvedValue(undefined);const user=userEvent.setup();render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Open local terminal'}));await screen.findByText('Live SSH terminal');
  await user.click(screen.getByRole('button',{name:'Dictate'}));await screen.findByText('Voice for local:desktop');
  await mocks.voiceProps.mock.calls.at(-1)![0].onDirectDictation({sessionId:'local:desktop',text:'pwd',autoSend:false,claim:()=>true});
  expect(mocks.api.write).toHaveBeenCalledExactlyOnceWith('local:desktop','pwd');
});

it('invalidates direct delivery synchronously on disconnect intent and never revives it after failure',async()=>{
  const {deliver,user}=await voiceConnection();
  let reject!:(error:Error)=>void;
  mocks.api.disconnect.mockImplementationOnce(()=>new Promise<void>((_resolve,fail)=>{reject=fail;}));
  const request={sessionId:'dictation-current',text:'late command',autoSend:true,claim:vi.fn().mockReturnValue(true)};
  await user.click(screen.getByRole('button',{name:'Disconnect Home'}));
  await expect(deliver(request)).rejects.toThrow('no longer active');expect(request.claim).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Disconnect Home'}));expect(mocks.api.disconnect).toHaveBeenCalledOnce();
  await user.click(await screen.findByRole('button',{name:'Workspace tools'}));
  const during=mocks.voiceProps.mock.calls.at(-1)![0].onDirectDictation;
  await user.keyboard('{Escape}');
  await act(async()=>reject(new Error('disconnect failed')));
  await expect(deliver(request)).rejects.toThrow('no longer active');
  await expect(during(request)).rejects.toThrow('no longer active');
  expect(mocks.api.write).not.toHaveBeenCalled();
  const fresh=mocks.voiceProps.mock.calls.at(-1)![0].onDirectDictation;
  await fresh({...request,text:'new recording',autoSend:false});
  expect(mocks.api.write).toHaveBeenCalledExactlyOnceWith('dictation-current','new recording');
  let rejectAgain!:(error:Error)=>void;
  mocks.api.disconnect.mockImplementationOnce(()=>new Promise<void>((_resolve,fail)=>{rejectAgain=fail;}));
  await user.click(screen.getByRole('button',{name:'Disconnect Home'}));
  await act(async()=>rejectAgain(new Error('disconnect failed')));
  await expect(fresh(request)).rejects.toThrow('no longer active');
  await mocks.voiceProps.mock.calls.at(-1)![0].onDirectDictation({...request,text:'recording after repeated failure',autoSend:false});
  expect(mocks.api.write).toHaveBeenLastCalledWith('dictation-current','recording after repeated failure');
});
