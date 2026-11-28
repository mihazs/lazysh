// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import CompanionSettingsPanel from './CompanionSettingsPanel';
import HostBrowserSwitch,{parseHostBrowserSettings} from './HostBrowserSwitch';
import {parseCleared} from './HostBrowserProfile';
import {isHostBrowserConfirmed,isHostBrowserKeepProfile} from './hostBrowserConfirmation';
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

// Keep profile and Clear browser data, the other half of the Host browser row.
const cleared=(value:boolean)=>({schemaVersion:1,cleared:value});
const keep=()=>screen.getByRole('checkbox',{name:'Keep profile'}) as HTMLInputElement;
const ready=()=>vi.waitFor(()=>expect(keep().disabled).toBe(false));
const open=()=>fireEvent.click(screen.getByRole('button',{name:'Clear browser data'}));
const confirm=()=>fireEvent.click(screen.getByRole('button',{name:'Delete browser data'}));
const panel=(host='host-a',session='s1')=>render(<CompanionSettingsPanel sessionId={session} hostKey={host}/>);

it('requires the exact versioned answer of the companion',()=>{
  expect(parseCleared(cleared(true))).toEqual(cleared(true));
  for(const value of [null,[],{schemaVersion:2,cleared:true},{schemaVersion:1,cleared:'true'},{schemaVersion:1},{...cleared(true),profile:'/home/user/.local/state/lazysh/host-browser/kept'}])expect(()=>parseCleared(value)).toThrow();
});
it('keeps the profile only when chosen, per host and on this device',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[off]});
  const view=panel('host-a');
  expect(keep().checked).toBe(false);
  expect(screen.getByText(/cookies and sign-ins stay on this host's disk until you use Clear browser data/)).toBeTruthy();
  await ready();fireEvent.click(keep());
  expect(keep().checked).toBe(true);expect(isHostBrowserKeepProfile('host-a')).toBe(true);expect(isHostBrowserKeepProfile('host-b')).toBe(false);
  view.unmount();
  // Another host starts off; the first one is remembered.
  panel('host-b','s2');expect(keep().checked).toBe(false);cleanup();
  panel('host-a');expect(keep().checked).toBe(true);
  await ready();fireEvent.click(keep());
  expect(keep().checked).toBe(false);expect(isHostBrowserKeepProfile('host-a')).toBe(false);
});
it('keeps the choice on this device: not in the sync snapshot, and no address, title or frame is stored',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[off]});
  panel('host-a');await ready();fireEvent.click(keep());
  // What the encrypted settings sync uploads (SyncPanel pushes exactly this).
  const synced=JSON.stringify(syncablePreferences(getPreferences()));
  expect(synced).not.toContain('host-a');expect(synced).not.toMatch(/hostBrowser|keepProfile|keep-profile/i);
  // Everything the app stored: one device-local list of host ids and nothing else.
  const stored=Object.fromEntries(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)]));
  expect(stored).toEqual({'lazysh.hostBrowserKeepProfile.v1':'["host-a"]'});
  expect(sessionStorage.length).toBe(0);
  expect(Object.values(stored).join('')).not.toMatch(/:\/\/|title|frame|url/i);
});
it('offers Keep profile only while the host browser settings can be read, and Clear browser data regardless',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[unsupported]});
  panel();
  await screen.findByText(/cannot change the host browser setting/);
  expect(keep().disabled).toBe(true);
  expect((screen.getByRole('button',{name:'Clear browser data'}) as HTMLButtonElement).disabled).toBe(false);
});
it('offers Clear browser data with the host browser switch off and names what the confirmation deletes before anything runs',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[off],host_browser_clear_data:[cleared(true)]});
  panel();
  await vi.waitFor(()=>expect((screen.getByRole('button',{name:'Clear browser data'}) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole('checkbox',{name:'Host browser'}) as HTMLInputElement).checked).toBe(false);
  open();
  const group=screen.getByRole('group',{name:'Clear the browser data kept on this host?'});
  expect(document.activeElement).toBe(group);
  expect(group.textContent).toMatch(/deletes the kept browser profile directory on this host/);
  expect(group.textContent).toMatch(/cookies, sign-ins and site data that Keep profile saved/);
  expect(group.textContent).toMatch(/cannot be undone/);
  expect(calls('host_browser_clear_data')).toHaveLength(0);
  fireEvent.click(within(group).getByRole('button',{name:'Cancel'}));
  expect(screen.queryByRole('group',{name:/Clear the browser data/})).toBeNull();
  expect(calls('host_browser_clear_data')).toHaveLength(0);
  expect(document.activeElement).toBe(screen.getByRole('button',{name:'Clear browser data'}));
  open();confirm();
  await screen.findByText('Browser data cleared: the kept profile was deleted from this host.');
  expect(calls('host_browser_clear_data')).toEqual([['host_browser_clear_data',{sessionId:'s1'},access]]);
  expect(calls('update_host_browser_settings')).toHaveLength(0);
  expect(document.activeElement).toBe(screen.getByRole('button',{name:'Clear browser data'}));
});
it('says when there was nothing to clear',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[off],host_browser_clear_data:[cleared(false)]});
  panel();open();confirm();
  await screen.findByText('Nothing to clear: this host keeps no browser profile.');
  expect(screen.queryByText(/Browser data cleared/)).toBeNull();
});
it('shows an update message for a companion that predates the flag and sends nothing else',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[off],host_browser_clear_data:[unsupported]});
  panel();open();confirm();
  await screen.findByText("This host's companion cannot clear browser data. Update the host companion, then try again.");
  expect(calls('host_browser_clear_data')).toHaveLength(1);expect(calls('update_host_browser_settings')).toHaveLength(0);expect(calls('update_companion_settings')).toHaveLength(0);
});
it('names a profile that a running browser holds, and keeps other failures as they are',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[off],host_browser_clear_data:[()=>Promise.reject({kind:'remote_command_failed',message:'BrowserProfileInUse'}),()=>Promise.reject({kind:'disconnected',message:'Session closed'}),cleared(true)]});
  panel();open();confirm();
  await screen.findByText('A host browser session is using the kept profile. Stop it, then clear browser data again.');
  open();confirm();
  expect((await screen.findByRole('alert')).textContent).toBe('Session closed');
  expect(screen.queryByText(/is using the kept profile/)).toBeNull();
  open();confirm();
  await screen.findByText('Browser data cleared: the kept profile was deleted from this host.');
  expect(screen.queryByRole('alert')).toBeNull();
});
it('treats an answer of another shape as an unsupported companion and shows nothing as cleared',async()=>{
  answer({get_companion_settings:[settings],get_host_browser_settings:[off],host_browser_clear_data:[{schemaVersion:1,cleared:true,profile:'/home/user/x'}]});
  panel();open();confirm();
  expect((await screen.findByRole('alert')).textContent).toMatch(/Unsupported companion settings/);
  expect(screen.queryByText(/Browser data cleared/)).toBeNull();
});
