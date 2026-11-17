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
  for(const autoUpdate of [null,{revision:-1,policy:"off"},{revision:1,policy:"always"},{revision:1,policy:"off",channel:"stable"},"off"])expect(()=>parseCompanionSettings({...settings,autoUpdate})).toThrow();
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
it("does not show actionable switches for an unsupported host companion",async()=>{
  vi.mocked(invoke).mockRejectedValue({message:"unknown subcommand settings"});render(<CompanionSettingsPanel sessionId="old"/>);
  await screen.findByRole("alert");expect(screen.queryByRole("checkbox")).toBeNull();expect(screen.queryByRole("button",{name:"Save host settings"})).toBeNull();
});
it("reports update conflicts and keeps settings unacknowledged until refreshed",async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(settings).mockRejectedValueOnce({message:"SettingsConflict"});render(<CompanionSettingsPanel sessionId="host-a"/>);
  fireEvent.click(await screen.findByLabelText("Device tools"));fireEvent.click(screen.getByRole("button",{name:"Save host settings"}));
  await screen.findByText(/Refresh host settings before retrying/);expect(screen.queryByText("Host settings saved for new operations.")).toBeNull();
});
it("requires a refresh after a policy conflict that may follow a partial save",async()=>{
  const initial={...settings,autoUpdate:{revision:2,policy:"install"}};
  const refreshed={...settings,revision:1,recordedUsageEnabled:false,autoUpdate:{revision:3,policy:"notify"}};
  vi.mocked(invoke).mockResolvedValueOnce(initial).mockRejectedValueOnce({message:"SettingsConflict"}).mockResolvedValueOnce(refreshed).mockResolvedValueOnce({...refreshed,revision:2,autoUpdate:{revision:4,policy:"off"}});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  fireEvent.click(await screen.findByLabelText("Recorded usage inspection"));fireEvent.click(screen.getByLabelText("Never"));fireEvent.click(screen.getByRole("button",{name:"Save host settings"}));
  await screen.findByText(/Some settings may have been saved/);expect(screen.queryByRole("button",{name:"Save host settings"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Refresh host settings"}));await screen.findByLabelText("Only tell me");
  fireEvent.click(screen.getByLabelText("Never"));fireEvent.click(screen.getByRole("button",{name:"Save host settings"}));await screen.findByText("Host settings saved for new operations.");
  expect(vi.mocked(invoke).mock.lastCall?.[1]).toMatchObject({settings:{expectedRevision:1,recordedUsageEnabled:false,autoUpdate:{expectedRevision:3,policy:"off"}}});
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
it.each(['success','error'])('refreshes only after a hidden save %s settles',async outcome=>{
  let finish!:(value:unknown)=>void,fail!:(error:unknown)=>void;
  const updated={...settings,revision:1,recordedUsageEnabled:false};
  vi.mocked(invoke).mockResolvedValueOnce(settings).mockImplementationOnce(()=>new Promise((yes,no)=>{finish=yes;fail=no;})).mockResolvedValueOnce(updated);
  const view=render(<CompanionSettingsPanel sessionId="pending-settings"/>);const usage=await screen.findByLabelText('Recorded usage inspection');fireEvent.click(usage);
  fireEvent.click(screen.getByRole('button',{name:'Save host settings'}));view.rerender(<CompanionSettingsPanel sessionId="pending-settings" visible={false}/>);
  view.rerender(<CompanionSettingsPanel sessionId="pending-settings"/>);
  expect(screen.queryByRole('button',{name:'Save host settings'})).toBeNull();expect(invoke).toHaveBeenCalledTimes(2);
  await act(async()=>{if(outcome==='success')finish(updated);else fail('obsolete settings result');});
  expect(await screen.findByLabelText('Recorded usage inspection')).toHaveProperty('checked',false);
  expect(invoke).toHaveBeenCalledTimes(3);expect(vi.mocked(invoke).mock.lastCall?.[0]).toBe('get_companion_settings');
  expect(screen.queryByText('Host settings saved for new operations.')).toBeNull();
  if(outcome==='error')expect(screen.getByRole('alert').textContent).toContain('Some settings may not have been saved');
  else expect(screen.queryByRole('alert')).toBeNull();
});
it('does not invalidate a different host when an old hidden save settles',async()=>{
  let finish!:(value:unknown)=>void;
  vi.mocked(invoke).mockResolvedValueOnce(settings).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce({...settings,revision:7});
  const view=render(<CompanionSettingsPanel sessionId="old-host"/>);fireEvent.click(await screen.findByRole('button',{name:'Save host settings'}));
  view.rerender(<CompanionSettingsPanel sessionId="new-host"/>);await screen.findByLabelText('Device tools');await act(async()=>finish({...settings,revision:1}));
  expect(invoke).toHaveBeenCalledTimes(3);expect(screen.getByRole('button',{name:'Save host settings'})).toBeTruthy();
});
it('waits for an old host save after a keyed unmount and reports its failure on return',async()=>{
  let fail!:(error:unknown)=>void;
  vi.mocked(invoke).mockResolvedValueOnce(settings).mockImplementationOnce(()=>new Promise((_,reject)=>{fail=reject;})).mockResolvedValueOnce({...settings,revision:1,recordedUsageEnabled:false});
  const first=render(<CompanionSettingsPanel key="first" sessionId="return-host"/>);
  fireEvent.click(await screen.findByRole('button',{name:'Save host settings'}));first.unmount();
  render(<CompanionSettingsPanel key="second" sessionId="return-host"/>);
  expect(screen.queryByRole('button',{name:'Save host settings'})).toBeNull();expect(invoke).toHaveBeenCalledTimes(2);
  await act(async()=>fail('policy conflict'));
  expect(await screen.findByLabelText('Recorded usage inspection')).toHaveProperty('checked',false);
  expect(screen.getByRole('alert').textContent).toContain('Some settings may not have been saved');
  expect(invoke).toHaveBeenCalledTimes(3);
});
