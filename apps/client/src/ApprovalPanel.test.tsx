// @vitest-environment jsdom
import { cleanupNativeMocks } from "./test/nativeCoreMock";
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import ApprovalPanel, { parseApprovals } from "./ApprovalPanel";
vi.mock("@tauri-apps/api/core", async original => (await import("./test/nativeCoreMock")).mockNativeCore(original));
afterEach(cleanupNativeMocks);

const request = {
  id: "b714333f-82b1-4ee0-a383-6fd6dc1eca01",
  expectedHash: "a".repeat(64),
  agent: "claude",
  sessionId: "agent-session",
  project: "/work",
  paneId: "%7",
  toolName: "Bash",
  toolInput: { command: "git status" },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 300000).toISOString(),
};
it("binds an explicit decision to the exact pending request without terminal input", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "agent_approvals"
      ? { schemaVersion: 1, requests: [request] }
      : { schemaVersion: 1, accepted: true },
  );
  render(<ApprovalPanel sessionId="ssh1" />);
  const allow = await screen.findByRole("button", {
    name: "Allow this request",
  });
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "agent_approvals",
  ]);
  fireEvent.click(allow);
  await screen.findByText(
    "Only requests from a waiting lazysh approval hook can be answered here. Other agent prompts stay in the terminal.",
  );
  expect(invoke).toHaveBeenLastCalledWith("resolve_agent_approval", {
    sessionId: "ssh1",
    id: request.id,
    expectedHash: request.expectedHash,
    agentSessionId: "agent-session",
    paneId: "%7",
    decision: "allow",
  }, { headers: { "X-Lazysh-Access": expect.any(String) } });
});
it("keeps rejected/stale decisions visible as an error instead of pretending success", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "agent_approvals")
      return { schemaVersion: 1, requests: [request] };
    throw { message: "Request is no longer pending" };
  });
  render(<ApprovalPanel sessionId="ssh1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Deny request" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Request is no longer pending",
  );
  expect(
    screen.getByRole("button", { name: "Allow this request" }),
  ).toBeTruthy();
});
it("rejects malformed request hashes, ambiguous panes and unbounded payloads", () => {
  expect(parseApprovals({ schemaVersion: 1, requests: [request] })).toEqual([
    request,
  ]);
  for (const row of [
    { ...request, expectedHash: "a" },
    { ...request, paneId: "%7;command" },
    { ...request, toolInput: "x".repeat(32769) },
  ])
    expect(() =>
      parseApprovals({ schemaVersion: 1, requests: [row] }),
    ).toThrow();
});

it('does not read approvals or keep its interval active while hidden',async()=>{
  vi.useFakeTimers();
  try {
    vi.mocked(invoke).mockResolvedValue({schemaVersion:1,requests:[request]});
    const view=render(<ApprovalPanel sessionId="visible-owner" visible={false}/>);
    await act(async()=>{await vi.advanceTimersByTimeAsync(30000);});expect(invoke).not.toHaveBeenCalled();
    view.rerender(<ApprovalPanel sessionId="visible-owner"/>);await act(async()=>{});expect(invoke).toHaveBeenCalledTimes(1);
    view.rerender(<ApprovalPanel sessionId="visible-owner" visible={false}/>);
    await act(async()=>{await vi.advanceTimersByTimeAsync(30000);});expect(invoke).toHaveBeenCalledTimes(1);
    view.rerender(<ApprovalPanel sessionId="visible-owner"/>);await act(async()=>{});expect(invoke).toHaveBeenCalledTimes(2);
  } finally {vi.useRealTimers();}
});
it.each(['accepted','rejected'])('retires an old hidden decision %s without changing the reopened owner',async outcome=>{
  let complete!:(value:unknown)=>void,fail!:(error:unknown)=>void;
  vi.mocked(invoke).mockImplementation(command=>command==='agent_approvals'?Promise.resolve({schemaVersion:1,requests:[request]}):new Promise((yes,no)=>{complete=yes;fail=no;}));
  const view=render(<ApprovalPanel sessionId="original-ssh"/>);fireEvent.click(await screen.findByRole('button',{name:'Allow this request'}));
  view.rerender(<ApprovalPanel sessionId="original-ssh" visible={false}/>);view.rerender(<ApprovalPanel sessionId="new-ssh"/>);
  await screen.findByRole('button',{name:'Allow this request'});
  await act(async()=>{if(outcome==='accepted')complete({schemaVersion:1,accepted:true});else fail('obsolete hidden decision');});
  expect(screen.getByRole('button',{name:'Allow this request'})).toHaveProperty('disabled',false);expect(screen.queryByText('obsolete hidden decision')).toBeNull();
  const decisions=vi.mocked(invoke).mock.calls.filter(([command])=>command==='resolve_agent_approval');
  expect(decisions).toHaveLength(1);expect(decisions[0][1]).toMatchObject({sessionId:'original-ssh',agentSessionId:request.sessionId,id:request.id,expectedHash:request.expectedHash});
});
