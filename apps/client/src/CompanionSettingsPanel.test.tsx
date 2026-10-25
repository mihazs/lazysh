// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
