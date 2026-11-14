// @vitest-environment jsdom
// The harness registers the module mocks, so it has to be the first import.
import {autoOptions, connectAuto, enableTransports, generationBase, host, mocks, openConnection, selectConnectionTransport} from './test/appHarness';
import {expect, it, vi} from "vitest";
import {act, render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import {applyAccessStatus} from './access';

function verifiedMoshControl() {
  mocks.invoke.mockImplementation(async (command: string) => command === "transport_capabilities" ? { mosh: true } : false);
  mocks.api.connect.mockResolvedValue({ sessionId: "ssh-control" });
}

it("hands a verified SSH connection to Mosh before exposing terminal input", async () => {
  verifiedMoshControl();
  mocks.api.connectMosh.mockResolvedValue({ sessionId: "mosh-terminal" });
  const user = await openConnection();
  await selectConnectionTransport(user, "mosh");
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
  verifiedMoshControl();
  mocks.api.connectMosh.mockRejectedValue(
    new Error("Mosh UDP connection failed"),
  );
  const user = await openConnection();
  await selectConnectionTransport(user, "mosh");
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByText("Mosh UDP connection failed")).toBeTruthy();
  expect(screen.queryByText("Live SSH terminal")).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"ssh-control"});
  expect(mocks.api.connect).toHaveBeenCalledTimes(1);
});

it("cancels the SSH control session during Mosh bootstrap and closes a late result", async () => {
  verifiedMoshControl();
  let finish: ((value: { sessionId: string }) => void) | undefined;
  mocks.api.connectMosh.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const user = await openConnection();
  await selectConnectionTransport(user, "mosh");
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
  await selectConnectionTransport(user, 'et');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  expect(await screen.findByText('Live SSH terminal')).toBeTruthy();
  expect(mocks.api.connectEt).toHaveBeenCalledWith('ssh-control',{serverPath:'etterminal',port:2022},expect.any(Function));
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"ssh-control"});
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();
  expect(localStorage.setItem).toHaveBeenCalledWith('lazysh.workspace.v1',JSON.stringify([{hostId:'home',et:{serverPath:'etterminal',port:2022}}]));
});

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
  await selectConnectionTransport(user, 'et');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  expect(await screen.findByText('ET port unreachable')).toBeTruthy();
  expect(screen.queryByText('Live SSH terminal')).toBeNull();
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenCalledWith("disconnect", {sessionId:"verified-control"});
});

async function editHome() {
  mocks.api.saveHost.mockResolvedValue(host);
  const user=userEvent.setup();
  render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Edit Home'}));
  return user;
}

it('edits the named host transport and helper options through the native host API',async()=>{
  const user=await editHome();
  await user.selectOptions(screen.getByLabelText('Preferred transport'),'auto');
  await user.clear(screen.getByLabelText('Mosh server path'));
  await user.type(screen.getByLabelText('Mosh server path'),'/opt/mosh-server');
  await user.clear(screen.getByLabelText('ET server port'));
  await user.type(screen.getByLabelText('ET server port'),'2122');
  await user.click(screen.getByRole('button',{name:'Save host'}));
  await waitFor(()=>expect(mocks.api.saveHost).toHaveBeenCalledWith({...host,transport:'auto',mosh:{...autoOptions.mosh,serverPath:'/opt/mosh-server'},et:{...autoOptions.et,port:2122}}));
});

it('sends the client environment marker only after the host opts in',async()=>{
  const user=await editHome();
  const marker=screen.getByRole('checkbox',{name:'Identify lazysh to this host (LC_TERMINAL=lazysh)'});
  expect((marker as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByText(/AcceptEnv/)).toBeNull();
  await user.click(marker);
  expect(screen.getByText(/only when its AcceptEnv admits LC_TERMINAL/)).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Save host'}));
  await waitFor(()=>expect(mocks.api.saveHost).toHaveBeenCalledWith({...host,clientEnvironment:true}));
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
  await selectConnectionTransport(user, 'auto');
  expect((screen.getByRole('button',{name:'Connect'}) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.api.connect).not.toHaveBeenCalled();
  await act(async()=>resolveCapabilities?.({mosh:true,et:true}));
  await user.click(screen.getByRole('button',{name:'Connect'}));
  expect(await screen.findByText('Auto selected Mosh.')).toBeTruthy();
});

it('installs canonical Mosh rendering before early output and preserves exact pending byte acknowledgements',async()=>{
  verifiedMoshControl();
  const terminals=Array.from({length:2},()=>({write:vi.fn((_data:Uint8Array,done?:()=>void)=>done?.()),dispose:vi.fn()}));
  let index=0;mocks.createTerminal.mockImplementation(()=>terminals[index++]);
  mocks.api.connectMosh.mockImplementation(async(_id,_options,onEvent)=>{
    expect(mocks.installMoshResize).toHaveBeenCalledExactlyOnceWith(terminals[1]);
    onEvent({type:'data',data:[1,2,3]});return {sessionId:'early-mosh'};
  });
  const user=await openConnection();await selectConnectionTransport(user,'mosh');await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  expect(mocks.api.ackOutput).toHaveBeenCalledExactlyOnceWith('early-mosh',3);
  expect(terminals[1].write).toHaveBeenCalledExactlyOnceWith(new Uint8Array([1,2,3]),expect.any(Function));
  expect(terminals[0].dispose).toHaveBeenCalledOnce();
  const controller=mocks.installMoshResize.mock.results[0].value;
  await user.click(screen.getByRole('button',{name:'Disconnect Home'}));
  expect(controller.dispose).toHaveBeenCalledOnce();expect(terminals[1].dispose).toHaveBeenCalledOnce();
  expect(controller.dispose.mock.invocationCallOrder[0]).toBeLessThan(terminals[1].dispose.mock.invocationCallOrder[0]);
});

it.each(['closed','invalid'] as const)('keeps Mosh parser drain separate from terminal disposal on %s output',async branch=>{
  verifiedMoshControl();let receive!:(event:import('./bridge').SshEvent)=>void;
  mocks.api.connectMosh.mockImplementation(async(_id,_options,onEvent)=>{receive=onEvent;return {sessionId:'drained-mosh'};});
  const user=await openConnection();await selectConnectionTransport(user,'mosh');await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  const session=mocks.terminalPaneProps.mock.lastCall?.[0].session,controller=mocks.installMoshResize.mock.results[0].value;
  if(branch==='invalid')controller.failure='invalid-frame';
  await act(async()=>{receive(branch==='closed'?{type:'closed'}:{type:'data',data:[4,5]});});
  expect(session.connected).toBe(false);expect(controller.close).toHaveBeenCalledOnce();expect(controller.dispose).not.toHaveBeenCalled();
  if(branch==='invalid'){
    expect(mocks.api.disconnect.mock.calls.filter(call=>call[0]==='drained-mosh')).toHaveLength(1);
    await act(async()=>receive({type:'data',data:[6]}));
    expect(mocks.api.disconnect.mock.calls.filter(call=>call[0]==='drained-mosh')).toHaveLength(1);
  } else expect(mocks.api.disconnect.mock.calls.filter(call=>call[0]==='drained-mosh')).toHaveLength(0);
});

it('rejects unsupported canonical rendering before starting forced Mosh',async()=>{
  verifiedMoshControl();mocks.installMoshResize.mockImplementation(()=>{throw new Error('unsupported owned ABI');});
  const user=await openConnection();await selectConnectionTransport(user,'mosh');await user.click(screen.getByRole('button',{name:'Connect'}));
  await waitFor(()=>expect(mocks.terminal.dispose).toHaveBeenCalled());expect(mocks.api.connectMosh).not.toHaveBeenCalled();
  expect(screen.queryByText('Live SSH terminal')).toBeNull();expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'ssh-control'});
});

it('Auto uses its existing fallback when the local canonical Mosh renderer is unsupported',async()=>{
  enableTransports();mocks.installMoshResize.mockImplementation(()=>{throw new Error('owned unavailable ABI');});mocks.api.connectEt.mockResolvedValue({sessionId:'renderer-fallback-et'});
  await connectAuto();await screen.findByText(/Auto selected Eternal Terminal/);
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();expect(mocks.api.connectEt).toHaveBeenCalledExactlyOnceWith('verified-control',autoOptions.et,expect.any(Function));
});

it('does not renew revoked access to disconnect a locally failed Mosh display',async()=>{
  verifiedMoshControl();let receive!:(event:import('./bridge').SshEvent)=>void;
  mocks.api.connectMosh.mockImplementation(async(_id,_options,onEvent)=>{receive=onEvent;return {sessionId:'revoked-display'};});
  const user=await openConnection();await selectConnectionTransport(user,'mosh');await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  const controller=mocks.installMoshResize.mock.results[0].value;
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:true,generation:String(generationBase+2),reason:''});controller.failure='invalid-frame';
  await act(async()=>receive({type:'data',data:[9]}));
  expect(mocks.api.disconnect.mock.calls.filter(call=>call[0]==='revoked-display')).toHaveLength(0);
  expect(controller.close).toHaveBeenCalledOnce();
});
