// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import CompanionSettingsPanel, { parseCompanionSettings } from "./CompanionSettingsPanel";
import { answer, calls } from "./test/routedInvoke";
vi.mock("@tauri-apps/api/core",async original=>({...await original<typeof import("@tauri-apps/api/core")>(),invoke:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const settings={schemaVersion:1 as const,revision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true};
it("requires exact bounded versioned settings rather than coercing malformed host values",()=>{
  expect(parseCompanionSettings(settings)).toEqual(settings);
  for(const value of [null,{...settings,schemaVersion:2},{...settings,revision:-1},{...settings,revision:Number.MAX_SAFE_INTEGER+1},{...settings,recordedUsageEnabled:"true"},{...settings,extra:1}])expect(()=>parseCompanionSettings(value)).toThrow();
});
it("saves actual host settings with the fetched revision and explicit booleans",async()=>{
  answer({get_companion_settings:[settings],update_companion_settings:[{...settings,revision:1,recordedUsageEnabled:false}]});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  const usage=await screen.findByLabelText("Recorded usage inspection");fireEvent.click(usage);fireEvent.click(screen.getByRole("button",{name:"Save host settings"}));
  await screen.findByText("Host settings saved for new operations.");
  expect(calls("update_companion_settings")).toEqual([["update_companion_settings",{sessionId:"host-a",settings:{expectedRevision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:false,deviceToolsEnabled:true}}, { headers: { "X-Lazysh-Access": expect.any(String) } }]]);
  expect(screen.getByText(/Existing previews and streams continue until stopped/)).toBeTruthy();
  expect(screen.getByText(/Port discovery is a separate SSH feature of this app/)).toBeTruthy();
});
it("shows the update policy only for a companion that has one, and saves a change with the fetched revision",async()=>{
  expect(parseCompanionSettings({...settings,autoUpdate:{revision:2,policy:"install"}}).autoUpdate).toEqual({revision:2,policy:"install"});
  for(const autoUpdate of [null,{revision:-1,policy:"off"},{revision:1,policy:"always"},{revision:1,policy:"off",channel:"stable"},"off"])expect(()=>parseCompanionSettings({...settings,autoUpdate})).toThrow();
  answer({get_companion_settings:[{...settings,autoUpdate:{revision:2,policy:"install"}}],update_companion_settings:[{...settings,revision:1,autoUpdate:{revision:3,policy:"off"}}]});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  expect(((await screen.findByLabelText("Update automatically")) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText(/updates itself to this app's version/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Never"));fireEvent.click(screen.getByRole("button",{name:"Save host settings"}));
  await screen.findByText("Host settings saved for new operations.");
  expect(calls("update_companion_settings").at(-1)).toEqual(["update_companion_settings",{sessionId:"host-a",settings:{expectedRevision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true,autoUpdate:{expectedRevision:2,policy:"off"}}}, { headers: { "X-Lazysh-Access": expect.any(String) } }]);
  expect(((screen.getByLabelText("Never")) as HTMLInputElement).checked).toBe(true);
  cleanup();
  answer({get_companion_settings:[settings]});render(<CompanionSettingsPanel sessionId="old-companion"/>);
  await screen.findByLabelText("Device tools");expect(screen.queryByLabelText("Never")).toBeNull();
});
it("does not show actionable switches for an unsupported host companion",async()=>{
  answer({get_companion_settings:[()=>Promise.reject({message:"unknown subcommand settings"})],get_host_browser_settings:[()=>Promise.reject({kind:"host_browser_companion_required",message:"Update the host companion"})]});render(<CompanionSettingsPanel sessionId="old"/>);
  await screen.findByRole("alert");await screen.findByText(/cannot change the host browser setting/);
  for(const checkbox of screen.queryAllByRole("checkbox"))expect(checkbox.matches(":disabled")).toBe(true);
  expect(screen.queryByRole("button",{name:/^Save host/})).toBeNull();
});
it("reports update conflicts and keeps settings unacknowledged until refreshed",async()=>{
  answer({get_companion_settings:[settings],update_companion_settings:[()=>Promise.reject({message:"SettingsConflict"})]});render(<CompanionSettingsPanel sessionId="host-a"/>);
  fireEvent.click(await screen.findByLabelText("Device tools"));fireEvent.click(screen.getByRole("button",{name:"Save host settings"}));
  await screen.findByText(/Refresh host settings before retrying/);expect(screen.queryByText("Host settings saved for new operations.")).toBeNull();
});
it("requires a refresh after a policy conflict that may follow a partial save",async()=>{
  const initial={...settings,autoUpdate:{revision:2,policy:"install"}};
  const refreshed={...settings,revision:1,recordedUsageEnabled:false,autoUpdate:{revision:3,policy:"notify"}};
  answer({get_companion_settings:[initial,refreshed],update_companion_settings:[()=>Promise.reject({message:"SettingsConflict"}),{...refreshed,revision:2,autoUpdate:{revision:4,policy:"off"}}]});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  fireEvent.click(await screen.findByLabelText("Recorded usage inspection"));fireEvent.click(screen.getByLabelText("Never"));fireEvent.click(screen.getByRole("button",{name:"Save host settings"}));
  await screen.findByText(/Some settings may have been saved/);expect(screen.queryByRole("button",{name:"Save host settings"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Refresh host settings"}));await screen.findByLabelText("Only tell me");
  fireEvent.click(screen.getByLabelText("Never"));fireEvent.click(screen.getByRole("button",{name:"Save host settings"}));await screen.findByText("Host settings saved for new operations.");
  expect(calls("update_companion_settings").at(-1)?.[1]).toMatchObject({settings:{expectedRevision:1,recordedUsageEnabled:false,autoUpdate:{expectedRevision:3,policy:"off"}}});
});
it("discards settings arriving after the selected SSH session changes",async()=>{
  let resolve!:(value:unknown)=>void;
  answer({get_companion_settings:[()=>new Promise(result=>{resolve=result;}),{...settings,revision:9,recordedUsageEnabled:false}]});
  const {rerender}=render(<CompanionSettingsPanel sessionId="old"/>);rerender(<CompanionSettingsPanel sessionId="new"/>);
  await screen.findByLabelText("Recorded usage inspection");resolve(settings);
  await waitFor(()=>expect((screen.getByLabelText("Recorded usage inspection") as HTMLInputElement).checked).toBe(false));
  expect(calls("get_companion_settings").at(-1)).toEqual(["get_companion_settings",{sessionId:"new"}, { headers: { "X-Lazysh-Access": expect.any(String) } }]);
});

it('preserves the loaded settings draft across hide/reopen without another host read',async()=>{
  answer({get_companion_settings:[settings],update_companion_settings:[settings]});const view=render(<CompanionSettingsPanel sessionId="draft-owner"/>);
  const usage=await screen.findByLabelText('Recorded usage inspection');fireEvent.click(usage);
  view.rerender(<CompanionSettingsPanel sessionId="draft-owner" visible={false}/>);fireEvent.submit(usage.closest('form')!);expect(calls('update_companion_settings')).toHaveLength(0);
  view.rerender(<CompanionSettingsPanel sessionId="draft-owner"/>);
  expect(screen.getByLabelText('Recorded usage inspection')).toBe(usage);expect(usage).toHaveProperty('checked',false);expect(calls('get_companion_settings')).toHaveLength(1);expect(calls('get_notification_policy')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:'Save host settings'}));await waitFor(()=>expect(calls('update_companion_settings')).toHaveLength(1));
  expect(calls('update_companion_settings')[0][1]).toMatchObject({sessionId:'draft-owner',settings:{expectedRevision:0,recordedUsageEnabled:false}});
});
it('keeps initial hidden settings unread and retires a held load across a hidden source change',async()=>{
  let finish!:(value:unknown)=>void;
  answer({get_companion_settings:[()=>new Promise(resolve=>{finish=resolve;}),{...settings,revision:9,recordedUsageEnabled:false}]});
  const view=render(<CompanionSettingsPanel sessionId="old-source" visible={false}/>);expect(invoke).not.toHaveBeenCalled();
  view.rerender(<CompanionSettingsPanel sessionId="old-source"/>);expect(calls('get_companion_settings')).toHaveLength(1);
  view.rerender(<CompanionSettingsPanel sessionId="new-source" visible={false}/>);await act(async()=>finish(settings));expect(calls('get_companion_settings')).toHaveLength(1);
  view.rerender(<CompanionSettingsPanel sessionId="new-source"/>);
  expect(await screen.findByLabelText('Recorded usage inspection')).toHaveProperty('checked',false);expect(calls('get_companion_settings').at(-1)?.[1]).toEqual({sessionId:'new-source'});
});
it.each(['success','error'])('refreshes only after a hidden save %s settles',async outcome=>{
  let finish!:(value:unknown)=>void,fail!:(error:unknown)=>void;
  const updated={...settings,revision:1,recordedUsageEnabled:false};
  answer({get_companion_settings:[settings,updated],update_companion_settings:[()=>new Promise((yes,no)=>{finish=yes;fail=no;})]});
  const view=render(<CompanionSettingsPanel sessionId="pending-settings"/>);const usage=await screen.findByLabelText('Recorded usage inspection');fireEvent.click(usage);
  fireEvent.click(screen.getByRole('button',{name:'Save host settings'}));view.rerender(<CompanionSettingsPanel sessionId="pending-settings" visible={false}/>);
  view.rerender(<CompanionSettingsPanel sessionId="pending-settings"/>);
  expect(screen.queryByRole('button',{name:'Save host settings'})).toBeNull();expect(calls('get_companion_settings')).toHaveLength(1);expect(calls('update_companion_settings')).toHaveLength(1);
  await act(async()=>{if(outcome==='success')finish(updated);else fail('obsolete settings result');});
  expect(await screen.findByLabelText('Recorded usage inspection')).toHaveProperty('checked',false);
  expect(calls('get_companion_settings')).toHaveLength(2);
  expect(screen.queryByText('Host settings saved for new operations.')).toBeNull();
  if(outcome==='error')expect(screen.getByRole('alert').textContent).toContain('Some settings may not have been saved');
  else expect(screen.queryByRole('alert')).toBeNull();
});
it('does not invalidate a different host when an old hidden save settles',async()=>{
  let finish!:(value:unknown)=>void;
  answer({get_companion_settings:[settings,{...settings,revision:7}],update_companion_settings:[()=>new Promise(resolve=>{finish=resolve;})]});
  const view=render(<CompanionSettingsPanel sessionId="old-host"/>);fireEvent.click(await screen.findByRole('button',{name:'Save host settings'}));
  view.rerender(<CompanionSettingsPanel sessionId="new-host"/>);await screen.findByLabelText('Device tools');await act(async()=>finish({...settings,revision:1}));
  expect(calls('get_companion_settings')).toHaveLength(2);expect(screen.getByRole('button',{name:'Save host settings'})).toBeTruthy();
});
it('waits for an old host save after a keyed unmount and reports its failure on return',async()=>{
  let fail!:(error:unknown)=>void;
  answer({get_companion_settings:[settings,{...settings,revision:1,recordedUsageEnabled:false}],update_companion_settings:[()=>new Promise((_,reject)=>{fail=reject;})]});
  const first=render(<CompanionSettingsPanel key="first" sessionId="return-host"/>);
  fireEvent.click(await screen.findByRole('button',{name:'Save host settings'}));first.unmount();
  render(<CompanionSettingsPanel key="second" sessionId="return-host"/>);
  expect(screen.queryByRole('button',{name:'Save host settings'})).toBeNull();expect(calls('get_companion_settings')).toHaveLength(1);
  await act(async()=>fail('policy conflict'));
  expect(await screen.findByLabelText('Recorded usage inspection')).toHaveProperty('checked',false);
  expect(screen.getByRole('alert').textContent).toContain('Some settings may not have been saved');
  expect(calls('get_companion_settings')).toHaveLength(2);
});

const features={schemaVersion:1 as const,revision:3,simulatorStreamingEnabled:true,portScanEnabled:true};
it("requires exact host feature switches when the companion reports them",()=>{
  expect(parseCompanionSettings({...settings,features})).toEqual({...settings,features});
  expect(parseCompanionSettings({...settings,features:null}).features).toBeNull();
  for(const value of [{...features,extra:1},{...features,portScanEnabled:"true"},{...features,revision:-1},{...features,schemaVersion:2}])expect(()=>parseCompanionSettings({...settings,features:value})).toThrow();
});
it("saves the feature switches through their own revision without touching the host settings",async()=>{
  answer({get_companion_settings:[{...settings,features}],update_host_features:[{...features,revision:4,simulatorStreamingEnabled:false}],update_companion_settings:[{...settings,revision:1,recordedUsageEnabled:false}]});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  fireEvent.click(await screen.findByLabelText("Simulator and emulator streaming"));
  fireEvent.click(screen.getByRole("button",{name:"Save feature switches"}));
  await screen.findByText("Host settings saved for new operations.");
  expect(invoke).toHaveBeenLastCalledWith("update_host_features",{sessionId:"host-a",features:{expectedRevision:3,simulatorStreamingEnabled:false,portScanEnabled:true}},{ headers:{ "X-Lazysh-Access":expect.any(String) } });
  expect(calls("update_companion_settings")).toHaveLength(0);
  expect((screen.getByLabelText("Simulator and emulator streaming") as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText("Port scanning from the app") as HTMLInputElement).checked).toBe(true);
  // A later settings save must send the settings revision, not the feature revision.
  fireEvent.click(screen.getByLabelText("Recorded usage inspection"));fireEvent.click(screen.getByRole("button",{name:"Save host settings"}));
  await waitFor(()=>expect(invoke).toHaveBeenLastCalledWith("update_companion_settings",expect.objectContaining({settings:expect.objectContaining({expectedRevision:0})}),expect.anything()));
});
it("reports a stale feature revision, withdraws the switches and shows the host's values after a refresh",async()=>{
  answer({get_companion_settings:[{...settings,features},{...settings,features:{...features,revision:4,portScanEnabled:false}}],update_host_features:[()=>Promise.reject({message:"SettingsConflict"})]});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  fireEvent.click(await screen.findByLabelText("Port scanning from the app"));fireEvent.click(screen.getByRole("button",{name:"Save feature switches"}));
  await screen.findByText(/Refresh host settings before retrying/);
  expect(screen.queryByText("Host settings saved for new operations.")).toBeNull();
  expect(screen.queryByLabelText("Port scanning from the app")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Refresh host settings"}));
  await waitFor(()=>expect((screen.getByLabelText("Port scanning from the app") as HTMLInputElement).checked).toBe(false));
});
it.each([["a companion without feature switches",{...settings,features:null}],["an older answer without the field",settings]])("offers no feature switches for %s",async(_name,reported)=>{
  answer({get_companion_settings:[reported]});render(<CompanionSettingsPanel sessionId="host-a"/>);
  await screen.findByLabelText("Recorded usage inspection");
  expect(screen.queryByLabelText("Port scanning from the app")).toBeNull();expect(screen.queryByRole("button",{name:"Save feature switches"})).toBeNull();
  expect(screen.getByText(/Feature switches need an updated host companion/)).toBeTruthy();
});
