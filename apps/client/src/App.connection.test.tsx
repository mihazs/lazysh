// @vitest-environment jsdom
// The harness registers the module mocks, so it has to be the first import.
import {chooseWorkspaceTool, host, mocks, openConnection} from './test/appHarness';
import {LocalUiError} from './i18n/localError';
import {t, uiI18n} from './i18n/core';
import {describe, expect, it, vi} from "vitest";
import {act, cleanup, render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {Host} from "./bridge";
import App, {validateHost} from "./App";

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

  it("defaults to available saved native credentials without exposing their values", async () => {
    mocks.invoke.mockImplementation(
      async (command) => command === "has_credentials",
    );
    mocks.api.connect.mockResolvedValue({ sessionId: "saved" });
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Connect to Home" }),
    );
    expect(await screen.findByLabelText("Use saved credentials")).toHaveProperty('checked',true);
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

  it('preserves manually entered credentials when the saved-credential check finishes late',async()=>{
    const original=mocks.invoke.getMockImplementation()!;
    let finish!:(saved:boolean)=>void;
    mocks.invoke.mockImplementation((command,...args)=>command==='has_credentials'?new Promise<boolean>(resolve=>{finish=resolve;}):original(command,...args));
    mocks.api.connect.mockResolvedValue({sessionId:'manual-choice'});
    const user=userEvent.setup();render(<App/>);
    await user.click(await screen.findByRole('button',{name:'Connect to Home'}));
    await user.type(await screen.findByLabelText('Password'),'manual-entry');
    await act(async()=>finish(true));
    expect(await screen.findByLabelText('Use saved credentials')).toHaveProperty('checked',false);
    expect(screen.getByLabelText('Password')).toHaveProperty('value','manual-entry');
    expect(document.activeElement).toBe(screen.getByLabelText('Password'));
    await user.click(screen.getByRole('button',{name:'Connect'}));
    await screen.findByText('Live SSH terminal');
    expect(mocks.api.connect).toHaveBeenCalledExactlyOnceWith('home',{password:'manual-entry'},expect.any(Function));
  });

  it.each(['Password','Private key'])('allows an explicit %s choice after saved credentials become the default',async method=>{
    mocks.invoke.mockImplementation(async command=>command==='has_credentials');
    const user=userEvent.setup();render(<App/>);
    await user.click(await screen.findByRole('button',{name:'Connect to Home'}));
    const saved=await screen.findByLabelText('Use saved credentials');
    expect(saved).toHaveProperty('checked',true);
    await user.click(screen.getByRole('button',{name:method}));
    expect(saved).toHaveProperty('checked',false);
    expect(screen.getByLabelText(method==='Password'?'Password':'Private key (OpenSSH or PEM)')).toBeTruthy();
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
    await chooseWorkspaceTool(user,'Sessions');
    await user.click(
      await screen.findByRole("button", { name: "Attach work" }),
    );
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(mocks.api.attachTmux).toHaveBeenCalledWith(
      "one",
      "work",
      expect.any(Function),
      undefined,
    );
    expect(mocks.api.write).not.toHaveBeenCalled();
    expect(mocks.api.disconnect).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: /^Home$/ }));
    expect(screen.getByText("Live SSH terminal")).toBeTruthy();
  });

  it.each([['exact\u00a0native name', undefined], ['exact\u00a0native name', "世界 '$(touch NO);"], [null, undefined]])('jumps inside the display and preserves restoration identity %s on server %s', async (restoreName, tmuxServer) => {
    mocks.api.connect.mockResolvedValue({sessionId:'source'});
    mocks.invoke.mockResolvedValue({tmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,tools:[{kind:'tmux',version:'3.4',support:'full',missing:[]}],sessions:[{id:'$1',name:'work',windows:[]}]});
    mocks.api.attachTmux.mockResolvedValue({sessionId:'display'});
    const snapshot={generation:'native-only-generation',current:{sessionId:'$1',windowId:'@1'},sessions:[
      {id:'$1',name:'work',restoreName:'work',windows:[{id:'@1',index:0,name:'agent'}]},
      {id:'$2',name:'destination',restoreName,windows:[{id:'@2',index:1,name:'build'}]},
    ]};
    mocks.api.tmuxJumpSnapshot.mockResolvedValue(snapshot);
    mocks.api.tmuxJump.mockResolvedValue({...snapshot,current:{sessionId:'$2',windowId:'@2'}});
    const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
    await screen.findByText('Live SSH terminal');expect(screen.queryByRole('button',{name:'Jump To'})).toBeNull();
    await chooseWorkspaceTool(user,'Sessions');
    if(tmuxServer){await user.clear(screen.getByLabelText('tmux server'));await user.type(screen.getByLabelText('tmux server'),tmuxServer);await user.click(screen.getByRole('button',{name:'Browse server'}));}
    await user.click(await screen.findByRole('button',{name:'Attach work'}));
    expect(mocks.api.attachTmux).toHaveBeenCalledWith('source','work',expect.any(Function),tmuxServer);
    await chooseWorkspaceTool(user,'Jump To');
    await user.click(await screen.findByRole('button',{name:'1: build'}).catch(error=>{
      // Failure evidence for #109; preserve the original query deadline and error.
      try {
        const dialog=document.querySelector('[role="dialog"][aria-label="Jump To"]');
        const panel=dialog?.querySelector('[aria-label="tmux Jump To"]');
        console.error('Jump To target query diagnostics', {
          dialogPresent:!!dialog,panelPresent:!!panel,
          dialogText:dialog?.textContent?.slice(0,800),
          layout:panel?.querySelector('select')?.value,
          visibleTargets:screen.queryAllByRole('button',{name:'1: build'}).length,
          includingHiddenTargets:screen.queryAllByRole('button',{name:'1: build',hidden:true}).length,
          snapshotCalls:mocks.api.tmuxJumpSnapshot.mock.calls.length,
          lastSnapshotSession:String(mocks.api.tmuxJumpSnapshot.mock.lastCall?.[0]??'').slice(0,120),
          activeTab:document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.slice(0,120),
        });
      } catch { /* Diagnostics must never replace the original test failure. */ }
      throw error;
    }));
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Jump To'})).toBeNull());
    expect(mocks.api.tmuxJump).toHaveBeenCalledWith('display','native-only-generation','$2','@2');
    expect(screen.getByRole('tab',{name:'Home / destination'})).toBeTruthy();
    expect(localStorage.setItem).toHaveBeenLastCalledWith('lazysh.workspace.v1',JSON.stringify([{hostId:'home'},...(restoreName === null ? [] : [{hostId:'home',attached:{kind:'tmux',name:restoreName,...(tmuxServer===undefined?{}:{tmuxServer})}}])]));
    if (restoreName === null) expect(screen.getByText(/This tmux destination cannot be restored/)).toBeTruthy();
    else expect(screen.queryByText(/This tmux destination cannot be restored/)).toBeNull();
    mocks.api.tmuxJumpSnapshot.mockResolvedValue({...snapshot,current:{sessionId:'$2',windowId:'@2'}});
    await chooseWorkspaceTool(user,'Jump To');
    expect(await screen.findByRole('button',{name:'1: build · Current'})).toBeTruthy();
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
  const search = await screen.findByRole("combobox", {
    name: "Search hosts, sessions and commands",
  });
  expect(document.activeElement).toBe(search);
  await user.keyboard("missing-host");
  expect(await screen.findByText("No matching hosts or commands.")).toBeTruthy();
});

it('keeps restore gated on host loading and explicit action while exposing its limitations on demand',async()=>{
  vi.mocked(localStorage.getItem).mockImplementation(key=>key==='lazysh.workspace.v1'?JSON.stringify([{hostId:'home'}]):null);
  let loaded!:(value:Host[])=>void; mocks.api.listHosts.mockImplementationOnce(()=>new Promise(resolve=>{loaded=resolve;}));
  let connected!:(value:{sessionId:string})=>void; mocks.api.connect.mockImplementationOnce(()=>new Promise(resolve=>{connected=resolve;}));
  const user=userEvent.setup(); render(<App/>);
  const restore=await screen.findByRole('button',{name:'Restore previous workspace'});
  expect(restore).toHaveProperty('disabled',true);
  const details=screen.getByRole('button',{name:'Workspace details'});
  expect(details.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText(t('appUsesSavedCredentialsTmuxAndHerdrReattachOpenZellij'))).toBeNull();
  await user.click(details);
  expect(screen.getByText(t('appUsesSavedCredentialsTmuxAndHerdrReattachOpenZellij'))).toBeTruthy();
  expect(mocks.api.connect).not.toHaveBeenCalled();
  await act(async()=>loaded([host])); await waitFor(()=>expect(restore).toHaveProperty('disabled',false));
  await user.click(restore);
  expect(screen.getByRole('button',{name:'Restoring…'})).toHaveProperty('disabled',true);
  expect(screen.getByRole('button',{name:'Dismiss'})).toHaveProperty('disabled',true);
  expect(mocks.api.connect).toHaveBeenCalledWith('home',{},expect.any(Function),{useSavedCredentials:true});
  await act(async()=>connected({sessionId:'restored-explicit'})); await screen.findByText('Live SSH terminal');
});

it('dismisses saved restoration without disconnecting or replacing the current workspace',async()=>{
  vi.mocked(localStorage.getItem).mockImplementation(key=>key==='lazysh.workspace.v1'?JSON.stringify([{hostId:'previous-host'}]):null);
  mocks.api.connect.mockResolvedValue({sessionId:'keep-current-session'});
  const user=await openConnection(); await user.click(screen.getByRole('button',{name:'Connect'})); await screen.findByText('Live SSH terminal');
  const dismiss=screen.getByRole('button',{name:'Dismiss'});
  expect(dismiss.textContent).toBe(''); expect(dismiss.querySelector('svg')).not.toBeNull();
  await user.click(dismiss);
  expect(screen.queryByRole('button',{name:'Restore previous workspace'})).toBeNull();
  expect(localStorage.setItem).toHaveBeenLastCalledWith('lazysh.workspace.v1',JSON.stringify([{hostId:'home'}]));
  expect(mocks.api.connect).toHaveBeenCalledTimes(1); expect(mocks.api.disconnect).not.toHaveBeenCalled();
  expect(screen.getByText('Live SSH terminal')).toBeTruthy();
});

it.each([undefined, "agents"])("restores the exact tmux workspace on server %s without sending shell text", async tmuxServer => {
  vi.mocked(localStorage.getItem).mockReturnValue(
    JSON.stringify([
      { hostId: "home", attached: { kind: "tmux", name: "durable-agent", ...(tmuxServer===undefined?{}:{tmuxServer}) } },
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
    tmuxServer,
  );
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"temporary-shell"});
  expect(mocks.api.write).not.toHaveBeenCalled();
  expect(localStorage.setItem).toHaveBeenLastCalledWith(
    "lazysh.workspace.v1",
    JSON.stringify([
      { hostId: "home", attached: { kind: "tmux", name: "durable-agent", ...(tmuxServer===undefined?{}:{tmuxServer}) } },
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

async function openPendingKeyExport(exporter: () => Promise<unknown>) {
  mocks.api.listHosts.mockResolvedValue([{ ...host, biometricUnlock: true, credentialsStored: true }]);
  mocks.invoke.mockImplementation((command: string) => command === "export_saved_identity" ? exporter() : Promise.resolve(command === "has_credentials"));
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "Connect to Home" }));
  await user.click(screen.getByRole("button", { name: "Export private key with biometrics" }));
  return user;
}

it("allows cancellation while private key authentication is pending", async () => {
  const user = await openPendingKeyExport(() => new Promise(() => {}));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.invoke).toHaveBeenCalledWith("cancel_credential_auth", undefined, { headers: { "X-Lazysh-Access": expect.any(String) } });
  expect(
    screen.queryByRole("button", {
      name: "Export private key with biometrics",
    }),
  ).toBeNull();
});

it("clears exported keys on background and rejects a late authentication result", async () => {
  let resolveExport: ((value: { privateKey: string }) => void) | undefined;
  const user = await openPendingKeyExport(() => new Promise(resolve => { resolveExport = resolve; }));
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

function enableLocal() {
  mocks.invoke.mockImplementation(async(command:string)=>command==='local_capability'?{available:true,reason:'Local desktop shell'}:false);
  mocks.api.connectLocal.mockResolvedValue({sessionId:'local:desktop'});
}

it.each(['preparation','native'] as const)('interprets launch codes only at the native connect boundary: %s',async source=>{
  enableLocal();
  const receipt='7b6d0fc9-a755-4e10-b2e3-0dbdc1259326';
  mocks.launchReceipt=receipt;
  if(source==='preparation')mocks.prepareError='LOCAL_LAUNCH_UNAVAILABLE';
  else mocks.api.connectLocal.mockRejectedValueOnce('LOCAL_LAUNCH_UNAVAILABLE');
  render(<App/>);
  const alert=await screen.findByRole('alert');
  expect(alert.querySelector('span')?.textContent).toBe(source==='preparation'?'LOCAL_LAUNCH_UNAVAILABLE':'This launch request is no longer available. Run the command again.');
  if(source==='preparation')expect(mocks.api.connectLocal).not.toHaveBeenCalled();
  else expect(mocks.api.connectLocal).toHaveBeenCalledExactlyOnceWith(expect.any(Function),receipt);
});

it('opens an explicit local terminal without SSH authentication and hides remote tools',async()=>{
  enableLocal();const user=userEvent.setup();render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Open local terminal'}));
  expect(await screen.findByText('Live SSH terminal')).toBeTruthy();
  expect(mocks.api.connectLocal).toHaveBeenCalledTimes(1);expect(mocks.api.connect).not.toHaveBeenCalled();
  expect(mocks.api.connectLocal).toHaveBeenCalledWith(expect.any(Function));
  expect(screen.getByText(/Local PTY/)).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Files'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Agents'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Apple status'})).toBeNull();
  expect(screen.queryByText('Apple controls for local:desktop')).toBeNull();
  expect(mocks.accountUsageSession).toHaveBeenLastCalledWith('local:desktop');
  await user.click(screen.getByRole('button',{name:'Open AI account usage'}));
  expect(await screen.findByRole('region',{name:'AI account usage'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Use latest report for Watch'})).toBeNull();
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
  expect(mocks.api.connectLocal).toHaveBeenCalledWith(expect.any(Function));
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
  await chooseWorkspaceTool(user,'Apple status');await user.click(screen.getByRole('button',{name:'Start test Apple sharing'}));
  await chooseWorkspaceTool(user,'Usage');await user.click(await screen.findByRole('button',{name:'Use latest report for Watch'}));
  expect(mocks.appleProps).toHaveBeenLastCalledWith(expect.objectContaining({sessionId:'usage-one',usage:{recordedAt:'2026-10-25T12:00:00Z',freshness:'fresh',inputTokens:11,outputTokens:9,cacheReadTokens:null,cacheWriteTokens:2,observedAt:'2026-10-25T12:01:00Z',receivedAt:1792929660000}}));
  await chooseWorkspaceTool(user,'Apple status');expect(screen.getByText('Apple sharing remains active')).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Connect to Home'}));await user.type(screen.getByLabelText('Password'),'second-secret');await user.click(screen.getByRole('button',{name:'Connect'}));
  await waitFor(()=>expect(mocks.appleProps).toHaveBeenLastCalledWith(expect.objectContaining({sessionId:'usage-two',usage:null})));
  expect(localStorage.setItem).not.toHaveBeenCalledWith('lazysh.workspace.v1',expect.stringContaining('inputTokens'));
});

async function voiceConnection(id='dictation-current'){
  mocks.api.connect.mockResolvedValue({sessionId:id});mocks.api.write.mockResolvedValue(undefined);
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');await chooseWorkspaceTool(user,'Dictate');
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
  await chooseWorkspaceTool(user,'Terminal');
  await expect(deliver(request)).rejects.toThrow('no longer active');
  await chooseWorkspaceTool(user,'Dictate');await screen.findByText('Voice for dictation-current');
  await user.click(screen.getByRole('button',{name:'Disconnect Home'}));
  await expect(deliver(request)).rejects.toThrow('no longer active');
  cleanup();await expect(deliver(request)).rejects.toThrow('no longer active');expect(mocks.api.write).not.toHaveBeenCalled();
});

it('preserves local session identity for direct input',async()=>{
  enableLocal();mocks.api.write.mockResolvedValue(undefined);const user=userEvent.setup();render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Open local terminal'}));await screen.findByText('Live SSH terminal');
  await chooseWorkspaceTool(user,'Dictate');await screen.findByText('Voice for local:desktop');
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

it('retains only class-branded global failures across locales and preserves every other payload conversion',async()=>{
  render(<App/>);await screen.findByRole('button',{name:'Connect to Home'});
  try{
    act(()=>{window.dispatchEvent(new CustomEvent('lazysh-error',{detail:new LocalUiError('shareCompletedWhileClosing')}));});
    for(const locale of ['pt-BR','es','en']){await act(async()=>{await uiI18n.changeLanguage(locale);});expect(screen.getByRole('alert').textContent).toContain(t('shareCompletedWhileClosing'));}
    for(const detail of ['shareCompletedWhileClosing <raw> {{name}}',{key:'shareCompletedWhileClosing',message:'Never trust this key'}]){
      act(()=>{window.dispatchEvent(new CustomEvent('lazysh-error',{detail}));});
      for(const locale of ['pt-BR','es','en']){await act(async()=>{await uiI18n.changeLanguage(locale);});expect(screen.getByRole('alert').textContent).toContain(String(detail));expect(screen.getByRole('alert').textContent).not.toContain('Never trust this key');}
    }
  }finally{await act(async()=>{await uiI18n.changeLanguage('en');});}
});

it('does not restore a Herdr session when its version lacks restore support', async () => {
  vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify([{hostId:'home',attached:{kind:'herdr',name:'work'}}]));
  mocks.api.connect.mockResolvedValue({sessionId:'temporary-shell'});
  const original=mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command,...args)=>command==='multiplexer_tree' ? Promise.resolve({tmuxAvailable:false,herdrAvailable:true,zellijAvailable:false,tools:[{kind:'herdr',version:'0.8.2',support:'degraded',missing:['restore']}],sessions:[]}) : original(command,...args));
  const user=userEvent.setup();render(<App/>);
  await screen.findByRole('button',{name:'Connect to Home'});
  await user.click(screen.getByRole('button',{name:'Restore previous workspace'}));
  expect(await screen.findByText(/Only navigation is available/)).toBeTruthy();
  expect(mocks.api.attachMultiplexer).not.toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'temporary-shell'});
});

it('restores a Herdr session when discovery confirms restore support', async () => {
  vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify([{hostId:'home',attached:{kind:'herdr',name:'work'}}]));
  mocks.api.connect.mockResolvedValue({sessionId:'temporary-shell'});
  mocks.api.attachMultiplexer.mockResolvedValue({sessionId:'restored-herdr'});
  const original=mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command,...args)=>command==='multiplexer_tree' ? Promise.resolve({tmuxAvailable:false,herdrAvailable:true,zellijAvailable:false,tools:[{kind:'herdr',version:'0.9.5',support:'full',missing:[]}],sessions:[]}) : original(command,...args));
  const user=userEvent.setup();render(<App/>);
  await screen.findByRole('button',{name:'Connect to Home'});
  await user.click(screen.getByRole('button',{name:'Restore previous workspace'}));
  await waitFor(()=>expect(mocks.api.attachMultiplexer).toHaveBeenCalledWith('temporary-shell','herdr','work',expect.any(Function)));
  expect(await screen.findByText('Live SSH terminal')).toBeTruthy();
});
