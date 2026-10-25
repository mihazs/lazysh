// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { readWorkspace, saveWorkspace } from "./workspace";
afterEach(() => localStorage.clear());
it("persists only host and durable multiplexer identity, excluding credentials and output", () => {
  const input = {
    hostId: "a",
    attached: { kind: "tmux" as const, name: "agent workspace" },
    password: "SECRET",
    output: "PRIVATE",
  };
  saveWorkspace([input]);
  expect(readWorkspace()).toEqual([
    { hostId: "a", attached: { kind: "tmux", name: "agent workspace" } },
  ]);
  expect(localStorage.getItem("lazysh.workspace.v1")).not.toMatch(
    /SECRET|PRIVATE/,
  );
});
it("rejects corrupt or unbounded workspace state", () => {
  for (const value of [
    "broken",
    "{}",
    JSON.stringify(Array(21).fill({ hostId: "a" })),
  ]) {
    localStorage.setItem("lazysh.workspace.v1", value);
    expect(readWorkspace()).toEqual([]);
  }
  localStorage.setItem(
    "lazysh.workspace.v1",
    JSON.stringify([
      { hostId: "a", attached: { kind: "shell-command", name: "bad" } },
    ]),
  );
  expect(readWorkspace()).toEqual([]);
});
