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
    { ...request, options: [], canMessage: false },
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

it('keeps empty board approvals compact while polling and reveals real requests and failures immediately',async()=>{
  vi.useFakeTimers();
  try {
    let result:unknown={schemaVersion:1,requests:[]};
    vi.mocked(invoke).mockImplementation(async command=>{
      if(command==='agent_approvals'){if(result instanceof Error)throw result;return result;}
      return {schemaVersion:1,accepted:true};
    });
    render(<ApprovalPanel sessionId="compact-approvals" compactEmpty/>);
    await act(async()=>{});expect(screen.queryByRole('region')).toBeNull();
    result={schemaVersion:1,requests:[request]};
    await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
    expect(screen.getByRole('button',{name:'Allow this request'})).toBeTruthy();
    expect(screen.getByText('Bash',{exact:false})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Deny request'}));await act(async()=>{});
    expect(invoke).toHaveBeenLastCalledWith('resolve_agent_approval',expect.objectContaining({id:request.id,expectedHash:request.expectedHash,decision:'deny'}),expect.anything());
    expect(screen.queryByRole('region')).toBeNull();
    result=new Error('Owned approval reader unavailable');
    await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
    expect(screen.getByRole('alert')).toHaveProperty('textContent','Owned approval reader unavailable');
    result={schemaVersion:1,requests:[]};
    await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
    expect(screen.queryByRole('region')).toBeNull();
    expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='agent_approvals')).toHaveLength(4);
  } finally {vi.useRealTimers();}
});

it('counts down to expiry and then refuses a decision for the expired request',async()=>{
  vi.useFakeTimers({now:new Date('2026-10-29T12:05:00Z'),toFake:['setInterval','clearInterval','setTimeout','clearTimeout','Date']});
  try {
    const expiring={...request,createdAt:'2026-10-29T12:04:00Z',expiresAt:'2026-10-29T12:06:05Z'};
    vi.mocked(invoke).mockImplementation(async command=>command==='agent_approvals'?{schemaVersion:1,requests:[expiring]}:{schemaVersion:1,accepted:true});
    render(<ApprovalPanel sessionId="countdown-owner"/>);
    await act(async()=>{});
    const card=screen.getByRole('article',{name:'claude · Bash'});
    expect(card.textContent).toContain('Expires in 1:05');
    expect(card.querySelector('time[datetime="2026-10-29T12:06:05Z"]')).toBeTruthy();
    const facts=Object.fromEntries(Array.from(card.querySelectorAll('dt'),term=>[term.textContent,term.nextElementSibling?.textContent]));
    expect(facts).toEqual({Project:'/work','Agent session':'agent-session',Pane:'%7'});
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
    expect(card.textContent).toContain('Expires in 1:00');
    expect(screen.getByRole('button',{name:'Allow this request'})).toHaveProperty('disabled',false);
    await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});
    expect(card.textContent).toContain("Expired. Answer it in the agent's terminal instead.");
    const allow=screen.getByRole('button',{name:'Allow this request'});
    expect(allow).toHaveProperty('disabled',true);expect(screen.getByRole('button',{name:'Deny request'})).toHaveProperty('disabled',true);
    fireEvent.click(allow);await act(async()=>{});
    expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='resolve_agent_approval')).toHaveLength(0);
  } finally {vi.useRealTimers();}
});

const suggestion={type:'addRules',rules:[{toolName:'Bash',ruleContent:'git status'}],behavior:'allow',destination:'localSettings'};
it('offers only the permission updates it can read, each behind a confirmation that shows the exact rule',async()=>{
  vi.mocked(invoke).mockImplementation(async command=>command==='agent_approvals'
    ?{schemaVersion:1,requests:[{...request,options:[suggestion,{type:'setMode',mode:'bypassPermissions',destination:'session'},{type:'addRules',rules:[{toolName:'Bash'}],behavior:'deny',destination:'session'},{type:'setMode',mode:'acceptEdits',destination:'session'},'junk']}]}
    :{schemaVersion:1,accepted:true});
  render(<ApprovalPanel sessionId="ssh1"/>);
  const rule=await screen.findByRole('button',{name:'Allow and remember Bash(git status)…'});
  expect(screen.getAllByRole('button').map(button=>button.textContent)).toEqual(expect.arrayContaining(['Allow and switch to acceptEdits mode…','Deny with a message']));
  expect(screen.queryByText(/bypassPermissions/)).toBeNull();
  fireEvent.click(rule);
  const confirm=screen.getByRole('region',{name:'Allow and remember Bash(git status)…'});
  expect(confirm.textContent).toContain('.claude/settings.local.json');expect(confirm.querySelector('code')?.textContent).toBe('Bash(git status)');
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='resolve_agent_approval')).toHaveLength(0);
  fireEvent.click(await screen.findByRole('button',{name:'Allow and remember Bash(git status)…'}));
  fireEvent.click(screen.getByRole('button',{name:'Allow and apply'}));
  await act(async()=>{});
  expect(invoke).toHaveBeenLastCalledWith('resolve_agent_approval',{sessionId:'ssh1',id:request.id,expectedHash:request.expectedHash,agentSessionId:'agent-session',paneId:'%7',decision:'allow',option:0},expect.anything());
});
it('offers no message form to an older companion that does not list options',async()=>{
  vi.mocked(invoke).mockImplementation(async command=>command==='agent_approvals'?{schemaVersion:1,requests:[request]}:{schemaVersion:1,accepted:true});
  render(<ApprovalPanel sessionId="ssh1"/>);
  await screen.findByRole('button',{name:'Deny request'});
  expect(screen.queryByRole('button',{name:'Deny with a message'})).toBeNull();
});
it('denies with a trimmed message and sends nothing for a blank one',async()=>{
  vi.mocked(invoke).mockImplementation(async command=>command==='agent_approvals'?{schemaVersion:1,requests:[{...request,options:[]}]}:{schemaVersion:1,accepted:true});
  render(<ApprovalPanel sessionId="ssh1"/>);
  fireEvent.click(await screen.findByRole('button',{name:'Deny with a message'}));
  const send=screen.getByRole('button',{name:'Deny and send message'});
  fireEvent.change(screen.getByLabelText('Message the agent will read'),{target:{value:'   '}});
  expect(send).toHaveProperty('disabled',true);
  fireEvent.change(screen.getByLabelText('Message the agent will read'),{target:{value:'  Use staging  '}});
  fireEvent.click(send);await act(async()=>{});
  expect(invoke).toHaveBeenLastCalledWith('resolve_agent_approval',{sessionId:'ssh1',id:request.id,expectedHash:request.expectedHash,agentSessionId:'agent-session',paneId:'%7',decision:'deny',message:'Use staging'},expect.anything());
});

const mine = {agentSessionId: 'agent-session', paneId: '%7'};
it('says a request was answered elsewhere and sends nothing when the host no longer lists it',async()=>{
  let listed=[request];
  vi.mocked(invoke).mockImplementation(async command=>command==='agent_approvals'?{schemaVersion:1,requests:listed}:{schemaVersion:1,accepted:true});
  render(<ApprovalPanel sessionId="ssh1" match={mine} compactEmpty/>);
  const allow=await screen.findByRole('button',{name:'Allow this request'});
  // The terminal answers it first; the card on screen is still the old one.
  listed=[];
  fireEvent.click(allow);await act(async()=>{});
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='resolve_agent_approval')).toHaveLength(0);
  expect(screen.getByRole('status').textContent).toContain('already answered');
  expect(screen.queryByRole('button',{name:'Allow this request'})).toBeNull();
});
it('says nothing about a request that the agent answered here or that expired',async()=>{
  vi.mocked(invoke).mockImplementation(async command=>command==='agent_approvals'?{schemaVersion:1,requests:[request]}:{schemaVersion:1,accepted:true});
  render(<ApprovalPanel sessionId="ssh1" match={mine} compactEmpty/>);
  fireEvent.click(await screen.findByRole('button',{name:'Deny request'}));
  vi.mocked(invoke).mockImplementation(async command=>command==='agent_approvals'?{schemaVersion:1,requests:[]}:{schemaVersion:1,accepted:true});
  await act(async()=>{});
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='resolve_agent_approval')).toHaveLength(1);
  expect(screen.queryByRole('status')).toBeNull();
});
