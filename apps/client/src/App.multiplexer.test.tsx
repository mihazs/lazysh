// @vitest-environment jsdom
// The harness registers the module mocks, so it has to be the first import.
import {autoOptions, chooseWorkspaceTool, enableTransports, generationBase, host, mocks, openConnection, reportedAgent, reportedAppMetadata, reportedHistoryApp, selectConnectionTransport, unlockedStatus} from './test/appHarness';
import {t} from './i18n/core';
import {expect, it, vi} from "vitest";
import {act, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {Host} from "./bridge";
import {herdrNavigationTree} from './test/herdrNavigation';
import App, {validateHost} from "./App";

it.each(['tmux','herdr','zellij'] as const)('enters the saved Mosh default %s directly without creating an SSH display',async kind=>{
  enableTransports();
  const target={kind,name:'named-work'};
  mocks.api.listHosts.mockResolvedValue([{...host,transport:'mosh',defaultMultiplexer:target}]);
  mocks.api.connect.mockResolvedValue({sessionId:'entry-control'});
  mocks.api.connectMosh.mockResolvedValue({sessionId:'entry-mosh'});
  const user=await openConnection();
  expect(screen.getByLabelText('Transport')).toHaveProperty('value','mosh');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  expect(mocks.api.connectMosh).toHaveBeenCalledExactlyOnceWith('entry-control',
    {serverPath:'mosh-server',portMin:60000,portMax:61000},expect.any(Function),{...target,createIfMissing:true});
  expect(mocks.api.attachDefaultMultiplexer).not.toHaveBeenCalled();
  expect(mocks.api.connectEt).not.toHaveBeenCalled();
  expect(mocks.api.adoptSession).toHaveBeenCalledWith('entry-mosh');
  expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'entry-control'});
  expect(mocks.api.write).not.toHaveBeenCalled();expect(mocks.api.saveHost).not.toHaveBeenCalled();
  const saved=vi.mocked(localStorage.setItem).mock.calls.filter(([key])=>key==='lazysh.workspace.v1').at(-1);
  expect(JSON.parse(saved![1])).toEqual([{hostId:host.id,mosh:{serverPath:'mosh-server',portMin:60000,portMax:61000},attached:target}]);
});

it.each(['mosh_entry_startup_failed','herdr_guard_startup_unsupported','mosh_entry_unsupported_host'])('does not retry an Auto multiplexer admission failure %s as another display',async kind=>{
  enableTransports();
  mocks.api.listHosts.mockResolvedValue([{...host,transport:'auto',defaultMultiplexer:{kind:'herdr',name:'work'}}]);
  mocks.api.connectMosh.mockRejectedValue({kind,message:'Owned entry admission failed'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  expect((await screen.findByRole('alert')).textContent).toContain('Owned entry admission failed');
  expect(mocks.api.connectMosh).toHaveBeenCalledOnce();
  expect(mocks.api.attachDefaultMultiplexer).not.toHaveBeenCalled();expect(mocks.api.connectEt).not.toHaveBeenCalled();
  expect(mocks.api.adoptSession).not.toHaveBeenCalled();expect(mocks.api.write).not.toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'verified-control'});
});

it('uses SSH for default entry Auto only after a safe pre-dispatch Mosh fallback',async()=>{
  enableTransports();
  const target={kind:'herdr' as const,name:'work'};
  mocks.api.listHosts.mockResolvedValue([{...host,transport:'auto',defaultMultiplexer:target}]);
  mocks.api.connectMosh.mockRejectedValue({kind:'mosh_unsupported',message:'Unsupported platform before bootstrap'});
  mocks.api.attachDefaultMultiplexer.mockResolvedValue({sessionId:'auto-entry-ssh'});
  const user=await openConnection();
  expect(screen.getByRole('option',{name:'Auto (Mosh, then SSH)'})).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  expect(mocks.api.attachDefaultMultiplexer).toHaveBeenCalledExactlyOnceWith('verified-control',target,expect.any(Function));
  expect(mocks.api.connectEt).not.toHaveBeenCalled();
  const saved=vi.mocked(localStorage.setItem).mock.calls.filter(([key])=>key==='lazysh.workspace.v1').at(-1);
  expect(JSON.parse(saved![1])).toEqual([{hostId:host.id,auto:autoOptions,attached:target}]);
});

it.each(['mosh','auto'] as const)('restores an exact %s attachment and tmux server instead of the saved host default',async mode=>{
  enableTransports();
  const attached={kind:'tmux' as const,name:'actual-work',tmuxServer:'agents'};
  const intent={hostId:host.id,attached,...(mode==='auto'?{auto:autoOptions}:{mosh:autoOptions.mosh})};
  vi.mocked(localStorage.getItem).mockImplementation(key=>key==='lazysh.workspace.v1'?JSON.stringify([intent]):null);
  mocks.api.listHosts.mockResolvedValue([{...host,defaultMultiplexer:{kind:'herdr',name:'different'}}]);
  mocks.api.connectMosh.mockResolvedValue({sessionId:'restored-mosh-entry'});
  const user=userEvent.setup();render(<App/>);await screen.findByRole('button',{name:'Connect to Home'});
  await user.click(screen.getByRole('button',{name:'Restore previous workspace'}));await screen.findByText('Live SSH terminal');
  expect(mocks.api.connectMosh).toHaveBeenCalledExactlyOnceWith('verified-control',autoOptions.mosh,expect.any(Function),attached);
  expect(mocks.api.attachDefaultMultiplexer).not.toHaveBeenCalled();expect(mocks.api.attachTmux).not.toHaveBeenCalled();
  expect(mocks.api.adoptSession).toHaveBeenCalledWith('restored-mosh-entry');
  const saved=vi.mocked(localStorage.setItem).mock.calls.filter(([key])=>key==='lazysh.workspace.v1').at(-1);
  expect(JSON.parse(saved![1])).toEqual([intent]);
});

it.each(['tmux','herdr','zellij'] as const)('enters the saved named %s directly through SSH and retires only its bootstrap',async kind=>{
  const target={kind,name:kind==='herdr' ? 'named-work' : "work 'literal;"};
  mocks.api.listHosts.mockResolvedValue([{...host,transport:'ssh',defaultMultiplexer:target}]);
  mocks.api.connect.mockResolvedValue({sessionId:'default-parent'});
  mocks.api.attachDefaultMultiplexer.mockResolvedValue({sessionId:'default-child'});
  const user=await openConnection();
  expect(screen.getByLabelText('Transport')).toHaveProperty('value','ssh');
  expect(screen.getByLabelText('Transport')).toHaveProperty('disabled',false);
  expect(screen.getByText(/Direct multiplexer entry supports SSH or Mosh./)).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  expect(mocks.api.attachDefaultMultiplexer).toHaveBeenCalledExactlyOnceWith('default-parent',target,expect.any(Function));
  expect(mocks.api.adoptSession).toHaveBeenCalledWith('default-child');
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='disconnect')).toEqual([['disconnect',{sessionId:'default-parent'}]]);
  expect(mocks.api.connectMosh).not.toHaveBeenCalled();expect(mocks.api.connectEt).not.toHaveBeenCalled();
  expect(mocks.api.saveHost).not.toHaveBeenCalled();
});

it('opens Agents on the attached default Herdr session among several running servers',async()=>{
  reportedHistoryApp(reportedAppMetadata);
  const companion=mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command,args)=>{
    if(command==='multiplexer_sessions')return Promise.resolve([{name:'other'},{name:'named-work'}]);
    if(command==='herdr_tree')return Promise.resolve({...herdrNavigationTree,agents:[{...herdrNavigationTree.agents[0],agent_session:{source:'herdr:codex',agent:'codex',kind:'id',value:'owned-reference'}}]});
    if(command==='agent_snapshot')return Promise.resolve({schemaVersion:1,sessions:[{...reportedAgent,agent:'Codex',sessionId:'owned-reference'}]});
    return companion(command,args);
  });
  mocks.api.listHosts.mockResolvedValue([{...host,defaultMultiplexer:{kind:'herdr',name:'named-work'}}]);
  mocks.api.connect.mockResolvedValue({sessionId:'agents-parent'});
  mocks.api.attachDefaultMultiplexer.mockResolvedValue({sessionId:'agents-child'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await screen.findByText('Live SSH terminal');
  expect(mocks.invoke.mock.calls.filter(([command])=>['agent_snapshot','agent_approvals','get_companion_settings','board_keep_awake_status'].includes(command))).toEqual([]);
  await chooseWorkspaceTool(user,'Agents');
  await user.click(await screen.findByRole('button',{name:t('herdrAgentsServer')}));
  const select=await screen.findByRole('combobox',{name:t('herdrAgentsServer')});
  await waitFor(()=>expect(select).toHaveProperty('disabled',false));
  expect(select).toHaveProperty('value','named-work');
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='herdr_tree')).toEqual([
    ['herdr_tree',{sessionId:'agents-child',name:'named-work'},{headers:{'X-Lazysh-Access':'a'.repeat(64)}}],
  ]);
  const live=screen.getByRole('region',{name:t('herdrNavigationTitle')});
  await user.click(within(live).getByRole('button',{name:t('navigationBack')}));
  const summary=within(live).getByText('Reported session');
  await user.click(summary);
  expect(within(live).getByText('/project')).toBeTruthy();
  expect(within(live).getByText('Unverified reference; may be stale.')).toBeTruthy();
  await user.click(summary);
  expect(mocks.invoke.mock.calls.filter(([command])=>['herdr_action','herdr_chat','prepare_herdr_chat','attach_multiplexer'].includes(command))).toEqual([]);
  expect(mocks.api.write).not.toHaveBeenCalled();
});

it('switches between the terminal and the Agent view on the terminal\'s two-finger action, and only for the active session',async()=>{
  mocks.api.connect.mockResolvedValue({sessionId:'switching'});
  mocks.invoke.mockImplementation(command=>command==='agent_snapshot'?Promise.resolve({schemaVersion:1,sessions:[]}):Promise.resolve(false));
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  const act2=(sessionId:string)=>act(()=>{window.dispatchEvent(new CustomEvent('lazysh-terminal-action',{detail:{sessionId,action:'agentView'}}));});
  act2('another');
  expect(screen.queryByRole('region',{name:'Agent view'})).toBeNull();
  act2('switching');
  await screen.findByRole('region',{name:'Agent view'});
  act2('switching');
  await waitFor(()=>expect(screen.queryByRole('region',{name:'Agent view'})).toBeNull());
});

it.each(['enter','stale-pane','hidden','locked','wrong-server'] as const)('enters only the owned Agent view Herdr pane: %s',async outcome=>{
  mocks.api.listHosts.mockResolvedValue([{...host,defaultMultiplexer:{kind:'herdr',name:'named-work'}}]);
  mocks.api.connect.mockResolvedValue({sessionId:'agent-parent'});
  mocks.api.attachDefaultMultiplexer.mockResolvedValue({sessionId:'agent-child'});
  let reads=0,finish!:(value:unknown)=>void;
  mocks.invoke.mockImplementation((command)=>{
    if(command==='agent_snapshot')return Promise.resolve({schemaVersion:1,sessions:[]});
    if(command==='multiplexer_sessions')return Promise.resolve([{name:outcome==='wrong-server'?'other':'named-work'}]);
    if(command==='herdr_tree')return ++reads===1?Promise.resolve(herdrNavigationTree):new Promise(resolve=>{finish=resolve;});
    if(command==='herdr_action')return Promise.resolve(undefined);
    return Promise.resolve(false);
  });
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  await user.click(within(screen.getByRole('group',{name:'Session view'})).getByRole('button',{name:'Agent'}));
  const agent=await screen.findByRole('region',{name:'Agent view'});
  expect(within(agent).queryByRole('button',{name:'Choose transcript'})).toBeNull();
  if(outcome==='wrong-server'){
    await waitFor(()=>expect(agent.querySelector('.herdr-agents select')).not.toBeNull());
    expect(within(agent).queryByRole('button',{name:'Enter session'})).toBeNull();
    expect(mocks.invoke.mock.calls.filter(([command])=>command==='herdr_tree'||command==='herdr_action')).toHaveLength(0);
    return;
  }
  await user.click(await within(agent).findByRole('button',{name:'Enter session'}));
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  if(outcome==='hidden')await user.click(within(screen.getByRole('group',{name:'Session view'})).getByRole('button',{name:'Terminal'}));
  if(outcome==='locked')await act(async()=>mocks.lockEvent!({payload:{...unlockedStatus(),enabled:true,locked:true,generation:String(generationBase+1),nonce:undefined}}));
  await act(async()=>finish(outcome==='stale-pane'?{...herdrNavigationTree,panes:[{...herdrNavigationTree.panes[0],terminal_id:'replacement'}]}:herdrNavigationTree));
  const actions=mocks.invoke.mock.calls.filter(([command])=>command==='herdr_action');
  if(outcome==='enter'){
    expect(actions).toEqual([['herdr_action',{sessionId:'agent-child',name:'named-work',action:{type:'focusPane',target:'w2E:pF'}},{headers:{'X-Lazysh-Access':'a'.repeat(64)}}]]);
    expect(screen.getByText('Live SSH terminal')).toBeTruthy();
    expect(screen.queryByRole('region',{name:'Agent view'})).toBeNull();
  }else expect(actions).toHaveLength(0);
  expect(mocks.api.attachMultiplexer).not.toHaveBeenCalled();expect(mocks.api.write).not.toHaveBeenCalled();
});

it.each(['current','current-second-display','adopt','adopt-held-tree','adopt-held-reply','cancel-before-publication','cancel-after-publication','cancel-pending-reply','cancel-server','hidden-then-visible','missing','removed-on-host','stale','unsupported','limited'] as const)('navigates the exact Herdr display with %s ownership',async outcome=>{
  if(outcome==='unsupported')mocks.realAgents=true;
  const existing=outcome==='current'||outcome==='current-second-display'||outcome==='unsupported'||outcome==='removed-on-host';
  mocks.api.listHosts.mockResolvedValue([{...host,...(existing?{defaultMultiplexer:{kind:'herdr',name:'named-work'}}:{})}]);
  mocks.api.connect.mockResolvedValue({sessionId:'navigation-source'});
  mocks.api.attachDefaultMultiplexer.mockResolvedValue({sessionId:'navigation-existing'});
  mocks.api.attachMultiplexer.mockResolvedValue({sessionId:'navigation-adopted'});
  let complete!:(value:unknown)=>void,reads=0;
  if(outcome==='cancel-before-publication')mocks.api.attachMultiplexer.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
  const original=mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command,args)=>{
    if(command==='multiplexer_tree')return Promise.resolve({tmuxAvailable:false,herdrAvailable:true,zellijAvailable:false,tools:[outcome==='limited'?{kind:'herdr',version:'0.8.2',support:'degraded',missing:['create','restore']}:{kind:'herdr',version:'0.9.5',support:'full',missing:[]}],sessions:[]});
    if(command==='multiplexer_sessions')return Promise.resolve([{name:'named-work'}]);
    if(command==='herdr_tree'){
      if(++reads===1)return Promise.resolve(herdrNavigationTree);
      if(reads===2 && (outcome==='stale'||outcome==='adopt-held-tree'||outcome==='cancel-after-publication'||outcome==='cancel-server'||outcome==='hidden-then-visible'))return new Promise(resolve=>{complete=resolve;});
      return Promise.resolve(outcome==='missing'?{...herdrNavigationTree,panes:[]}:herdrNavigationTree);
    }
    if(command==='herdr_action'){if(outcome==='adopt-held-reply'||outcome==='cancel-pending-reply')return new Promise(resolve=>{complete=resolve;});return outcome==='unsupported'?Promise.reject({kind:'herdr_focus_companion_required'}):outcome==='removed-on-host'?Promise.reject({kind:'herdr_target_missing',message:'host text'}):Promise.resolve(undefined);}
    return original(command,args);
  });
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  if(outcome==='current-second-display'){
    await chooseWorkspaceTool(user,'Sessions');
    await user.click(await screen.findByRole('button',{name:'List herdr sessions'}));
    await user.click(await screen.findByRole('button',{name:'Attach herdr named-work'}));
    await waitFor(()=>expect(screen.getByRole('tab',{name:'Home / named-work / named-work'}).getAttribute('aria-selected')).toBe('true'));
  }
  await user.click(screen.getByRole('button',{name:'Workspaces'}));
  const browser=within(await screen.findByRole('region',{name:t('herdrNavigationTitle')}));
  expect(browser.getByText(t('herdrNavigationShared'))).toBeTruthy();
  await user.click(await browser.findByRole('button',{name:/^builder/}));
  const cancelled=outcome.startsWith('cancel-')||outcome==='hidden-then-visible';
  if(cancelled){
    await waitFor(()=>expect(complete).toBeTypeOf('function'));
    if(outcome!=='cancel-before-publication')await waitFor(()=>expect(screen.getByRole('tab',{name:'Home / named-work'}).getAttribute('aria-selected')).toBe('true'));
    if(outcome==='hidden-then-visible'){
      const hidden=vi.spyOn(document,'hidden','get');
      hidden.mockReturnValue(true);act(()=>document.dispatchEvent(new Event('visibilitychange')));
      hidden.mockReturnValue(false);act(()=>document.dispatchEvent(new Event('visibilitychange')));hidden.mockRestore();
    }else if(outcome==='cancel-server'){
      await user.click(screen.getByRole('button',{name:t('herdrAgentsServer')}));
      const server=await screen.findByRole('combobox',{name:t('herdrAgentsServer')});await waitFor(()=>expect(server).toHaveProperty('disabled',false));await user.selectOptions(server,'');
    }else await user.click(screen.getByRole('button',{name:t('herdrNavigationBack')}));
    if(outcome==='cancel-pending-reply')await user.click(screen.getByRole('tab',{name:'Home'}));
    await act(async()=>complete(outcome==='cancel-before-publication'?{sessionId:'navigation-adopted'}:outcome==='cancel-pending-reply'?undefined:herdrNavigationTree));
    if(outcome==='cancel-pending-reply')expect(screen.getByRole('tab',{name:'Home'}).getAttribute('aria-selected')).toBe('true');
    if(outcome==='cancel-before-publication')expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'navigation-adopted'});
    else expect(mocks.invoke).not.toHaveBeenCalledWith('disconnect',{sessionId:'navigation-adopted'});
  }
  if(outcome==='adopt-held-tree'||outcome==='adopt-held-reply'){
    await waitFor(()=>expect(complete).toBeTypeOf('function'));
    await waitFor(()=>expect(screen.getByRole('tab',{name:'Home / named-work'}).getAttribute('aria-selected')).toBe('true'));
    await act(async()=>complete(outcome==='adopt-held-tree'?herdrNavigationTree:undefined));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Workspaces'}).closest('aside')!.classList.contains('sidebar-open')).toBe(false));
  }
  if(cancelled){}else if(outcome==='stale'){
    await waitFor(()=>expect(complete).toBeTypeOf('function'));
    await user.click(screen.getByRole('button',{name:'Connections'}));
    await act(async()=>complete(herdrNavigationTree));
    expect(screen.getByRole('button',{name:'Connections'})).toHaveProperty('ariaCurrent','page');
  } else if(outcome==='unsupported'){
    expect(await browser.findByRole('alert')).toHaveProperty('textContent',t('herdrNavigationCompanion'));
    await user.click(browser.getByRole('button',{name:t('companionInstallTitle')}));
    expect((await screen.findByRole('button',{name:'Install companion'})).closest('[hidden]')).toBeNull();
    expect(mocks.invoke.mock.calls.some(([command])=>command==='companion_install')).toBe(false);
  }
  else if(outcome==='limited')expect((await screen.findByRole('alert')).textContent).toContain(t('muxLimitedHerdr'));
  else if(outcome==='missing'||outcome==='removed-on-host')expect((await screen.findByRole('alert')).textContent).toContain(t('herdrNavigationChanged'));
  else await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('herdr_action',{sessionId:existing&&outcome!=='current-second-display'?'navigation-existing':'navigation-adopted',name:'named-work',action:{type:'focusPane',target:'w2E:pF'}},{headers:{'X-Lazysh-Access':'a'.repeat(64)}}));
  const sent=mocks.invoke.mock.calls.filter(([command])=>command==='herdr_action');
  expect(sent).toHaveLength(outcome==='missing'||outcome==='limited'||outcome==='stale'||(cancelled&&outcome!=='cancel-pending-reply')?0:1);
  if(outcome==='current-second-display'){expect(mocks.api.attachMultiplexer).toHaveBeenCalledExactlyOnceWith('navigation-existing','herdr','named-work',expect.any(Function));expect(sent.every(([,args])=>(args as {sessionId:string}).sessionId==='navigation-adopted')).toBe(true);expect(mocks.api.adoptSession.mock.calls.map(([id])=>id)).toEqual(['navigation-existing','navigation-adopted']);expect(screen.getByRole('tab',{name:'Home / named-work / named-work'}).getAttribute('aria-selected')).toBe('true');}
  else if(existing||outcome==='limited')expect(mocks.api.attachMultiplexer).not.toHaveBeenCalled();
  else expect(mocks.api.attachMultiplexer).toHaveBeenCalledExactlyOnceWith('navigation-source','herdr','named-work',expect.any(Function));
  expect(mocks.api.write).not.toHaveBeenCalled();
  if(outcome==='cancel-before-publication')expect(mocks.api.adoptSession).not.toHaveBeenCalledWith('navigation-adopted');
  else if(!existing && outcome!=='limited')expect(mocks.api.adoptSession.mock.calls.filter(([id])=>id==='navigation-adopted')).toHaveLength(1);
});

it('shows a selected multiplexer preflight failure and closes its bootstrap without adopting a blank terminal',async()=>{
  mocks.api.listHosts.mockResolvedValue([{...host,defaultMultiplexer:{kind:'zellij',name:'work'}}]);
  mocks.api.connect.mockResolvedValue({sessionId:'unavailable-parent'});
  mocks.api.attachDefaultMultiplexer.mockRejectedValue({kind:'multiplexer_unavailable',message:'Selected multiplexer unavailable'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  expect((await screen.findByRole('alert')).textContent).toContain('Selected multiplexer unavailable');
  expect(screen.queryByText('Live SSH terminal')).toBeNull();
  expect(mocks.api.adoptSession).not.toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'unavailable-parent'});
  expect(mocks.api.attachMultiplexer).not.toHaveBeenCalled();
});

it('persists and removes the host default without changing the saved transport',async()=>{
  mocks.api.listHosts.mockResolvedValue([{...host,transport:'et'}]);
  mocks.api.saveHost.mockImplementation(async value=>value);
  const user=userEvent.setup();render(<App/>);
  await user.click(await screen.findByRole('button',{name:'Edit Home'}));
  await user.selectOptions(screen.getByLabelText('Default multiplexer'),'tmux');
  await user.type(screen.getByLabelText('Default multiplexer session'),'new-work');
  expect(screen.getByText('Attach to the named session, or create it using the selected multiplexer. No other session is selected.')).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Save host'}));
  await waitFor(()=>expect(mocks.api.saveHost).toHaveBeenCalled());
  const saved=mocks.api.saveHost.mock.calls[0][0];
  expect(saved).toMatchObject({transport:'et',defaultMultiplexer:{kind:'tmux',name:'new-work'}});
  await user.click(await screen.findByRole('button',{name:'Edit Home'}));
  await user.selectOptions(screen.getByLabelText('Default multiplexer'),'');
  await user.click(screen.getByRole('button',{name:'Save host'}));
  await waitFor(()=>expect(mocks.api.saveHost).toHaveBeenCalledTimes(2));
  expect(mocks.api.saveHost.mock.calls[1][0]).toMatchObject({transport:'et',defaultMultiplexer:undefined});
});

it('opens the active host multiplexer setting directly from workspace tools without changing its running session',async()=>{
  mocks.api.listHosts.mockResolvedValue([{...host,id:'other-host',name:'Other'},{...host,transport:'mosh'}]);
  mocks.api.connect.mockResolvedValue({sessionId:'settings-current'});
  mocks.api.saveHost.mockResolvedValue(undefined);
  const user=await openConnection();
  await selectConnectionTransport(user, 'ssh');
  await user.click(screen.getByRole('button',{name:'Connect'}));
  const terminal=await screen.findByText('Live SSH terminal');
  await chooseWorkspaceTool(user,'Default multiplexer');
  const editor=await screen.findByRole('dialog',{name:'Edit host'});
  const setting=within(editor).getByLabelText('Default multiplexer');
  expect(document.activeElement).toBe(setting);
  expect(within(editor).getByLabelText('Name')).toHaveProperty('value','Home');
  await user.selectOptions(setting,'herdr');
  await user.type(within(editor).getByLabelText('Default multiplexer session'),'named-work');
  await user.click(within(editor).getByRole('button',{name:'Save host'}));
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Edit host'})).toBeNull());
  expect(mocks.api.saveHost).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id:host.id,transport:'mosh',defaultMultiplexer:{kind:'herdr',name:'named-work'}}));
  expect(screen.getByText('Live SSH terminal')).toBe(terminal);
  expect(mocks.api.connect).toHaveBeenCalledOnce();
  expect(mocks.api.disconnect).not.toHaveBeenCalled();
  expect(mocks.api.attachDefaultMultiplexer).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Edit Home'}));
  expect(document.activeElement).not.toBe(screen.getByLabelText('Default multiplexer'));
});

it.each([{kind:'tmux',name:'bad.name'},{kind:'tmux',name:'bad:name'},{kind:'herdr',name:' '},{kind:'herdr',name:'bad name'},{kind:'herdr',name:'..'},{kind:'herdr',name:'a'.repeat(65)},{kind:'zellij',name:'--option'},{kind:'herdr',name:'é'.repeat(101)},{kind:'other',name:'work'}])('rejects invalid saved default %j before native save',target=>{
  expect(validateHost({...host,defaultMultiplexer:target as Host['defaultMultiplexer']})).toBeTruthy();
});

it('retires a late default child after its connection dialog closes',async()=>{
  mocks.api.listHosts.mockResolvedValue([{...host,defaultMultiplexer:{kind:'herdr',name:'late'}}]);
  mocks.api.connect.mockResolvedValue({sessionId:'late-bootstrap'});
  let finish!:(value:{sessionId:string})=>void;
  mocks.api.attachDefaultMultiplexer.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));
  await waitFor(()=>expect(mocks.api.attachDefaultMultiplexer).toHaveBeenCalled());
  await user.click(screen.getByRole('button',{name:'Close Connect to Home'}));
  await act(async()=>finish({sessionId:'late-mux-child'}));
  await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'late-mux-child'}));
  expect(mocks.invoke).toHaveBeenCalledWith('disconnect',{sessionId:'late-bootstrap'});
  expect(mocks.api.adoptSession).not.toHaveBeenCalled();
});

it('keeps one agent owner beside the owned terminal and suspends it through navigation without losing drafts',async({onTestFinished})=>{
  reportedHistoryApp(reportedAppMetadata);mocks.api.connect.mockResolvedValue({sessionId:'nav-agents'});
  const user=await openConnection();await user.click(screen.getByRole('button',{name:'Connect'}));await screen.findByText('Live SSH terminal');
  expect(screen.getByRole('button',{name:'Connections'})).toHaveProperty('ariaCurrent','page');
  await chooseWorkspaceTool(user,'Agents');
  const live=screen.getByRole('group',{name:'Live Herdr agents'});
  await user.click(screen.getByRole('button',{name:'Reported agent activity'}));
  const search=await screen.findByRole('searchbox',{name:'Search reported agents'});await user.type(search,'/project');
  await user.click(screen.getByRole('button',{name:'Setup'}));
  const settings=await screen.findByRole('checkbox',{name:'Recorded usage inspection'});await user.click(settings);
  const jumps=screen.getByRole('navigation',{name:'Agent sections'});
  const activity=screen.getByRole('group',{name:'Reported agent activity'});
  const scroller=activity.closest('.workspace-navigation-scroll') as HTMLDivElement;
  const pageScroll=vi.spyOn(window,'scrollTo');onTestFinished(()=>{pageScroll.mockRestore();});scroller.scrollTop=30;
  const readsBeforeJump=mocks.invoke.mock.calls.filter(([command])=>command==='agent_snapshot').length;
  const activityButton=within(jumps).getByRole('button',{name:'Reported agent activity'});
  fireEvent.click(activityButton);expect(document.activeElement).toBe(activity);expect(scroller.scrollTop).toBe(30);
  fireEvent.click(within(jumps).getByRole('button',{name:'Live Herdr agents'}));
  expect(document.activeElement).toBe(live);expect(scroller.scrollTop).toBe(0);expect(pageScroll).not.toHaveBeenCalled();
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='agent_snapshot')).toHaveLength(readsBeforeJump);
  fireEvent.click(activityButton);expect(scroller.scrollTop).toBe(30);
  expect(screen.getByRole('searchbox',{name:'Search reported agents'})).toBe(search);expect(settings).toHaveProperty('checked',false);

  expect(screen.getByText('Live SSH terminal')).toBeTruthy();
  expect(screen.getAllByRole('region',{name:'Agent activity'})).toHaveLength(1);
  await user.click(screen.getByRole('button',{name:'Connections'}));
  expect(screen.queryByRole('region',{name:'Agent activity'})).toBeNull();
  const reads=mocks.invoke.mock.calls.filter(([command])=>command==='agent_snapshot').length;
  const focusBeforeHiddenJump=document.activeElement;fireEvent.click(activityButton);expect(document.activeElement).toBe(focusBeforeHiddenJump);
  await user.click(screen.getByRole('button',{name:'Agents navigation'}));
  await screen.findByRole('searchbox',{name:'Search reported agents'});expect(screen.getByRole('searchbox',{name:'Search reported agents'})).toBe(search);expect(search).toHaveProperty('value','/project');
  expect(settings).toHaveProperty('checked',false);
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='get_companion_settings')).toHaveLength(1);
  expect(mocks.invoke.mock.calls.filter(([command])=>command==='agent_snapshot')).toHaveLength(reads+1);
  expect(mocks.api.disconnect).not.toHaveBeenCalled();expect(mocks.api.connect).toHaveBeenCalledOnce();
  const connections=screen.getByRole('button',{name:'Connections'});
  await act(async()=>{within(jumps).getByRole('button',{name:'Live Herdr agents'}).click();connections.click();});
  const agentsEntry=screen.getByRole('button',{name:'Agents navigation'});
  await user.click(agentsEntry);expect(document.activeElement).toBe(agentsEntry);
  await user.click(activityButton);
  await user.click(screen.getByRole('button',{name:'Workspaces'}));
  expect(screen.getByRole('group',{name:'Spaces'})).toBe(live);
  expect(screen.queryByRole('group',{name:'Live Herdr agents'})).toBeNull();
});
