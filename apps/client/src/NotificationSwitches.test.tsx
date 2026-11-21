// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import CompanionSettingsPanel from "./CompanionSettingsPanel";
import { parseNotificationPolicy } from "./NotificationSwitches";
import { answer, calls } from "./test/routedInvoke";
import { companionSettings, notificationPolicy } from "./test/agentBoardData";
vi.mock("@tauri-apps/api/core",async original=>({...await original<typeof import("@tauri-apps/api/core")>(),invoke:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const header={ headers: { "X-Lazysh-Access": expect.any(String) } };
const nested="Do not notify for nested agents",unlocked="Do not notify while this desktop is unlocked";
const save=()=>fireEvent.click(screen.getByRole("button",{name:"Save notification switches"}));

it("requires the exact versioned policy the companion prints rather than coercing it",()=>{
  expect(parseNotificationPolicy(notificationPolicy)).toEqual(notificationPolicy);
  for(const value of [null,[],{...notificationPolicy,schemaVersion:2},{...notificationPolicy,revision:-1},{...notificationPolicy,revision:Number.MAX_SAFE_INTEGER+1},{...notificationPolicy,nestedAgentSuppressionEnabled:"false"},{...notificationPolicy,extra:1},{schemaVersion:1,revision:0,nestedAgentSuppressionEnabled:false},companionSettings])expect(()=>parseNotificationPolicy(value)).toThrow();
});
it("shows both switches as the companion reports them (off for a host that never saved) and saves each change with the revision it read",async()=>{
  answer({get_companion_settings:[companionSettings],get_notification_policy:[{...notificationPolicy,revision:0}],update_notification_policy:[{...notificationPolicy,revision:1,nestedAgentSuppressionEnabled:true,suppressWhileDesktopUnlocked:true},{...notificationPolicy,revision:2,nestedAgentSuppressionEnabled:true,suppressWhileDesktopUnlocked:false}]});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  const first=await screen.findByLabelText(nested);const second=screen.getByLabelText(unlocked);
  expect(first).toHaveProperty("checked",false);expect(second).toHaveProperty("checked",false);
  fireEvent.click(first);fireEvent.click(second);save();
  await screen.findByText("Notification switches saved for new events.");
  expect(calls("update_notification_policy")[0]).toEqual(["update_notification_policy",{sessionId:"host-a",policy:{expectedRevision:0,nestedAgentSuppressionEnabled:true,suppressWhileDesktopUnlocked:true}},header]);
  fireEvent.click(second);save();
  await waitFor(()=>expect(calls("update_notification_policy")).toHaveLength(2));
  expect(calls("update_notification_policy")[1][1]).toEqual({sessionId:"host-a",policy:{expectedRevision:1,nestedAgentSuppressionEnabled:true,suppressWhileDesktopUnlocked:false}});
  await waitFor(()=>expect(second).toHaveProperty("checked",false));expect(first).toHaveProperty("checked",true);
  expect(calls("update_companion_settings")).toHaveLength(0);
});
it("tells the user which hosts and detection each switch covers",async()=>{
  answer({get_companion_settings:[companionSettings]});render(<CompanionSettingsPanel sessionId="host-a"/>);
  await screen.findByLabelText(unlocked);
  expect(screen.getByText(/Works on Linux hosts only; on any other host.*always notified/)).toBeTruthy();
  expect(screen.getByText(/process ancestry on Linux and macOS, and through LAZYSH_PARENT_SESSION_ID on every host/)).toBeTruthy();
});
it("offers no notification switch to a companion that cannot answer, and keeps the three host switches working",async()=>{
  answer({get_companion_settings:[companionSettings],get_notification_policy:[()=>Promise.reject({kind:"notification_policy_companion_required",message:"Update the host companion to change the notification switches"})],update_companion_settings:[{...companionSettings,revision:8,deviceToolsEnabled:false}]});
  render(<CompanionSettingsPanel sessionId="old-companion"/>);
  await screen.findByText("The notification switches need a newer host companion. Update the companion on this host to change them.");
  expect(screen.queryByLabelText(nested)).toBeNull();expect(screen.queryByLabelText(unlocked)).toBeNull();expect(screen.queryByRole("button",{name:"Save notification switches"})).toBeNull();expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByLabelText("Device tools"));fireEvent.click(screen.getByRole("button",{name:"Save host settings"}));
  await screen.findByText("Host settings saved for new operations.");
});
it("shows the companion's own failure instead of switches when the policy cannot be read",async()=>{
  answer({get_companion_settings:[companionSettings],get_notification_policy:[()=>Promise.reject({message:"Remote command exited with status Some(1)"}),notificationPolicy]});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  expect((await screen.findByRole("alert")).textContent).toBe("Remote command exited with status Some(1)");
  expect(screen.queryByLabelText(nested)).toBeNull();expect(screen.getByLabelText("Device tools")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Refresh host settings"}));
  await screen.findByLabelText(nested);expect(screen.queryByRole("alert")).toBeNull();
});
it("keeps the draft after a revision conflict and reads the host's current policy on refresh",async()=>{
  answer({get_companion_settings:[companionSettings],get_notification_policy:[notificationPolicy,{...notificationPolicy,revision:4,suppressWhileDesktopUnlocked:true}],update_notification_policy:[()=>Promise.reject({message:"NotificationPolicyConflict"})]});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  fireEvent.click(await screen.findByLabelText(nested));save();
  expect((await screen.findByRole("alert")).textContent).toBe("NotificationPolicyConflict Some settings may have been saved. Refresh host settings before retrying.");
  expect(screen.getByLabelText(nested)).toHaveProperty("checked",true);expect(screen.queryByText("Notification switches saved for new events.")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Refresh host settings"}));
  await waitFor(()=>expect(screen.getByLabelText(unlocked)).toHaveProperty("checked",true));
  expect(screen.getByLabelText(nested)).toHaveProperty("checked",false);expect(screen.queryByRole("alert")).toBeNull();
  expect(calls("get_notification_policy")).toHaveLength(2);
});
it("discards a policy that arrives after the selected SSH session changed",async()=>{
  let late!:(value:unknown)=>void;
  answer({get_companion_settings:[companionSettings],get_notification_policy:[(args:{sessionId:string})=>args.sessionId==="old"?new Promise(resolve=>{late=resolve;}):{...notificationPolicy,revision:9,nestedAgentSuppressionEnabled:true}]});
  const view=render(<CompanionSettingsPanel sessionId="old"/>);
  await waitFor(()=>expect(calls("get_notification_policy")).toHaveLength(1));
  view.rerender(<CompanionSettingsPanel sessionId="new"/>);
  await waitFor(()=>expect(screen.getByLabelText(nested)).toHaveProperty("checked",true));
  late({...notificationPolicy,revision:1,suppressWhileDesktopUnlocked:true});
  await new Promise(resolve=>setTimeout(resolve,20));
  expect(screen.getByLabelText(nested)).toHaveProperty("checked",true);expect(screen.getByLabelText(unlocked)).toHaveProperty("checked",false);
  save();await waitFor(()=>expect(calls("update_notification_policy")).toHaveLength(1));
  expect(calls("update_notification_policy")[0][1]).toEqual({sessionId:"new",policy:{expectedRevision:9,nestedAgentSuppressionEnabled:true,suppressWhileDesktopUnlocked:false}});
});
it("ignores an older policy read that finishes after a refresh already supplied a newer one",async()=>{
  const finish:((value:unknown)=>void)[]=[];
  answer({get_companion_settings:[companionSettings],get_notification_policy:[()=>new Promise(resolve=>{finish.push(resolve);})]});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  await waitFor(()=>expect(finish).toHaveLength(1));
  fireEvent.click(screen.getByRole("button",{name:"Refresh host settings"}));
  await waitFor(()=>expect(finish).toHaveLength(2));
  finish[1]({...notificationPolicy,revision:5,suppressWhileDesktopUnlocked:true});
  await waitFor(()=>expect(screen.getByLabelText(unlocked)).toHaveProperty("checked",true));
  finish[0]({...notificationPolicy,revision:1,nestedAgentSuppressionEnabled:true});
  await new Promise(resolve=>setTimeout(resolve,20));
  expect(screen.getByLabelText(unlocked)).toHaveProperty("checked",true);expect(screen.getByLabelText(nested)).toHaveProperty("checked",false);
});
it("does not read the policy for a hidden panel and reads it once when the panel is shown",async()=>{
  answer({get_companion_settings:[companionSettings]});
  const view=render(<CompanionSettingsPanel sessionId="host-a" visible={false}/>);
  expect(invoke).not.toHaveBeenCalled();
  view.rerender(<CompanionSettingsPanel sessionId="host-a"/>);
  const form=(await screen.findByLabelText(nested)).closest("form")!;
  expect(within(form).getByRole("button",{name:"Save notification switches"})).toBeTruthy();expect(calls("get_notification_policy")).toHaveLength(1);
});

it("refreshes a previously loaded policy when the panel is hidden and shown again",async()=>{
  answer({get_companion_settings:[companionSettings],get_notification_policy:[notificationPolicy,{...notificationPolicy,revision:1,suppressWhileDesktopUnlocked:true}]});
  const view=render(<CompanionSettingsPanel sessionId="host-a"/>);
  expect(await screen.findByLabelText(unlocked)).toHaveProperty("checked",false);
  view.rerender(<CompanionSettingsPanel sessionId="host-a" visible={false}/>);
  view.rerender(<CompanionSettingsPanel sessionId="host-a"/>);
  await waitFor(()=>expect(screen.getByLabelText(unlocked)).toHaveProperty("checked",true));
  expect(calls("get_notification_policy")).toHaveLength(2);
});

it("waits for an in-flight save before reading after hide and reopen",async()=>{
  let finish!:(value:unknown)=>void;
  const updated={...notificationPolicy,revision:1,nestedAgentSuppressionEnabled:true};
  answer({get_companion_settings:[companionSettings],get_notification_policy:[notificationPolicy,updated],update_notification_policy:[()=>new Promise(resolve=>{finish=resolve;})]});
  const view=render(<CompanionSettingsPanel sessionId="host-a"/>);
  fireEvent.click(await screen.findByLabelText(nested));save();
  await waitFor(()=>expect(calls("update_notification_policy")).toHaveLength(1));
  view.rerender(<CompanionSettingsPanel sessionId="host-a" visible={false}/>);
  view.rerender(<CompanionSettingsPanel sessionId="host-a"/>);
  expect(calls("get_notification_policy")).toHaveLength(1);
  expect(screen.queryByRole("button",{name:"Save notification switches"})).toBeNull();
  finish(updated);
  await waitFor(()=>expect(calls("get_notification_policy")).toHaveLength(2));
  expect((await screen.findByLabelText(nested))).toHaveProperty("checked",true);
  save();
  await waitFor(()=>expect(calls("update_notification_policy")).toHaveLength(2));
  expect(calls("update_notification_policy")[1][1]).toMatchObject({policy:{expectedRevision:1}});
});

it("admits only one save when the form is submitted twice synchronously",async()=>{
  let finish!:(value:unknown)=>void;
  answer({get_companion_settings:[companionSettings],update_notification_policy:[()=>new Promise(resolve=>{finish=resolve;})]});
  render(<CompanionSettingsPanel sessionId="host-a"/>);
  const form=(await screen.findByLabelText(nested)).closest("form")!;
  act(()=>{fireEvent.submit(form);fireEvent.submit(form);});
  expect(calls("update_notification_policy")).toHaveLength(1);
  finish({...notificationPolicy,revision:1});
  await screen.findByText("Notification switches saved for new events.");
});
