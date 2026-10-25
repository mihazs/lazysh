// @vitest-environment jsdom
import { cleanupNativeMocks } from "./test/nativeCoreMock";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
