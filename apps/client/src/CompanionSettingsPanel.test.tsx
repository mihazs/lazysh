// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import CompanionSettingsPanel, { parseCompanionSettings } from "./CompanionSettingsPanel";
vi.mock("@tauri-apps/api/core",async original=>({...await original<typeof import("@tauri-apps/api/core")>(),invoke:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const settings={schemaVersion:1 as const,revision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true};
it("requires exact bounded versioned settings rather than coercing malformed host values",()=>{
  expect(parseCompanionSettings(settings)).toEqual(settings);
  for(const value of [null,{...settings,schemaVersion:2},{...settings,revision:-1},{...settings,revision:Number.MAX_SAFE_INTEGER+1},{...settings,recordedUsageEnabled:"true"},{...settings,extra:1}])expect(()=>parseCompanionSettings(value)).toThrow();
});
it("saves actual host settings with the fetched revision and explicit booleans",async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(settings).mockResolvedValueOnce({...settings,revision:1,recordedUsageEnabled:false});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  const usage=await screen.findByLabelText("Recorded usage inspection");fireEvent.click(usage);fireEvent.click(screen.getByRole("button",{name:"Save host settings"}));
  await screen.findByText("Host settings saved for new operations.");
  expect(invoke).toHaveBeenLastCalledWith("update_companion_settings",{sessionId:"host-a",settings:{expectedRevision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:false,deviceToolsEnabled:true}}, { headers: { "X-Lazysh-Access": expect.any(String) } });
  expect(screen.getByText(/Existing previews and streams continue until stopped/)).toBeTruthy();
  expect(screen.getByText(/Port discovery is a separate SSH feature/)).toBeTruthy();
});
it("shows the update policy only for a companion that has one, and saves a change with the fetched revision",async()=>{
  expect(parseCompanionSettings({...settings,autoUpdate:{revision:2,policy:"install"}}).autoUpdate).toEqual({revision:2,policy:"install"});
  for(const autoUpdate of [null,{revision:-1,policy:"off"},{revision:1,policy:"always"},{revision:1,policy:"off",metered:true},"off"])expect(()=>parseCompanionSettings({...settings,autoUpdate})).toThrow();
  vi.mocked(invoke).mockResolvedValueOnce({...settings,autoUpdate:{revision:2,policy:"install"}}).mockResolvedValueOnce({...settings,revision:1,autoUpdate:{revision:3,policy:"off"}});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  expect(((await screen.findByLabelText("Update automatically")) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText(/updates itself to this app's version/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Never"));fireEvent.click(screen.getByRole("button",{name:"Save host settings"}));
  await screen.findByText("Host settings saved for new operations.");
  expect(invoke).toHaveBeenLastCalledWith("update_companion_settings",{sessionId:"host-a",settings:{expectedRevision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true,autoUpdate:{expectedRevision:2,policy:"off"}}}, { headers: { "X-Lazysh-Access": expect.any(String) } });
  expect(((screen.getByLabelText("Never")) as HTMLInputElement).checked).toBe(true);
  cleanup();
  vi.mocked(invoke).mockResolvedValueOnce(settings);render(<CompanionSettingsPanel sessionId="old-companion"/>);
  await screen.findByLabelText("Device tools");expect(screen.queryByLabelText("Never")).toBeNull();
});
const scheduled={revision:2,policy:"install" as const,channel:"stable" as const,intervalHours:24,window:null,lastCheck:{at:"2026-11-13T10:00:00Z",latest:"1.60.0",available:true}};
it("accepts the schedule a companion with scheduled checks reports and refuses anything out of range",()=>{
  expect(parseCompanionSettings({...settings,autoUpdate:scheduled}).autoUpdate).toEqual(scheduled);
  expect(parseCompanionSettings({...settings,autoUpdate:{...scheduled,window:"22:00-06:00",lastCheck:{...scheduled.lastCheck,latest:null,available:false}}}).autoUpdate?.window).toBe("22:00-06:00");
  for(const change of [{channel:"nightly"},{intervalHours:0},{intervalHours:721},{intervalHours:1.5},{window:"25:00-06:00"},{window:"06:00-06:00"},{window:"6:00-7:00"},{window:"06:00-07:00; reboot"},{lastCheck:{...scheduled.lastCheck,at:"now; id"}},{lastCheck:{at:"2026-11-13T10:00:00Z",latest:"1.60.0"}},{metered:false}])
    expect(()=>parseCompanionSettings({...settings,autoUpdate:{...scheduled,...change}}),JSON.stringify(change)).toThrow();
});
it("shows what the last check found and saves the whole schedule only when it changed",async()=>{
  vi.mocked(invoke).mockResolvedValueOnce({...settings,autoUpdate:scheduled}).mockResolvedValueOnce({...settings,revision:1,autoUpdate:{...scheduled,revision:3,channel:"prerelease",intervalHours:6,window:"22:00-06:00"}});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  expect((await screen.findByText(/Update available/)).textContent).toBe("Update available: version 1.60.0");
  expect(((screen.getByLabelText("Check every (hours)")) as HTMLInputElement).value).toBe("24");
  expect(screen.queryByLabelText("From")).toBeNull();
  fireEvent.change(screen.getByLabelText("Releases to follow"),{target:{value:"prerelease"}});
  fireEvent.change(screen.getByLabelText("Check every (hours)"),{target:{value:"6"}});
  fireEvent.click(screen.getByLabelText("Only install between certain hours"));
  fireEvent.change(screen.getByLabelText("From"),{target:{value:"22:00"}});fireEvent.change(screen.getByLabelText("Until"),{target:{value:"06:00"}});
  fireEvent.click(screen.getByRole("button",{name:"Save host settings"}));
  await screen.findByText("Host settings saved for new operations.");
  expect(invoke).toHaveBeenLastCalledWith("update_companion_settings",{sessionId:"host-a",settings:{expectedRevision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true,autoUpdate:{expectedRevision:2,policy:"install",schedule:{channel:"prerelease",intervalHours:6,window:"22:00-06:00"}}}}, { headers: { "X-Lazysh-Access": expect.any(String) } });
  expect(((screen.getByLabelText("Releases to follow")) as HTMLSelectElement).value).toBe("prerelease");
  // Saving something else leaves the schedule alone.
  cleanup();vi.mocked(invoke).mockResolvedValueOnce({...settings,autoUpdate:scheduled}).mockResolvedValueOnce({...settings,revision:1,recordedUsageEnabled:false,autoUpdate:scheduled});
  render(<CompanionSettingsPanel sessionId="host-b"/>);
  fireEvent.click(await screen.findByLabelText("Recorded usage inspection"));fireEvent.click(screen.getByRole("button",{name:"Save host settings"}));
  await screen.findByText("Host settings saved for new operations.");
  expect(vi.mocked(invoke).mock.lastCall?.[1]).toEqual({sessionId:"host-b",settings:{expectedRevision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:false,deviceToolsEnabled:true}});
});
it("keeps the schedule when only the policy changes",async()=>{
  vi.mocked(invoke).mockResolvedValueOnce({...settings,autoUpdate:{...scheduled,intervalHours:6,window:"22:00-06:00"}}).mockResolvedValueOnce({...settings,revision:1,autoUpdate:{...scheduled,revision:3,policy:"notify",intervalHours:6,window:"22:00-06:00"}});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  fireEvent.click(await screen.findByLabelText("Only tell me"));
  expect(((screen.getByLabelText("Check every (hours)")) as HTMLInputElement).value).toBe("6");
  fireEvent.click(screen.getByRole("button",{name:"Save host settings"}));
  await screen.findByText("Host settings saved for new operations.");
  expect(vi.mocked(invoke).mock.lastCall?.[1]).toMatchObject({settings:{autoUpdate:{expectedRevision:2,policy:"notify",schedule:{channel:"stable",intervalHours:6,window:"22:00-06:00"}}}});
});
it("says when nothing is waiting or nothing was checked, and shows no schedule for a companion without scheduled checks",async()=>{
  vi.mocked(invoke).mockResolvedValueOnce({...settings,autoUpdate:{...scheduled,lastCheck:{at:"2026-11-13T10:00:00Z",latest:"1.60.0",available:false}}});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  expect((await screen.findByText(/No update is waiting\. Last checked/)).textContent).toMatch(/2026|13/);
  expect(screen.queryByText(/Update available/)).toBeNull();
  cleanup();
  const {lastCheck:_,...unchecked}=scheduled;
  vi.mocked(invoke).mockResolvedValueOnce({...settings,autoUpdate:unchecked});render(<CompanionSettingsPanel sessionId="host-b"/>);
  expect(await screen.findByText("This host has not checked for updates yet.")).toBeTruthy();
  cleanup();
  vi.mocked(invoke).mockResolvedValueOnce({...settings,autoUpdate:{revision:2,policy:"install"}});render(<CompanionSettingsPanel sessionId="host-c"/>);
  await screen.findByLabelText("Never");
  for(const label of ["Releases to follow","Check every (hours)","Only install between certain hours"])expect(screen.queryByLabelText(label)).toBeNull();
});
it("turns the schedule controls off with updates and will not save an interval outside 1 to 720",async()=>{
  vi.mocked(invoke).mockResolvedValueOnce({...settings,autoUpdate:scheduled});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  const interval=await screen.findByLabelText("Check every (hours)") as HTMLInputElement;
  for(const bad of ["0","721","","1.5"]){
    fireEvent.change(interval,{target:{value:bad}});
    expect((screen.getByRole("button",{name:"Save host settings"}) as HTMLButtonElement).disabled,bad).toBe(true);
  }
  fireEvent.change(interval,{target:{value:"720"}});
  expect((screen.getByRole("button",{name:"Save host settings"}) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByLabelText("Never"));
  expect(interval.disabled).toBe(true);
  expect((screen.getByLabelText("Releases to follow") as HTMLSelectElement).disabled).toBe(true);
});
it("does not show actionable switches for an unsupported host companion",async()=>{
  vi.mocked(invoke).mockRejectedValue({message:"unknown subcommand settings"});render(<CompanionSettingsPanel sessionId="old"/>);
  await screen.findByRole("alert");expect(screen.queryByRole("checkbox")).toBeNull();expect(screen.queryByRole("button",{name:"Save host settings"})).toBeNull();
});
it("reports update conflicts and keeps settings unacknowledged until refreshed",async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(settings).mockRejectedValueOnce({message:"SettingsConflict"});render(<CompanionSettingsPanel sessionId="host-a"/>);
  fireEvent.click(await screen.findByLabelText("Device tools"));fireEvent.click(screen.getByRole("button",{name:"Save host settings"}));
  await screen.findByText(/Refresh host settings before retrying/);expect(screen.queryByText("Host settings saved for new operations.")).toBeNull();
});
it("discards settings arriving after the selected SSH session changes",async()=>{
  let resolve!:(value:unknown)=>void;
  vi.mocked(invoke).mockReturnValueOnce(new Promise(result=>{resolve=result;})).mockResolvedValueOnce({...settings,revision:9,recordedUsageEnabled:false});
  const {rerender}=render(<CompanionSettingsPanel sessionId="old"/>);rerender(<CompanionSettingsPanel sessionId="new"/>);
  await screen.findByLabelText("Recorded usage inspection");resolve(settings);
  await waitFor(()=>expect((screen.getByLabelText("Recorded usage inspection") as HTMLInputElement).checked).toBe(false));
  expect(invoke).toHaveBeenLastCalledWith("get_companion_settings",{sessionId:"new"}, { headers: { "X-Lazysh-Access": expect.any(String) } });
});

it('preserves the loaded settings draft across hide/reopen without another host read',async()=>{
  vi.mocked(invoke).mockResolvedValue(settings);const view=render(<CompanionSettingsPanel sessionId="draft-owner"/>);
  const usage=await screen.findByLabelText('Recorded usage inspection');fireEvent.click(usage);
  view.rerender(<CompanionSettingsPanel sessionId="draft-owner" visible={false}/>);fireEvent.submit(usage.closest('form')!);expect(invoke).toHaveBeenCalledTimes(1);
  view.rerender(<CompanionSettingsPanel sessionId="draft-owner"/>);
  expect(screen.getByLabelText('Recorded usage inspection')).toBe(usage);expect(usage).toHaveProperty('checked',false);expect(invoke).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Save host settings'}));await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(2));
  expect(vi.mocked(invoke).mock.lastCall?.[1]).toMatchObject({sessionId:'draft-owner',settings:{expectedRevision:0,recordedUsageEnabled:false}});
});
it('keeps initial hidden settings unread and retires a held load across a hidden source change',async()=>{
  let finish!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue({...settings,revision:9,recordedUsageEnabled:false});
  const view=render(<CompanionSettingsPanel sessionId="old-source" visible={false}/>);expect(invoke).not.toHaveBeenCalled();
  view.rerender(<CompanionSettingsPanel sessionId="old-source"/>);expect(invoke).toHaveBeenCalledTimes(1);
  view.rerender(<CompanionSettingsPanel sessionId="new-source" visible={false}/>);await act(async()=>finish(settings));expect(invoke).toHaveBeenCalledTimes(1);
  view.rerender(<CompanionSettingsPanel sessionId="new-source"/>);
  expect(await screen.findByLabelText('Recorded usage inspection')).toHaveProperty('checked',false);expect(vi.mocked(invoke).mock.lastCall?.[1]).toEqual({sessionId:'new-source'});
});
it.each(['success','error'])('does not apply a held settings save %s after hiding, retaining the original draft',async outcome=>{
  let finish!:(value:unknown)=>void,fail!:(error:unknown)=>void;
  vi.mocked(invoke).mockResolvedValueOnce(settings).mockImplementationOnce(()=>new Promise((yes,no)=>{finish=yes;fail=no;}));
  const view=render(<CompanionSettingsPanel sessionId="pending-settings"/>);const usage=await screen.findByLabelText('Recorded usage inspection');fireEvent.click(usage);
  fireEvent.click(screen.getByRole('button',{name:'Save host settings'}));view.rerender(<CompanionSettingsPanel sessionId="pending-settings" visible={false}/>);
  await act(async()=>{if(outcome==='success')finish({...settings,revision:1});else fail('obsolete settings result');});
  view.rerender(<CompanionSettingsPanel sessionId="pending-settings"/>);
  expect(screen.getByLabelText('Recorded usage inspection')).toBe(usage);expect(usage).toHaveProperty('checked',false);
  expect(screen.queryByText('Host settings saved for new operations.')).toBeNull();expect(screen.queryByText('obsolete settings result')).toBeNull();expect(invoke).toHaveBeenCalledTimes(2);
});
