// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {applyAccessStatus} from './access';
import {t} from './i18n/core';
import {refreshAgents,onAgentsRefresh} from './agentsRefresh';
import AgentSetupSettings from './AgentSetupSettings';
import AgentPanel from './AgentPanel';
vi.mock('./ApprovalPanel',()=>({default:()=>null}));
import {useHerdrNavigation} from './useHerdrNavigation';
import {herdrNavigationTree as tree} from './test/herdrNavigation';

vi.mock('@tauri-apps/api/core', async original => ({...await original<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn(),Channel:class {onmessage?:unknown;}}));
const companionSettings={schemaVersion:1,revision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true};
const report={sessionId:'a',agent:'Claude Code',project:'/work',state:'working',updatedAt:'2026-10-24T19:30:00Z',summary:'Reported',paneId:'%1',eventCount:2};
let generation=0;
beforeEach(()=>{applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(generation+=10),nonce:'a'.repeat(64)});});
afterEach(()=>{cleanup();vi.clearAllMocks();});
async function host(snapshot:()=>unknown) {
  const {invoke}=await import('@tauri-apps/api/core');
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command==='agent_snapshot')return snapshot();
    if(command==='multiplexer_sessions')return [{name:'default'},{name:'review'}];
    if(command==='herdr_tree')return tree;
    return companionSettings;
  });
  return invoke;
}

it('holds what the Agents page setup button used to open, and reads the companion settings only for a reporting host',async()=>{
  const invoke=await host(()=>({schemaVersion:1,sessions:[report]}));
  render(<AgentSetupSettings sessionId="settings-host"/>);
  expect(screen.getByRole('button',{name:t('settingsAgentsRefresh')})).toBeTruthy();
  expect(screen.getByText(t('companionInstallTitle'))).toBeTruthy();
  expect(screen.getByText(t('hooksTitle'))).toBeTruthy();
  expect(await screen.findByRole('checkbox',{name:'Recorded usage inspection'})).toBeTruthy();
  expect(await screen.findByRole('combobox',{name:t('herdrAgentsServer')})).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith('get_companion_settings',{sessionId:'settings-host'},expect.anything());
});

it('does not load companion settings from a host that reports nothing, and offers Install',async()=>{
  const invoke=await host(()=>Promise.reject({message:'lazysh-agent: command not found'}));
  render(<AgentSetupSettings sessionId="bare-host"/>);
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('agent_snapshot',{sessionId:'bare-host'},expect.anything()));
  await act(async()=>{});
  expect(screen.queryByRole('checkbox',{name:'Recorded usage inspection'})).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith('get_companion_settings',expect.anything(),expect.anything());
  expect(screen.getByRole('button',{name:'Install companion'})).toBeTruthy();
});

it('verifies a new host before reading its companion settings after a session change',async()=>{
  const {invoke}=await import('@tauri-apps/api/core');
  vi.mocked(invoke).mockImplementation((command,args)=>{
    if(command==='agent_snapshot')return args && 'sessionId' in args && args.sessionId==='new-host'?new Promise(()=>{}):Promise.resolve({schemaVersion:1,sessions:[]});
    if(command==='multiplexer_sessions')return Promise.resolve([]);
    return Promise.resolve(companionSettings);
  });
  const view=render(<AgentSetupSettings sessionId="old-host"/>);
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('get_companion_settings',{sessionId:'old-host'},expect.anything()));
  view.rerender(<AgentSetupSettings sessionId="new-host"/>);
  expect(screen.queryByRole('region',{name:'Host companion settings'})).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith('get_companion_settings',{sessionId:'new-host'},expect.anything());
});

it('opens the hook setup when the page sends the user there from an empty Activity list',async()=>{
  await host(()=>({schemaVersion:1,sessions:[]}));
  render(<AgentSetupSettings sessionId="hook-host" reveal={{sessionId:'hook-host'}}/>);
  const provider=await screen.findByLabelText(t('hooksProvider'));
  expect(provider.closest('details')).toHaveProperty('open',true);
  expect(document.activeElement).toBe(provider.closest('details')?.querySelector('summary'));
});

it('asks the Agents readers to refresh, and to drop an older read after a companion install',async()=>{
  await host(()=>({schemaVersion:1,sessions:[]}));
  const asked=vi.fn();const off=onAgentsRefresh(asked);
  render(<AgentSetupSettings sessionId="refresh-host"/>);
  fireEvent.click(screen.getByRole('button',{name:t('settingsAgentsRefresh')}));
  expect(asked).toHaveBeenLastCalledWith(false);
  act(()=>refreshAgents(true));expect(asked).toHaveBeenLastCalledWith(true);
  off();
});

it('keeps the Live agents server choice shared with the page reader that polls it',async()=>{
  const {invoke}=await host(()=>({schemaVersion:1,sessions:[]})).then(invoke=>({invoke}));
  function Reader() {const {data}=useHerdrNavigation({sessionId:'shared-host',visible:true});return <output aria-label="reader">{data?.server}</output>;}
  render(<><Reader/><AgentSetupSettings sessionId="shared-host"/></>);
  const select=await screen.findByRole('combobox',{name:t('herdrAgentsServer')});
  expect(within(screen.getByLabelText('reader')).queryByText('review')).toBeNull();
  fireEvent.change(select,{target:{value:'review'}});
  await waitFor(()=>expect(screen.getByLabelText('reader').textContent).toBe('review'));
  expect(invoke).toHaveBeenCalledWith('herdr_tree',{sessionId:'shared-host',name:'review'},expect.anything());
});

it('shows the keep-awake switch in Settings while the Agents board, which owns the display, keeps it when Settings closes',async()=>{
  await host(()=>({schemaVersion:1,sessions:[report]}));
  const view=render(<><AgentPanel sessionId="awake-host" showHerdr={false}/><div data-testid="settings"><AgentSetupSettings sessionId="awake-host"/></div></>);
  const settings=within(screen.getByTestId('settings'));
  const region=await settings.findByRole('region',{name:t('keepAwakeRegion')});
  expect(settings.getByRole('checkbox',{name:t('keepAwakeLabel')})).toBeTruthy();
  view.rerender(<AgentPanel sessionId="awake-host" showHerdr={false}/>);
  // Closing Settings moves the control back to the board, hidden; it is still mounted and owns the display from there.
  const kept=view.container.querySelector('[hidden] .keep-awake-control');
  expect(kept).not.toBeNull();expect(kept).not.toBe(region);
});
