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

it('retains Auto options instead of its last selected transport and excludes credentials',()=>{
  const mosh={serverPath:'mosh-server',portMin:60000,portMax:61000,key:'PRIVATE'};
  const et={serverPath:'etterminal',port:2022,password:'PRIVATE'};
  saveWorkspace([{hostId:'a',auto:{mosh,et},mosh}]);
  expect(readWorkspace()).toEqual([{hostId:'a',auto:{mosh:{serverPath:'mosh-server',portMin:60000,portMax:61000},et:{serverPath:'etterminal',port:2022}}}]);
  expect(localStorage.getItem('lazysh.workspace.v1')).not.toContain('PRIVATE');
  for(const bad of [
    {hostId:'a',auto:{mosh,et},et},
    {hostId:'a',auto:{mosh:{...mosh,portMax:65536},et}},
    {hostId:'a',auto:{mosh,et:{...et,serverPath:'bad\npath'}}},
    {hostId:'a',auto:{mosh,et},attached:{kind:'tmux',name:'agent'}},
  ]) {
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify([bad]));
    expect(readWorkspace()).toEqual([]);
  }
});

it('persists local intent without inventing an SSH host or retaining output',()=>{
  saveWorkspace([{local:true,hostId:'',password:'SECRET',output:'PRIVATE'} as never]);
  expect(readWorkspace()).toEqual([{local:true}]);
  expect(localStorage.getItem('lazysh.workspace.v1')).toBe('[{"local":true}]');
  for(const item of [{local:true,hostId:'fake-local'},{local:true,et:{serverPath:'etterminal',port:2022}},{local:'true'}]) {
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify([item]));expect(readWorkspace()).toEqual([]);
  }
});
