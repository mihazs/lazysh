// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import CompanionSettingsPanel from './CompanionSettingsPanel';
import HostBrowserSwitch,{parseHostBrowserSettings} from './HostBrowserSwitch';
import {isHostBrowserConfirmed,onHostBrowserSwitch} from './hostBrowserConfirmation';
import {getPreferences,syncablePreferences} from './preferences';
import {answer,calls} from './test/routedInvoke';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));
beforeEach(()=>{localStorage.clear();});
afterEach(()=>{cleanup();vi.clearAllMocks();});
const settings={schemaVersion:1 as const,revision:4,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true};
const off={schemaVersion:1 as const,revision:0,hostBrowserEnabled:false};
const on={...off,revision:1,hostBrowserEnabled:true};
const access={headers:{'X-Lazysh-Access':expect.any(String)}};
const unsupported=()=>Promise.reject({kind:'host_browser_companion_required',message:'Update the host companion to change the host browser setting'});
async function turnOn(host:string,session='s1') {
  render(<CompanionSettingsPanel sessionId={session} hostKey={host}/>);
  const box=await screen.findByRole('checkbox',{name:'Host browser'});
  await vi.waitFor(()=>expect(box.matches(':disabled')).toBe(false));
  fireEvent.click(box);fireEvent.click(screen.getByRole('button',{name:'Save host browser setting'}));
  return box;
}
const allow=()=>fireEvent.click(screen.getByRole('button',{name:'Turn on host browser'}));

it('requires the exact versioned shape of the separate host browser file',()=>{
  expect(parseHostBrowserSettings(on)).toEqual(on);
  for(const value of [null,[],{...on,schemaVersion:2},{...on,revision:-1},{...on,revision:Number.MAX_SAFE_INTEGER+1},{...on,hostBrowserEnabled:'true'},{...on,deviceToolsEnabled:true},{schemaVersion:1,revision:0}])expect(()=>parseHostBrowserSettings(value)).toThrow();
});
it('shows the switch off for an absent file and saves it with the expected revision, apart from the three switches',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[off],update_host_browser_settings:[on]});
  const box=await turnOn('host-a');
  expect((box as HTMLInputElement).checked).toBe(true);
  expect(calls('update_host_browser_settings')).toHaveLength(0);
  allow();
  await screen.findByText('Host browser setting saved for new browser sessions.');
  expect(calls('update_host_browser_settings')).toEqual([['update_host_browser_settings',{sessionId:'s1',settings:{expectedRevision:0,hostBrowserEnabled:true}},access]]);
  expect(calls('update_companion_settings')).toHaveLength(0);
  fireEvent.click(screen.getByLabelText('Device tools'));fireEvent.click(screen.getByRole('button',{name:'Save host settings'}));
  await vi.waitFor(()=>expect(calls('update_companion_settings')).toHaveLength(1));
  expect(calls('update_companion_settings')[0][1]).toEqual({sessionId:'s1',settings:{expectedRevision:4,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:false}});
  expect(calls('update_host_browser_settings')).toHaveLength(1);
});
it('starts off, keeps a host that already enabled it on, and needs no write while nothing changed',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[off]});
  const view=render(<CompanionSettingsPanel sessionId="s1" hostKey="host-a"/>);
  const box=await screen.findByRole('checkbox',{name:'Host browser'});expect((box as HTMLInputElement).checked).toBe(false);
  await vi.waitFor(()=>expect(box.matches(':disabled')).toBe(false));
  expect(screen.getByRole('button',{name:'Save host browser setting'}).matches(':disabled')).toBe(true);
  view.unmount();
  answer({get_companion_settings:[settings],get_host_browser_settings:[on]});
  render(<CompanionSettingsPanel sessionId="s1" hostKey="host-a"/>);
  await vi.waitFor(()=>expect((screen.getByRole('checkbox',{name:'Host browser'}) as HTMLInputElement).checked).toBe(true));
  expect(calls('update_host_browser_settings')).toHaveLength(0);
});
it('names what the browser can reach and writes nothing until the user confirms or keeps it off',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[off],update_host_browser_settings:[on]});
  const box=await turnOn('host-a');
  const confirmation=screen.getByRole('group',{name:'Turn on the host browser for this host?'});
  expect(document.activeElement).toBe(confirmation);
  expect(confirmation.textContent).toMatch(/network and the services listening only on the host/);
  expect(confirmation.textContent).toMatch(/Any file on the host that the browser can open/);
  expect(confirmation.textContent).toMatch(/Every site you sign in to inside it/);
  expect(confirmation.textContent).toMatch(/this device for this host only\. It is never synced/);
  fireEvent.click(within(confirmation).getByRole('button',{name:'Keep it off'}));
  expect(screen.queryByRole('group',{name:/Turn on the host browser/})).toBeNull();
  expect((box as HTMLInputElement).checked).toBe(false);
  expect(calls('update_host_browser_settings')).toHaveLength(0);expect(isHostBrowserConfirmed('host-a')).toBe(false);
});
it('asks once per host on this device, offers the confirmation again for another host and never for turning it off',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[off],update_host_browser_settings:[on,{...off,revision:2},{...on,revision:3}]});
  const first=await turnOn('host-a');allow();
  await screen.findByText('Host browser setting saved for new browser sessions.');
  expect(isHostBrowserConfirmed('host-a')).toBe(true);expect(isHostBrowserConfirmed('host-b')).toBe(false);
  fireEvent.click(first);fireEvent.click(screen.getByRole('button',{name:'Save host browser setting'}));
  await vi.waitFor(()=>expect(calls('update_host_browser_settings')).toHaveLength(2));
  expect(screen.queryByRole('group',{name:/Turn on the host browser/})).toBeNull();
  await vi.waitFor(()=>expect(first.matches(':disabled')).toBe(false));
  fireEvent.click(first);fireEvent.click(screen.getByRole('button',{name:'Save host browser setting'}));
  await vi.waitFor(()=>expect(calls('update_host_browser_settings')).toHaveLength(3));
  expect(screen.queryByRole('group',{name:/Turn on the host browser/})).toBeNull();
  cleanup();
  answer({get_companion_settings:[settings],get_host_browser_settings:[off],update_host_browser_settings:[on]});
  await turnOn('host-b','s2');
  expect(screen.getByRole('group',{name:'Turn on the host browser for this host?'})).toBeTruthy();
  expect(calls('update_host_browser_settings')).toHaveLength(3);
});
it.each([['a save that succeeded',[on],1],['a save that conflicted',[()=>Promise.reject({message:'SettingsConflict'})],0]])('tells whatever offers the Host browser tool about %s',async(_name,updates,told)=>{
  const saved=vi.fn(),stop=onHostBrowserSwitch(saved);
  answer({get_companion_settings:[settings],get_host_browser_settings:[off],update_host_browser_settings:updates});
  try {
    await turnOn('host-a');allow();
    await vi.waitFor(()=>expect(calls('update_host_browser_settings')).toHaveLength(1));
    await screen.findByText(told?'Host browser setting saved for new browser sessions.':/SettingsConflict/);
    expect(saved).toHaveBeenCalledTimes(told);
  } finally {stop();}
});
it('shows a revision conflict, keeps the host unconfirmed and offers the confirmation again',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[off],update_host_browser_settings:[()=>Promise.reject({message:'SettingsConflict'})]});
  await turnOn('host-a');allow();
  await screen.findByText(/SettingsConflict.* Refresh host settings before retrying/);
  expect(screen.queryByText('Host browser setting saved for new browser sessions.')).toBeNull();expect(isHostBrowserConfirmed('host-a')).toBe(false);
  expect(calls('update_host_browser_settings')).toHaveLength(1);
});
it('refreshing the host settings reads the host browser switch again',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[off,on]});
  render(<CompanionSettingsPanel sessionId="s1" hostKey="host-a"/>);
  await vi.waitFor(()=>expect(calls('get_host_browser_settings')).toHaveLength(1));
  await vi.waitFor(()=>expect(screen.getByRole('button',{name:'Refresh host settings'}).matches(':disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'Refresh host settings'}));
  await vi.waitFor(()=>expect((screen.getByRole('checkbox',{name:'Host browser'}) as HTMLInputElement).checked).toBe(true));
  expect(calls('get_host_browser_settings')).toHaveLength(2);
});
it('shows the switch as unavailable with an update message for a companion without the command and never writes',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[unsupported]});
  render(<CompanionSettingsPanel sessionId="s1" hostKey="host-a"/>);
  await screen.findByText(/cannot change the host browser setting\. Update the host companion/);
  const box=screen.getByRole('checkbox',{name:'Host browser'});
  expect(box.matches(':disabled')).toBe(true);expect((box as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByRole('button',{name:'Save host browser setting'})).toBeNull();
  expect(calls('update_host_browser_settings')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:'Save host settings'}));
  expect(calls('update_host_browser_settings')).toHaveLength(0);
});
it('treats a companion that stops answering the command during a save as outdated, not as a conflict',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[off],update_host_browser_settings:[unsupported]});
  await turnOn('host-a');allow();
  await screen.findByText(/cannot change the host browser setting/);
  expect(screen.queryByRole('button',{name:'Save host browser setting'})).toBeNull();expect(isHostBrowserConfirmed('host-a')).toBe(false);
});
it('keeps the confirmation on this device: not in the sync snapshot, and no address, title or frame is stored',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[off],update_host_browser_settings:[on]});
  await turnOn('host-a');allow();
  await screen.findByText('Host browser setting saved for new browser sessions.');
  // What the encrypted settings sync uploads (SyncPanel pushes exactly this).
  const synced=JSON.stringify(syncablePreferences(getPreferences()));
  expect(synced).not.toContain('host-a');expect(synced).not.toMatch(/hostBrowser|confirm/i);
  // Everything the app stored: one device-local list of host ids and nothing else.
  const stored=Object.fromEntries(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)]));
  expect(stored).toEqual({'lazysh.hostBrowserConfirmed.v1':'["host-a"]'});
  expect(sessionStorage.length).toBe(0);
  expect(Object.values(stored).join('')).not.toMatch(/:\/\/|title|frame|url/i);
});

it.each([false,true])('reconciles a hidden save when reopen is before completion: %s',async(reopenBeforeFinish)=>{
  let finish!:(value:typeof on)=>void;
  const pending=new Promise<typeof on>(resolve=>{finish=resolve;});
  answer({get_host_browser_settings:[off,on],update_host_browser_settings:[()=>pending]});
  const view=render(<HostBrowserSwitch sessionId="s1" hostKey="host-a" visible reload={0}/>);
  const box=await screen.findByRole('checkbox',{name:'Host browser'});
  await vi.waitFor(()=>expect(box.matches(':disabled')).toBe(false));
  fireEvent.click(box);fireEvent.click(screen.getByRole('button',{name:'Save host browser setting'}));allow();
  view.rerender(<HostBrowserSwitch sessionId="s1" hostKey="host-a" visible={false} reload={0}/>);
  if(reopenBeforeFinish){
    view.rerender(<HostBrowserSwitch sessionId="s1" hostKey="host-a" visible reload={0}/>);
    await act(async()=>{});
    expect(calls('get_host_browser_settings')).toHaveLength(1);
    expect(box.matches(':disabled')).toBe(true);
  }
  await act(async()=>finish(on));
  if(!reopenBeforeFinish)view.rerender(<HostBrowserSwitch sessionId="s1" hostKey="host-a" visible reload={0}/>);
  await vi.waitFor(()=>expect(calls('get_host_browser_settings')).toHaveLength(2));
  expect((box as HTMLInputElement).checked).toBe(true);
});

it('reconciles a save that completes after the switch remounts',async()=>{
  let finish!:()=>void;
  let remote=off;
  const pending=new Promise<typeof on>(resolve=>{finish=()=>{remote=on;resolve(on);};});
  vi.mocked(invoke).mockImplementation(async command=>command==='get_host_browser_settings'?remote:command==='update_host_browser_settings'?pending:undefined);
  const first=render(<HostBrowserSwitch sessionId="s1" hostKey="host-a" visible reload={0}/>);
  const box=await screen.findByRole('checkbox',{name:'Host browser'});
  await vi.waitFor(()=>expect(box.matches(':disabled')).toBe(false));
  fireEvent.click(box);fireEvent.click(screen.getByRole('button',{name:'Save host browser setting'}));allow();
  first.unmount();
  render(<HostBrowserSwitch sessionId="s1" hostKey="host-a" visible reload={0}/>);
  await act(async()=>{});
  expect(calls('get_host_browser_settings')).toHaveLength(1);
  expect(screen.getByRole('checkbox',{name:'Host browser'}).matches(':disabled')).toBe(true);
  await act(async()=>finish());
  await vi.waitFor(()=>expect(calls('get_host_browser_settings')).toHaveLength(2));
  expect((screen.getByRole('checkbox',{name:'Host browser'}) as HTMLInputElement).checked).toBe(true);
});
