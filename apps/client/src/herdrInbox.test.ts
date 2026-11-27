// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {beforeEach,expect,it,vi} from 'vitest';
import type {HerdrTransition} from './herdrEvents';
import {collectHerdrTransition,herdrPaneIdentity,reportedByHerdr,SAME_TRANSITION_MS,withAgentSession} from './herdrInbox';
import {collectInbox,getInbox,updateInbox} from './notificationStore';

vi.stubGlobal('crypto',webcrypto);
const session={id:'ssh1',hostId:'host1',name:'Dev host',connected:true};
const T0=Date.parse('2026-11-15T10:00:00Z');
let sequence=0;
const transition=(extra:Partial<HerdrTransition>={}):HerdrTransition=>({sessionId:'ssh1',server:'main',paneId:'w1:p2',workspaceId:'w1',status:'blocked',agent:'codex',cwd:'/work/app',agentSession:null,at:T0,sequence:++sequence,...extra});
const hook=(extra:Record<string,unknown>={})=>({schemaVersion:1,sessions:[{sessionId:'codex-session',agent:'Codex',project:'/work/app',state:'needs_attention',updatedAt:new Date(T0+2000).toISOString(),summary:'secret prompt',paneId:'%3',eventCount:2,...extra}]});
beforeEach(()=>{localStorage.clear();updateInbox({version:1,monitoring:true,notifications:false,rows:[],latest:{},error:''});});

it('turns a blocked pane into a row that carries the agent, directory and Herdr pane and nothing from its screen',async()=>{
  const alert=await collectHerdrTransition(session,transition());
  expect(alert).toMatchObject({agent:'Codex',project:'/work/app',state:'needs_attention',paneId:herdrPaneIdentity('main','w1:p2'),sessionId:'ssh1',hostId:'host1',hostName:'Dev host',updatedAt:'2026-11-15T10:00:00.000Z'});
  expect(getInbox().rows).toEqual([alert]);
  expect(Object.keys(alert!).sort()).toEqual(['agent','agentSessionId','eventId','hostId','hostName','id','paneId','project','sessionId','state','updatedAt']);
  expect(alert!.paneId).toBe('herdr:main:w1:p2');
});

it('records a finished agent without alerting, and ignores states that are not an event',async()=>{
  expect(await collectHerdrTransition(session,transition({status:'done'}))).toBeNull();
  expect(getInbox().rows.map(row=>row.state)).toEqual(['done']);
  for(const status of ['working','idle','unknown'] as const)expect(await collectHerdrTransition(session,transition({status,paneId:'w1:p5'}))).toBeNull();
  expect(getInbox().rows).toHaveLength(1);
});

it('names the hook kinds of agents Herdr reports a session for, so one agent is one row',async()=>{
  await collectInbox(session,hook(),true);
  const [existing]=getInbox().rows;
  expect(existing.agent).toBe('Codex');
  // Herdr names the same session: the same row, and a report a minute or more later is a new event.
  const later=T0+SAME_TRANSITION_MS*2;
  const alert=await collectHerdrTransition(session,transition({agentSession:{agent:'codex',value:'codex-session'},at:later}));
  expect(alert).toMatchObject({id:existing.id,agent:'Codex',agentSessionId:'codex-session',state:'needs_attention'});
  expect(getInbox().rows).toHaveLength(1);
  expect(getInbox().rows[0].paneId).toBe('herdr:main:w1:p2');
});

it('does not alert twice for one transition reported by Herdr and by the hook, in either order',async()=>{
  // The hook first: Herdr's report of the same state within a minute is the same transition.
  await collectInbox(session,hook(),true);
  const hookRow=getInbox().rows[0];
  expect(await collectHerdrTransition(session,transition({agentSession:{agent:'codex',value:'codex-session'}}))).toBeNull();
  expect(getInbox().rows).toEqual([hookRow]);
  // Herdr first: the hook's report of it (different event id, a second later) is not an alert, and the row stays the hook's.
  updateInbox({rows:[],latest:{}});
  const alert=await collectHerdrTransition(session,transition({agentSession:{agent:'codex',value:'codex-session'}}));
  expect(alert).not.toBeNull();
  const reported=await collectInbox(session,hook(),false);
  expect(reported).toHaveLength(1);
  expect(reportedByHerdr(reported[0])).toBe(true);
  expect(getInbox().rows).toHaveLength(1);
  expect(getInbox().rows[0].project).toBe('/work/app');
});

it('treats a later report, another state or another agent as a new transition',async()=>{
  await collectHerdrTransition(session,transition({agentSession:{agent:'codex',value:'codex-session'}}));
  const row=getInbox().rows[0];
  expect(reportedByHerdr({...row,updatedAt:new Date(T0+SAME_TRANSITION_MS-1).toISOString()})).toBe(true);
  expect(reportedByHerdr({...row,updatedAt:new Date(T0+SAME_TRANSITION_MS+1).toISOString()})).toBe(false);
  expect(reportedByHerdr({...row,state:'done'})).toBe(false);
  expect(reportedByHerdr({...row,id:'f'.repeat(64)})).toBe(false);
  // Blocked again a few seconds later, with no hook row in between, is a second event of Herdr's own.
  expect(await collectHerdrTransition(session,transition({agentSession:{agent:'codex',value:'codex-session'},at:T0+5000}))).not.toBeNull();
});

it('matches a hook row of the same pane and agent kind, and never one of another agent or a known other session',async()=>{
  const identity=herdrPaneIdentity('main','w1:p2');
  await collectInbox(session,hook({paneId:identity,agent:'Claude Code'}),true);
  const claude=getInbox().rows[0];
  // The same pane and the same kind, with no session named by Herdr: the hook's row, already reported.
  expect(await collectHerdrTransition(session,transition({agent:'claude'}))).toBeNull();
  expect(getInbox().rows).toEqual([claude]);
  // Another agent kind in that pane is another agent.
  expect(await collectHerdrTransition(session,transition({agent:'codex'}))).not.toBeNull();
  expect(getInbox().rows).toHaveLength(2);
  // A session id Herdr names that the hook row does not have is another session, even in the same pane.
  expect(await collectHerdrTransition(session,transition({agent:'claude',agentSession:{agent:'claude',value:'new-session'},at:T0+SAME_TRANSITION_MS*3}))).not.toBeNull();
  expect(getInbox().rows).toHaveLength(3);
});

it('keeps one row per pane for agents with no session, bounded, newest first, with a long name cut',async()=>{
  for(let index=0;index<105;index++)await collectHerdrTransition(session,transition({paneId:`w1:p${index+1}`,at:T0+index*1000}));
  const rows=getInbox().rows;
  expect(rows).toHaveLength(100);
  expect(rows[0].paneId).toBe('herdr:main:w1:p105');
  const long=await collectHerdrTransition(session,transition({paneId:'w2:p1',agent:'a\nb'.padEnd(100,'x'),cwd:'/x'.padEnd(500,'y'),at:T0+999000}));
  expect(long!.agent).toHaveLength(80);
  expect(long!.agent).not.toContain('\n');
  expect(long!.project).toHaveLength(200);
  expect(await collectHerdrTransition(session,transition({paneId:'w3:p1',server:'s'.repeat(300),at:T0+1000000}))).toMatchObject({paneId:null});
});

/** A Herdr tree whose pane `w1:p2` hosts a Codex agent of `value`, or no agent session at all. */
const treeOf=(value?:string)=>({workspaces:[],tabs:[],panes:[{workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p2',focused:false,agent_status:'blocked'}],
  agents:[{terminal_id:'t2',workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p2',name:null,agent:'codex',agent_status:'blocked',...(value?{agent_session:{source:'herdr:codex',agent:'codex',kind:'id',value}}:{})}]});

it('names a blocked or finished pane from a fresh read of the tree, so a new agent in the pane is not taken for the old one',async()=>{
  const tree=vi.fn<(command:string,args?:Record<string,unknown>)=>Promise<unknown>>(async()=>treeOf('first-session'));
  const read=tree as unknown as Parameters<typeof withAgentSession>[0];
  expect((await withAgentSession(read,transition())).agentSession).toEqual({agent:'codex',value:'first-session'});
  expect(tree).toHaveBeenCalledWith('herdr_tree',{sessionId:'ssh1',name:'main'});
  // The pane's agent was replaced: the stream's earlier answer is not kept.
  tree.mockResolvedValue(treeOf('second-session'));
  expect((await withAgentSession(read,transition({status:'done'}))).agentSession).toEqual({agent:'codex',value:'second-session'});
  tree.mockResolvedValue(treeOf());
  expect((await withAgentSession(read,transition())).agentSession).toBeNull();
  // A working pane is no event and costs no read; a failed read keeps what the stream named.
  tree.mockClear();
  const working=transition({status:'working'});
  expect(await withAgentSession(read,working)).toBe(working);
  expect(tree).not.toHaveBeenCalled();
  tree.mockRejectedValue(new Error('host unreachable'));
  const named=transition({agentSession:{agent:'codex',value:'kept'}});
  expect(await withAgentSession(read,named)).toBe(named);
});

it('does not record the same frame twice',async()=>{
  const frame=transition();
  expect(await collectHerdrTransition(session,frame)).not.toBeNull();
  expect(await collectHerdrTransition(session,frame)).toBeNull();
  expect(getInbox().rows).toHaveLength(1);
});

it('retains independent transitions received together',async()=>{
  const alerts=await Promise.all([
    collectHerdrTransition(session,transition({paneId:'w1:p10'})),
    collectHerdrTransition(session,transition({paneId:'w1:p11'})),
  ]);
  expect(alerts.every(Boolean)).toBe(true);
  expect(getInbox().rows.map(row=>row.paneId).sort()).toEqual(['herdr:main:w1:p10','herdr:main:w1:p11']);
});

it('does not commit a transition after its caller loses permission',async()=>{
  let allowed=true;
  const pending=collectHerdrTransition(session,transition(),()=>allowed);
  allowed=false;
  expect(await pending).toBeNull();
  expect(getInbox().rows).toEqual([]);
});

it.each([false,true])('keeps a newer state when an earlier hash is delayed (hook=%s)',async withHook=>{
  if(withHook)await collectInbox(session,hook({state:'done'}),true);
  const digest=crypto.subtle.digest.bind(crypto.subtle);
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let first=true;
  const spy=vi.spyOn(crypto.subtle,'digest').mockImplementation(async (...args)=>{
    if(first){first=false;await gate;}
    return digest(...args);
  });
  try {
    const agentSession={agent:'codex',value:'codex-session'};
    const old=collectHerdrTransition(session,transition({agentSession}));
    await collectHerdrTransition(session,transition({agentSession,status:'done',at:T0+1000}));
    release();
    expect(await old).toBeNull();
    expect(getInbox().rows.map(row=>row.state)).toEqual(['done']);
  } finally {release();spy.mockRestore();}
});
