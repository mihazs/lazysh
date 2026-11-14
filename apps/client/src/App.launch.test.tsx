// @vitest-environment jsdom
// The harness registers the module mocks, so it has to be the first import.
import {autoOptions, chooseWorkspaceTool, enableTransports, generationBase, host, mocks, openConnection, selectConnectionTransport, unlockedStatus} from './test/appHarness';
import {t, uiI18n} from './i18n/core';
import {expect, it, vi} from "vitest";
import {act, render, screen, waitFor, within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {Host, TransportMode} from "./bridge";
import type {DesktopMux} from './useDesktopLaunch';
import {tmuxJumpSnapshot as navigationSnapshot} from './test/tmuxJumpData';
import App, {ConnectDialog} from "./App";
import {applyAccessStatus, captureAccess} from './access';

const hostLaunchReceipt='7b6d0fc9-a755-4e10-b2e3-0dbdc1259326';

function enableHostLaunch(selected:Host=host, jump?:Host, mux:unknown=null) {
  mocks.hostLaunchReceipt=hostLaunchReceipt;
  mocks.api.listHosts.mockResolvedValue([selected]);
  mocks.invoke.mockImplementation(async(command:string)=>{
    if(command==='local_capability')return {available:true,reason:'Desktop fixture'};
    if(command==='desktop_launch_prepare_host')return {hosts:jump?[selected,jump]:[selected],mux};
    if(command==='desktop_launch_cancel')return;
    if(command==='transport_capabilities')return {mosh:true,et:true};
    return false;
  });
}

function enableMuxLaunch(mux:DesktopMux,transport:TransportMode='ssh') {
  enableHostLaunch({...host,transport},undefined,mux);
  const invoke=mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async(command,...args)=>command==='multiplexer_tree'?{tmuxAvailable:true,herdrAvailable:true,zellijAvailable:true,tools:[{kind:'herdr',version:'0.9.5',support:'full',missing:[]}],sessions:[{id:'$1',name:'chosen',windows:[]}]}:command==='multiplexer_sessions'?[{name:'herd'}]:invoke(command,...args));
  mocks.api.connect.mockResolvedValue({sessionId:'mux-control'});
  mocks.api.attachTmux.mockResolvedValue({sessionId:'mux-attached'});mocks.api.attachMultiplexer.mockResolvedValue({sessionId:'mux-attached'});
}

it('opens the exact saved host through its normal dialog and binds the native receipt to explicit authentication',async()=>{
  enableHostLaunch({...host,id:'legacy=host 世界'});
  mocks.api.connect.mockResolvedValue({sessionId:'host-launch-ssh'});
  const user=userEvent.setup();render(<App/>);
  await screen.findByRole('dialog',{name:'Connect to Home'});
  expect(mocks.api.connect).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText('Password'),'entered-only-here');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  expect(mocks.api.connect).toHaveBeenCalledWith('legacy=host 世界',{password:'entered-only-here'},expect.any(Function),{launchReceipt:hostLaunchReceipt});
});

it('defers a warm saved-host launch without replacing a manual password dialog',async()=>{
  const warm={...host,id:'warm',name:'Warm destination'};
  enableHostLaunch(warm);mocks.hostLaunchReceipt=null;mocks.api.listHosts.mockResolvedValue([host,warm]);
  const user=userEvent.setup();render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Connect to Home'}));
  await user.type(await screen.findByLabelText('Password'),'manual-value');
  await act(async()=>{mocks.hostLaunchReceipt=hostLaunchReceipt;mocks.launchEvent?.({payload:null});});
  expect(screen.getByRole('dialog',{name:'Connect to Home'})).toBeTruthy();
  expect(screen.getByLabelText('Password')).toHaveProperty('value','manual-value');
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='desktop_launch_prepare_host')).toHaveLength(0);
  await user.click(screen.getByRole('button',{name:'Cancel'}));
  await screen.findByRole('dialog',{name:'Connect to Warm destination'});
  expect(screen.getByLabelText('Password')).toHaveProperty('value','');
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='desktop_launch_prepare_host')).toHaveLength(1);
  expect(mocks.api.connect).not.toHaveBeenCalled();
});

it.each([
  ['HOST_LAUNCH_MISSING','This saved host no longer exists. Copy an existing host ID and run the command again.'],
  ['HOST_LAUNCH_AMBIGUOUS','More than one saved host has this ID. Resolve the duplicate before trying again.'],
])('reports native host preparation failure without opening a connection: %s',async(code,message)=>{
  enableHostLaunch();
  const prepare=mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command,...args)=>command==='desktop_launch_prepare_host'?Promise.reject(code):prepare(command,...args));
  render(<App/>);expect((await screen.findByRole('alert')).textContent).toContain(message);
  expect(screen.queryByRole('dialog')).toBeNull();expect(mocks.api.connect).not.toHaveBeenCalled();
});

it.each(['preparation','native'] as const)('brands a finite saved-host failure only at its native await, preserving raw %s errors',async origin=>{
  enableHostLaunch();
  if(origin==='preparation')mocks.prepareError='HOST_LAUNCH_CHANGED';
  else mocks.api.connect.mockRejectedValue({kind:'HOST_LAUNCH_CHANGED',message:'HOST_LAUNCH_CHANGED'});
  const user=userEvent.setup();render(<App/>);await screen.findByLabelText('Password');
  await user.type(screen.getByLabelText('Password'),'entry');await user.click(screen.getByRole('button',{name:'Connect'}));
  try {
    for(const locale of ['en','pt-BR','es']) {
      await act(async()=>{await uiI18n.changeLanguage(locale);});
      const expected=origin==='preparation'?'HOST_LAUNCH_CHANGED':t('desktopLaunchHostChanged');
      expect((await screen.findByRole('alert')).textContent).toBe(expected);
    }
  } finally {await act(async()=>{await uiI18n.changeLanguage('en');});}
  if(origin==='preparation')expect(mocks.api.connect).not.toHaveBeenCalled();
});

it.each([
  ['mosh',{kind:'tmux',tmuxServer:'default'}],
  ['et',{kind:'tmux',tmuxServer:"世界 '$(touch NO);"}],
  ['auto',{kind:'herdr'}],
] as const)('opens a cold mux picker on its exact SSH source without applying saved %s transport',async(transport,mux)=>{
  enableMuxLaunch(mux,transport);
  const user=userEvent.setup();render(<App/>);const selector=await screen.findByLabelText('Transport');
  expect(selector).toHaveProperty('value','ssh');expect(selector).toHaveProperty('disabled',true);
  await user.type(screen.getByLabelText('Password'),'explicit-entry');await user.click(screen.getByRole('button',{name:'Connect'}));
  const label=mux.kind==='herdr'?'Attach herdr herd':'Attach chosen';
  const row=await screen.findByRole('button',{name:label});
  expect(mocks.api.connect).toHaveBeenCalledExactlyOnceWith('home',{password:'explicit-entry'},expect.any(Function),{launchReceipt:hostLaunchReceipt});
  expect(mocks.api.attachTmux).not.toHaveBeenCalled();expect(mocks.api.attachMultiplexer).not.toHaveBeenCalled();
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();expect(mocks.api.connectEt).not.toHaveBeenCalled();
  await user.click(row);await waitFor(()=>expect(screen.getAllByRole('tab')).toHaveLength(2));
  if(mux.kind==='herdr')expect(mocks.api.attachMultiplexer).toHaveBeenCalledWith('mux-control','herdr','herd',expect.any(Function));
  else expect(mocks.api.attachTmux).toHaveBeenCalledWith('mux-control','chosen',expect.any(Function),mux.tmuxServer==='default'?undefined:mux.tmuxServer);
  expect(mocks.api.write).not.toHaveBeenCalled();expect(mocks.api.saveHost).not.toHaveBeenCalled();
});

it('binds a newly offered mux picker to its new SSH control rather than the already active session',async()=>{
  enableMuxLaunch({kind:'tmux',tmuxServer:'agents'});mocks.hostLaunchReceipt=null;
  mocks.api.connect.mockResolvedValueOnce({sessionId:'old-active'}).mockResolvedValueOnce({sessionId:'new-exact-source'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  mocks.hostLaunchReceipt=hostLaunchReceipt;await act(async()=>{mocks.launchEvent!({payload:null});});
  await screen.findByLabelText('Password');await user.type(screen.getByLabelText('Password'),'second-entry');
  await user.click(screen.getByRole('button',{name:'Connect'}));const row=await screen.findByRole('button',{name:'Attach chosen'});
  expect(mocks.invoke).toHaveBeenCalledWith('multiplexer_tree',{sessionId:'new-exact-source',tmuxServer:'agents'},expect.anything());
  await chooseWorkspaceTool(user,'Terminal');await screen.findByText('Live SSH terminal');
  expect(mocks.api.disconnect).not.toHaveBeenCalled();expect(mocks.api.attachTmux).not.toHaveBeenCalled();
  await chooseWorkspaceTool(user,'Sessions');await screen.findByRole('button',{name:'Attach chosen'});
  expect(screen.getByLabelText('tmux server')).toHaveProperty('value','agents');
  await user.click(screen.getByRole('button',{name:'Attach chosen'}));
  await waitFor(()=>expect(mocks.api.attachTmux).toHaveBeenCalledWith('new-exact-source','chosen',expect.any(Function),'agents'));
  expect(mocks.api.write).not.toHaveBeenCalled();
  expect(localStorage.setItem).toHaveBeenLastCalledWith('lazysh.workspace.v1',JSON.stringify([{hostId:'home'},{hostId:'home'},{hostId:'home',attached:{kind:'tmux',name:'chosen',tmuxServer:'agents'}}]));
});

it.each(['success','failure'] as const)('drops a held cold-mux SSH %s across lock/reunlock without starting a picker or child',async outcome=>{
  enableMuxLaunch({kind:'herdr'});
  let finish!:(value:{sessionId:string})=>void,fail!:(reason:unknown)=>void;
  mocks.api.connect.mockImplementationOnce(()=>new Promise((yes,no)=>{finish=yes;fail=no;}));
  const user=userEvent.setup();render(<App/>);await screen.findByLabelText('Password');await user.type(screen.getByLabelText('Password'),'entry');
  await user.click(screen.getByRole('button',{name:'Connect'}));await waitFor(()=>expect(mocks.api.connect).toHaveBeenCalledTimes(1));
  await act(async()=>{
    mocks.lockEvent!({payload:{...unlockedStatus(),enabled:true,locked:true,generation:String(generationBase+1),nonce:undefined}});
    mocks.lockEvent!({payload:{...unlockedStatus(),enabled:true,generation:String(generationBase+2),nonce:'b'.repeat(64)}});
    if(outcome==='success')finish({sessionId:'obsolete-mux-control'});else fail({kind:'unknown_host_key',fingerprint:'SHA256:obsolete',message:'Old key'});
  });
  await screen.findByRole('button',{name:'Connect to Home'});
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='multiplexer_tree'||command==='multiplexer_sessions')).toHaveLength(0);
  expect(mocks.api.attachTmux).not.toHaveBeenCalled();expect(mocks.api.attachMultiplexer).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();expect(screen.queryByRole('alert')).toBeNull();
  if(outcome==='success')await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'obsolete-mux-control'}));
});

it.each([null,{kind:'tmux',tmuxServer:'trusted-server'}] as const)('reuses the original saved-host receipt only after an explicit host-key trust retry with mux %j',async mux=>{
  if(mux)enableMuxLaunch(mux);else enableHostLaunch();
  mocks.api.connect.mockRejectedValueOnce({kind:'unknown_host_key',fingerprint:'SHA256:launch',message:'Verify key'}).mockResolvedValue({sessionId:'host-trusted'});
  const user=userEvent.setup();render(<App/>);
  await screen.findByRole('dialog',{name:'Connect to Home'});
  await user.type(screen.getByLabelText('Password'),'entered-credential');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('SHA256:launch');
  expect(mocks.api.connect).toHaveBeenCalledTimes(1);
  if(mux)expect(mocks.invoke.mock.calls.filter(([command])=>command==='multiplexer_tree'||command==='multiplexer_sessions')).toHaveLength(0);
  expect(mocks.api.trustHostKey).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Trust key and connect'}));
  if(mux)await screen.findByRole('button',{name:'Attach chosen'});else await screen.findByText('Live SSH terminal');
  expect(mocks.api.trustHostKey).toHaveBeenCalledWith(host.id,'SHA256:launch',hostLaunchReceipt);
  if(mux)expect(mocks.invoke).toHaveBeenCalledWith('multiplexer_tree',{sessionId:'host-trusted',tmuxServer:'trusted-server'},expect.anything());
  expect(mocks.api.connect).toHaveBeenCalledTimes(2);
  for(const call of mocks.api.connect.mock.calls)expect(call[3]).toEqual({launchReceipt:hostLaunchReceipt});
});

it('retires a saved-host request only on explicit cancellation, not mount setup',async()=>{
  enableHostLaunch();const user=userEvent.setup();render(<App/>);
  await screen.findByRole('dialog',{name:'Connect to Home'});
  expect(mocks.invoke.mock.calls.some(([name])=>name==='desktop_launch_cancel')).toBe(false);
  await user.click(screen.getByRole('button',{name:'Cancel'}));
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  expect(mocks.invoke).toHaveBeenCalledWith('desktop_launch_cancel',{receipt:hostLaunchReceipt},{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
  expect(mocks.api.connect).not.toHaveBeenCalled();
});

it.each(['mosh','et','auto','ssh'] as const)('retains the saved %s transport and the receipt on initial native authentication',async transport=>{
  enableHostLaunch({...host,transport});
  mocks.api.connect.mockResolvedValue({sessionId:'bound-ssh-control'});
  mocks.api.connectMosh.mockResolvedValue({sessionId:'bound-mosh'});
  mocks.api.connectEt.mockResolvedValue({sessionId:'bound-et'});
  const user=userEvent.setup();render(<App/>);
  const selector=await screen.findByLabelText('Transport');
  await waitFor(()=>expect((screen.getByRole('button',{name:'Connect'}) as HTMLButtonElement).disabled).toBe(false));
  expect((selector as HTMLSelectElement).value).toBe(transport);
  await user.type(screen.getByLabelText('Password'),'entered');await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  expect(mocks.api.connect).toHaveBeenCalledWith(host.id,{password:'entered'},expect.any(Function),{launchReceipt:hostLaunchReceipt});
  expect(mocks.api.connectMosh).toHaveBeenCalledTimes(transport==='mosh'||transport==='auto'?1:0);
  expect(mocks.api.connectEt).toHaveBeenCalledTimes(transport==='et'?1:0);
});

it.each(['remember','saved','jump'] as const)('keeps the launch receipt in the %s credential option branch',async branch=>{
  const selected=branch==='jump'?{...host,jumpHostId:'bastion'}:host;
  enableHostLaunch(selected,branch==='jump'?{...host,id:'bastion',name:'Bastion',hostname:'jump.local'}:undefined);
  if(branch==='saved')mocks.invoke.mockImplementation(async command=>command==='local_capability'?{available:true,reason:''}:command==='desktop_launch_prepare_host'?{hosts:[host]}:command==='has_credentials'?true:{mosh:true,et:true});
  mocks.api.connect.mockResolvedValue({sessionId:'branch-session'});
  const user=userEvent.setup();render(<App/>);await screen.findByRole('dialog',{name:'Connect to Home'});
  if(branch==='remember')await user.click(screen.getByLabelText('Save credentials on this device after connecting'));
  else if(branch==='saved')expect(await screen.findByLabelText('Use saved credentials')).toHaveProperty('checked',true);
  else {await user.click(screen.getByLabelText('Use bastion’s saved credentials'));await user.type(screen.getByLabelText('Bastion password'),'jump-entry');}
  if(branch!=='saved')await user.type(screen.getByLabelText('Password'),'target-entry');
  await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  const options=mocks.api.connect.mock.calls[0][3];expect(options.launchReceipt).toBe(hostLaunchReceipt);
  expect(options).toMatchObject(branch==='remember'?{rememberCredentials:true}:branch==='saved'?{useSavedCredentials:true}:{jumpCredentials:{password:'jump-entry'}});
});

function holdSshAcrossRevocation() {
  let finish!:(value:{sessionId:string})=>void;
  mocks.api.connect.mockImplementation((_id,_credentials,onEvent)=>{
    onEvent({type:'data',data:[120]});
    return new Promise(resolve=>{finish=resolve;});
  });
  mocks.api.connectMosh.mockResolvedValue({sessionId:'forbidden-mosh-child'});
  mocks.api.connectEt.mockResolvedValue({sessionId:'forbidden-et-child'});
  mocks.api.ackOutput.mockImplementationOnce(async()=>{
    mocks.lockEvent!({payload:{...unlockedStatus(),enabled:true,locked:true,generation:String(generationBase+1),nonce:undefined}});
    mocks.lockEvent!({payload:{...unlockedStatus(),enabled:true,locked:false,generation:String(generationBase+2),nonce:'b'.repeat(64)}});
  });
  return async()=>{
    await act(async()=>{finish({sessionId:'held-original-ssh'});});
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'held-original-ssh'}));
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.api.connectMosh).not.toHaveBeenCalled();expect(mocks.api.connectEt).not.toHaveBeenCalled();
    expect(mocks.api.adoptSession).not.toHaveBeenCalled();
  };
}

it.each(['mosh','et'] as const)('does not renew a held saved-host SSH result before %s child work after revoke/reunlock',async transport=>{
  enableHostLaunch({...host,transport});
  const complete=holdSshAcrossRevocation();
  const user=userEvent.setup();render(<App/>);await screen.findByLabelText('Password');
  await user.type(screen.getByLabelText('Password'),'entry');await user.click(screen.getByRole('button',{name:'Connect'}));
  await waitFor(()=>expect(mocks.api.connect).toHaveBeenCalledTimes(1));
  await complete();
});

it('keeps workspace restoration receipt-free and stops transport child work under its original lease',async()=>{
  enableTransports();
  vi.mocked(localStorage.getItem).mockImplementation(key=>key==='lazysh.workspace.v1'?JSON.stringify([{hostId:'home',auto:autoOptions}]):null);
  const complete=holdSshAcrossRevocation();
  const user=userEvent.setup();render(<App/>);await screen.findByRole('button',{name:'Connect to Home'});
  await user.click(screen.getByRole('button',{name:'Restore previous workspace'}));
  await waitFor(()=>expect(mocks.api.connect).toHaveBeenCalledWith('home',{},expect.any(Function),{useSavedCredentials:true}));
  await complete();
});

it.each([
  {kind:'unknown_host_key',fingerprint:'SHA256:obsolete-launch-key',message:'Obsolete key prompt'},
  {kind:'auth',message:'Obsolete credential failure'},
])('does not publish a stale $kind result into the same mounted launch dialog',async failure=>{
  applyAccessStatus(unlockedStatus());
  const launch={receipt:hostLaunchReceipt,lease:captureAccess(),hosts:[host],mux:null};
  let reject!:(error:unknown)=>void;
  mocks.api.connect.mockImplementation(()=>new Promise((_yes,no)=>{reject=no;}));
  const connected=vi.fn(),close=vi.fn();
  const user=userEvent.setup();render(<ConnectDialog host={host} hosts={[host]} launch={launch} connected={connected} close={close}/>);
  await user.type(screen.getByLabelText('Password'),'original-entry');await user.click(screen.getByRole('button',{name:'Connect'}));
  await waitFor(()=>expect(mocks.api.connect).toHaveBeenCalledTimes(1));
  await act(async()=>{
    applyAccessStatus({...unlockedStatus(),enabled:true,locked:true,generation:String(generationBase+1),nonce:undefined});
    applyAccessStatus({...unlockedStatus(),enabled:true,generation:String(generationBase+2),nonce:'b'.repeat(64)});
    reject(failure);
  });
  await waitFor(()=>expect(mocks.terminal.dispose).toHaveBeenCalled());
  expect(screen.getByRole('dialog',{name:'Connect to Home'})).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();expect(screen.queryByText('SHA256:obsolete-launch-key')).toBeNull();
  expect((screen.getByRole('button',{name:t('appConnecting')}) as HTMLButtonElement).disabled).toBe(true);
  expect(connected).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
  expect(mocks.api.trustHostKey).not.toHaveBeenCalled();expect(mocks.api.connect).toHaveBeenCalledTimes(1);
});

it('copies only the saved host ID on an explicit edit-dialog action and translates its status',async()=>{
  const user=userEvent.setup();
  const write=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{value:{writeText:write},configurable:true});
  render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Edit Home'}));
  expect((screen.getByLabelText('Host ID') as HTMLInputElement).value).toBe(host.id);
  expect(write).not.toHaveBeenCalled();await user.click(screen.getByRole('button',{name:'Copy host ID'}));
  await screen.findByText('Host ID copied.');expect(write).toHaveBeenCalledExactlyOnceWith(host.id);
  try {await act(async()=>{await uiI18n.changeLanguage('pt-BR');});expect(screen.getByRole('status').textContent).toBe('ID do host copiado.');}
  finally {await act(async()=>{await uiI18n.changeLanguage('en');});}
});

it('keeps the existing terminal session while clearing tool views across native lock', async () => {
  mocks.api.connect.mockResolvedValue({sessionId:'retained-ssh'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  await chooseWorkspaceTool(user,'Transcript');
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
  await user.type(screen.getByLabelText('Password'),'second-secret');await selectConnectionTransport(user, 'auto');
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

it('asks for Android notification permission only after the connected session is adopted',async()=>{
  const userAgent=vi.spyOn(navigator,'userAgent','get').mockReturnValue('Android');
  try {
    mocks.api.connect.mockResolvedValue({sessionId:'android-prompt'});
    let adopted!:()=>void;
    mocks.api.adoptSession.mockReturnValue(new Promise<void>(resolve=>{adopted=resolve;}));
    const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
    await screen.findByText('Live SSH terminal');await waitFor(()=>expect(mocks.api.adoptSession).toHaveBeenCalledWith('android-prompt'));
    expect(mocks.invoke).not.toHaveBeenCalledWith('request_notification_permission',undefined,expect.anything());
    await act(async()=>adopted());
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('request_notification_permission',undefined,expect.anything()));
  } finally {userAgent.mockRestore();}
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

it('keeps explicit desktop host launch semantics ahead of the saved default',async()=>{
  enableHostLaunch({...host,defaultMultiplexer:{kind:'herdr',name:'saved'}});
  mocks.api.connect.mockResolvedValue({sessionId:'explicit-host'});
  const user=userEvent.setup();render(<App/>);
  await user.type(await screen.findByLabelText('Password'),'explicit');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  expect(mocks.api.attachDefaultMultiplexer).not.toHaveBeenCalled();
  expect(mocks.api.connect).toHaveBeenCalledWith(host.id,{password:'explicit'},expect.any(Function),{launchReceipt:hostLaunchReceipt});
});

it('keeps late picker cleanup scoped while a new source is busy, then admits queued CLI intent once the wide picker is idle',async()=>{
  enableHostLaunch({...host,defaultMultiplexer:{kind:'tmux',name:'work'}});mocks.hostLaunchReceipt=null;
  const original=mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command,...args)=>command==='multiplexer_tree'?Promise.resolve({tmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,tools:[{kind:'tmux',version:'3.4',support:'full',missing:[]}],sessions:[{id:'$1',name:'other',windows:[]}]}):original(command,...args));
  mocks.api.connect.mockResolvedValue({sessionId:'nav-control'});
  mocks.api.attachDefaultMultiplexer.mockResolvedValue({sessionId:'nav-display-a'});
  mocks.api.attachTmux.mockResolvedValue({sessionId:'nav-display-b'});
  const pending=new Map<string,(value:typeof navigationSnapshot)=>void>();
  mocks.api.tmuxJumpSnapshot.mockImplementation(id=>new Promise(resolve=>pending.set(id,resolve)));
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  await chooseWorkspaceTool(user,'Jump To');await waitFor(()=>expect(pending.has('nav-display-a')).toBe(true));
  // The bootstrap is retired by direct entry. Open a second owned display through the existing manager.
  await user.click(screen.getByRole('button',{name:'Open session manager'}));
  await user.click(await screen.findByRole('button',{name:'Attach other'}));
  await chooseWorkspaceTool(user,'Jump To');await waitFor(()=>expect(pending.has('nav-display-b')).toBe(true));
  mocks.hostLaunchReceipt=hostLaunchReceipt;await act(async()=>{mocks.launchEvent!({payload:null});});
  expect(screen.queryByRole('dialog',{name:'Connect to Home'})).toBeNull();
  await act(async()=>{pending.get('nav-display-a')!(navigationSnapshot);});
  expect(screen.queryByRole('dialog',{name:'Connect to Home'})).toBeNull();
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='desktop_launch_prepare_host')).toHaveLength(0);
  await act(async()=>{pending.get('nav-display-b')!(navigationSnapshot);});
  await screen.findByRole('dialog',{name:'Connect to Home'});
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='desktop_launch_prepare_host')).toHaveLength(1);
  expect(mocks.api.attachTmux).toHaveBeenCalledWith('nav-display-a','other',expect.any(Function),undefined);
});

it('keeps a requested desktop mux manager and its lease while workspace navigation is unavailable',async()=>{
  enableMuxLaunch({kind:'tmux',tmuxServer:'default'});
  const user=userEvent.setup();render(<App/>);await user.type(await screen.findByLabelText('Password'),'entry');await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByRole('button',{name:'Attach chosen'});
  expect(screen.getByRole('button',{name:'Workspaces'})).toHaveProperty('disabled',true);
  expect(screen.getByRole('button',{name:'Agents navigation'})).toHaveProperty('disabled',true);
  await user.click(screen.getByRole('button',{name:'Workspace tools'}));
  expect(within(screen.getByRole('dialog',{name:'Workspace tools'})).getByRole('button',{name:'Agents'})).toHaveProperty('disabled',true);
  expect(mocks.api.tmuxJumpSnapshot).not.toHaveBeenCalled();
  expect(mocks.api.attachTmux).not.toHaveBeenCalled();
  expect(mocks.api.connect).toHaveBeenCalledWith(host.id,{password:'entry'},expect.any(Function),{launchReceipt:hostLaunchReceipt});
});

it.each([
  {name:'restored',response:{schemaVersion:1,status:'restored'},valid:true},
  {name:'missing',response:undefined,valid:false},
  {name:'wrong schema',response:{schemaVersion:2,status:'restored'},valid:false},
  {name:'uncertain status',response:{schemaVersion:1,status:'uncertain'},valid:false},
  {name:'extra field',response:{schemaVersion:1,status:'restored',extra:true},valid:false},
].flatMap(item=>(['files','hostTools'] as const).map(purpose=>({...item,purpose}))))('validates $name $purpose recovery without creating or adopting a terminal',async({response,valid,purpose})=>{
  const user=userEvent.setup(),restored=vi.fn(),connected=vi.fn();
  const restore=purpose==='files'?mocks.api.restoreFileTransfer:mocks.api.restoreHostTools;
  restore.mockResolvedValue(response);
  render(<ConnectDialog host={{...host,transport:'mosh'}} hosts={[host]} connected={connected} close={vi.fn()} recovery={{sessionId:'original-mosh',purpose,restored}}/>);
  expect(screen.queryByLabelText('Transport')).toBeNull();
  expect(screen.queryByText('Save credentials on this device after connecting')).toBeNull();
  await user.type(screen.getByLabelText('Password'),'ephemeral-restore');
  await user.click(screen.getByRole('button',{name:t(purpose==='files'?'attachmentRestore':'hostToolsRestore')}));
  if(valid)await waitFor(()=>expect(restored).toHaveBeenCalledOnce());
  else {expect(await screen.findByRole('alert')).toHaveProperty('textContent',t(purpose==='files'?'attachmentRestoreInvalid':'hostToolsRestoreInvalid'));expect(restored).not.toHaveBeenCalled();}
  expect(restore).toHaveBeenCalledWith('original-mosh',{password:'ephemeral-restore'},{useSavedCredentials:false});
  expect(purpose==='files'?mocks.api.restoreHostTools:mocks.api.restoreFileTransfer).not.toHaveBeenCalled();
  expect(mocks.api.connect).not.toHaveBeenCalled();expect(mocks.api.connectMosh).not.toHaveBeenCalled();
  expect(mocks.api.adoptSession).not.toHaveBeenCalled();expect(mocks.createTerminal).not.toHaveBeenCalled();expect(connected).not.toHaveBeenCalled();
});

it('uses existing saved credential authorization for upload recovery and suppresses stale completion after lock',async()=>{
  const user=userEvent.setup(),restored=vi.fn();let complete!:(value:{schemaVersion:1;status:'restored'})=>void;
  mocks.invoke.mockImplementation(async command=>command==='has_credentials');
  mocks.api.restoreFileTransfer.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
  render(<ConnectDialog host={{...host,credentialsStored:true,biometricUnlock:true}} hosts={[host]} connected={vi.fn()} close={vi.fn()} recovery={{sessionId:'original-mosh',restored}}/>);
  expect(await screen.findByLabelText('Use saved credentials')).toHaveProperty('checked',true);
  await user.click(screen.getByRole('button',{name:'Reconnect uploads'}));
  expect(mocks.api.restoreFileTransfer).toHaveBeenCalledWith('original-mosh',{}, {useSavedCredentials:true});
  await act(async()=>{
    applyAccessStatus({...unlockedStatus(),enabled:true,locked:true,generation:String(generationBase+1),nonce:undefined});
    complete({schemaVersion:1,status:'restored'});
  });
  expect(restored).not.toHaveBeenCalled();expect(mocks.api.connect).not.toHaveBeenCalled();expect(mocks.api.disconnect).not.toHaveBeenCalled();
});

it.each(['lock','hidden','closed-source','unmount'] as const)('does not publish late host-tools recovery after %s',async mode=>{
  applyAccessStatus(unlockedStatus());
  const user=userEvent.setup(),restored=vi.fn(),current=vi.fn(()=>true);let complete!:(value:{schemaVersion:1;status:'restored'})=>void;
  mocks.api.restoreHostTools.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
  const view=render(<ConnectDialog host={host} hosts={[host]} connected={vi.fn()} close={vi.fn()} recovery={{sessionId:'original-mosh',purpose:'hostTools',current,restored}}/>);
  await user.type(screen.getByLabelText('Password'),'ephemeral-tools');
  await user.click(screen.getByRole('button',{name:t('hostToolsRestore')}));
  expect(mocks.api.restoreHostTools).toHaveBeenCalledWith('original-mosh',{password:'ephemeral-tools'},{useSavedCredentials:false});
  if(mode==='hidden'){
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    act(()=>document.dispatchEvent(new Event('visibilitychange')));
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  }else if(mode==='lock')applyAccessStatus({...unlockedStatus(),enabled:true,locked:true,generation:String(generationBase+1),nonce:undefined});
  else if(mode==='closed-source')current.mockReturnValue(false);
  else view.unmount();
  await act(async()=>complete({schemaVersion:1,status:'restored'}));
  expect(restored).not.toHaveBeenCalled();expect(mocks.api.connect).not.toHaveBeenCalled();expect(mocks.api.restoreFileTransfer).not.toHaveBeenCalled();
});
