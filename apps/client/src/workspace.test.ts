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

it("restores bounded Mosh options without storing transport secrets", () => {
  const mosh = {
    serverPath: "/opt/mosh-server",
    portMin: 60000,
    portMax: 60010,
    key: "PRIVATE",
  };
  saveWorkspace([{ hostId: "a", mosh }]);
  expect(readWorkspace()).toEqual([
    {
      hostId: "a",
      mosh: { serverPath: "/opt/mosh-server", portMin: 60000, portMax: 60010 },
    },
  ]);
  expect(localStorage.getItem("lazysh.workspace.v1")).not.toContain("PRIVATE");
  for (const bad of [
    { ...mosh, portMax: 65536 },
    { ...mosh, portMin: 1 },
    { ...mosh, serverPath: "bad\ncommand" },
  ]) {
    localStorage.setItem(
      "lazysh.workspace.v1",
      JSON.stringify([{ hostId: "a", mosh: bad }]),
    );
    expect(readWorkspace()).toEqual([]);
  }
});

it('preserves ET bootstrap options but rejects conflicting transport intentions',()=>{
  const et={serverPath:'/opt/etterminal',port:2022,key:'PRIVATE'};
  saveWorkspace([{hostId:'a',et}]);
  expect(readWorkspace()).toEqual([{hostId:'a',et:{serverPath:'/opt/etterminal',port:2022}}]);
  expect(localStorage.getItem('lazysh.workspace.v1')).not.toContain('PRIVATE');
  for(const item of [{hostId:'a',et:{...et,port:0}},{hostId:'a',et,mosh:{serverPath:'mosh-server',portMin:60000,portMax:60000}}]){
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify([item]));expect(readWorkspace()).toEqual([]);
  }
});
