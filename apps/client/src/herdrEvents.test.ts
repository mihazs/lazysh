// @vitest-environment jsdom
import {invoke} from '@tauri-apps/api/core';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {applyAccessStatus,captureAccess} from './access';
import {herdrTransitionEvent,parseHerdrFrame,rememberHerdrAgents,subscribeHerdrEvents,type HerdrEvent,type HerdrTransition} from './herdrEvents';
import {followHerdrServer,herdrMonitorStreams,monitoredHerdrServer} from './herdrMonitor';
import type {WatchState} from './watchChannel';

vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn(),Channel:class{onmessage:((event:unknown)=>void)|undefined;}}));
type Channel={onmessage:(event:unknown)=>void};
let channels:Channel[],stops:string[],starts:string[],listing:unknown,revision=0;
const advance=(ms:number)=>vi.advanceTimersByTimeAsync(ms);
const send=(frame:unknown,channel=channels.at(-1)!)=>channel.onmessage({type:'frame',frame});
const status=(extra={})=>({type:'status',paneId:'w1:p2',workspaceId:'w1',status:'blocked',agent:'codex',cwd:'/work/app',...extra});
const hello={type:'hello',protocol:1,session:'main'};
beforeEach(()=>{
  vi.useFakeTimers();channels=[];stops=[];starts=[];listing=[{name:'main'}];
  applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(++revision+1000),nonce:'c'.repeat(64)});
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='agent_watch_start'){channels.push((args as {events:Channel}).events);starts.push((args as {target:{herdrSession:string}}).target.herdrSession);return `watch-${channels.length}`;}
    if(command==='agent_watch_stop'){stops.push((args as {watchId:string}).watchId);return;}
    if(command==='multiplexer_sessions'){if(listing instanceof Error)throw listing;return listing;}
    throw new Error(`Unexpected ${command}`);
  });
});
afterEach(()=>{vi.useRealTimers();});
/** One follower of the stream of `server`, recording what it was told. */
function follow(server='main',sessionId='host') {
  const lease=captureAccess();
  const events:HerdrEvent[]=[],states:WatchState[]=[];
  const stop=subscribeHerdrEvents({sessionId,server,lease,invoke:vi.mocked(invoke) as never},event=>events.push(event),state=>states.push(state));
  return {events,states,stop};
}

it('accepts the companion frames, ignores unknown ones and refuses anything malformed',()=>{
  expect(parseHerdrFrame(hello)).toEqual({kind:'hello'});
  expect(parseHerdrFrame({type:'heartbeat'})).toEqual({kind:'heartbeat'});
  expect(parseHerdrFrame({type:'changed'})).toEqual({kind:'event',event:{type:'changed'}});
  expect(parseHerdrFrame({type:'end',reason:'busy'})).toEqual({kind:'end'});
  expect(parseHerdrFrame({type:'progress'})).toEqual({kind:'ignored'});
  expect(parseHerdrFrame(status({agent:null,cwd:null}))).toEqual({kind:'event',event:{type:'status',paneId:'w1:p2',workspaceId:'w1',status:'blocked',agent:null,cwd:null}});
  for(const bad of [null,'status',{},{type:3},{type:'hello',protocol:2},
    status({paneId:'w1:p2; rm -rf /'}),status({paneId:'w1:t2'}),status({workspaceId:'w1:p1'}),status({paneId:'w1:pI'}),status({status:'exploding'}),
    status({agent:'x'.repeat(65)}),status({cwd:'/work\nsecret'}),status({cwd:7})])
    expect(()=>parseHerdrFrame(bad),JSON.stringify(bad)).toThrow();
});

it('shares one channel between the views of a server, names each pane once and closes with the last view',async()=>{
  const transitions:HerdrTransition[]=[];
  const record=(event:Event)=>transitions.push((event as CustomEvent<HerdrTransition>).detail);
  window.addEventListener(herdrTransitionEvent,record);
  rememberHerdrAgents('host','main',[{pane_id:'w1:p2',agent_session:{agent:'codex',value:'s-1'}},{pane_id:'w1:p3'}]);
  const first=follow(),second=follow();
  await advance(0);
  expect(channels).toHaveLength(1);
  send(hello);send(status());send({type:'changed'});send({type:'heartbeat'});
  expect(first.events).toEqual(second.events);
  expect(first.events.map(event=>event.type)).toEqual(['status','changed']);
  expect(transitions).toHaveLength(1);
  expect(transitions[0]).toMatchObject({sessionId:'host',server:'main',paneId:'w1:p2',status:'blocked',agent:'codex',cwd:'/work/app',agentSession:{agent:'codex',value:'s-1'}});
  // A burst of frames never repeats a sequence, so two reports of the same status are two transitions.
  send(status({status:'working'}));send(status());
  expect(new Set(transitions.map(item=>item.sequence)).size).toBe(transitions.length);
  first.stop();await advance(0);
  expect(stops).toEqual([]);
  second.stop();await advance(0);
  expect(stops).toEqual(['watch-1']);
  send(status());
  expect(transitions).toHaveLength(3);
  window.removeEventListener(herdrTransitionEvent,record);
});

it('keeps a separate stream for another server and another connection',async()=>{
  const a=follow('main'),b=follow('other'),c=follow('main','host-2');
  await advance(0);
  expect(channels).toHaveLength(3);
  [a,b,c].forEach(view=>view.stop());
});

it('reports live after the first frame and reopens after losing the stream, with the polling states in between',async()=>{
  const view=follow();
  await advance(0);
  expect(view.states.at(-1)).toBe('connecting');
  send({type:'heartbeat'});
  expect(view.states.at(-1)).toBe('connecting');
  send(hello);
  expect(view.states.at(-1)).toBe('live');
  // The host closed the channel: polling resumes (stale, because it was live) and a new channel opens after a second.
  channels[0]!.onmessage({type:'closed',reason:'ended'});
  expect(view.states.at(-1)).toBe('stale');
  await advance(999);expect(channels).toHaveLength(1);
  await advance(1);expect(channels).toHaveLength(2);
  send(hello);expect(view.states.at(-1)).toBe('live');
  // An end frame and a frame the client cannot trust both reopen it, a second later because the stream had been live.
  send({type:'end',reason:'busy'});expect(view.states.at(-1)).toBe('stale');
  await advance(1000);expect(channels).toHaveLength(3);
  send({type:'status',paneId:'bad'});expect(view.states.at(-1)).toBe('stale');
  view.stop();await advance(60000);
  expect(channels).toHaveLength(3);
});

it('leaves a host that cannot stream to polling and asks again only after a minute',async()=>{
  const view=follow();
  await advance(0);
  channels[0]!.onmessage({type:'unavailable',reason:'events_unsupported'});
  expect(view.states.at(-1)).toBe('unsupported');
  await advance(59999);expect(channels).toHaveLength(1);
  await advance(1);expect(channels).toHaveLength(2);
  view.stop();
});

it('falls back when the channel cannot start and when a follower throws',async()=>{
  vi.mocked(invoke).mockImplementation(async()=>{throw new Error('no channel');});
  const broken=follow();
  await advance(0);
  expect(broken.states.at(-1)).toBe('delayed');
  broken.stop();
  vi.mocked(invoke).mockImplementation(async(command,args)=>{if(command==='agent_watch_start'){channels.push((args as {events:Channel}).events);return 'w';}});
  const lease=captureAccess();
  const good:HerdrEvent[]=[];
  const stopBad=subscribeHerdrEvents({sessionId:'host',server:'solo',lease,invoke:vi.mocked(invoke) as never},()=>{throw new Error('broken view');},()=>{});
  const stopGood=subscribeHerdrEvents({sessionId:'host',server:'solo',lease,invoke:vi.mocked(invoke) as never},event=>good.push(event),()=>{});
  await advance(0);
  send(status(),channels.at(-1));
  expect(good).toHaveLength(1);
  expect(channels).toHaveLength(1);
  stopBad();stopGood();
});

const monitor=()=>herdrMonitorStreams(captureAccess(),vi.mocked(invoke) as never);

it('follows the attached Herdr server when it runs, else the only running one, and never substitutes another',()=>{
  expect(monitoredHerdrServer(['main'])).toBe('main');
  expect(monitoredHerdrServer(['main','other'])).toBe('');
  expect(monitoredHerdrServer(['main','other'],'other')).toBe('other');
  expect(monitoredHerdrServer(['main'],'other')).toBe('');
  expect(monitoredHerdrServer([])).toBe('');
});

it('keeps one monitor stream per connection, moves it with the server and closes it with the connection or the monitor',async()=>{
  const streams=monitor();
  streams.follow('host','main');streams.follow('host','main');streams.follow('host-2','main');
  await advance(0);
  expect(starts).toEqual(['main','main']);
  streams.follow('host','other');await advance(0);
  expect(starts).toEqual(['main','main','other']);
  expect(stops).toEqual(['watch-1']);
  streams.keep(new Set(['host']));await advance(0);
  expect(stops).toEqual(['watch-1','watch-2']);
  streams.close();await advance(0);
  expect(stops).toEqual(['watch-1','watch-2','watch-3']);
  streams.close();await advance(0);
  expect(channels).toHaveLength(3);
});

it('shares the monitor stream with a visible Herdr view, whichever opens it first, and closes it with the last of them',async()=>{
  const first=monitor(),view=follow();
  first.follow('host','main');
  await advance(0);
  expect(channels).toHaveLength(1);
  first.close();await advance(0);
  expect(stops).toEqual([]);
  send(hello);expect(view.states.at(-1)).toBe('live');
  const second=monitor();
  second.follow('host','main');view.stop();await advance(0);
  expect(channels).toHaveLength(1);expect(stops).toEqual([]);
  second.close();await advance(0);
  expect(stops).toEqual(['watch-1']);
  const late=monitor();
  late.follow('host','other');const opened=follow('other');await advance(0);
  expect(starts).toEqual(['main','other']);
  late.close();await advance(0);
  expect(stops).toEqual(['watch-1']);
  opened.stop();await advance(0);
  expect(stops).toEqual(['watch-1','watch-2']);
});

it('lists the host\'s servers each time: a failed listing keeps the stream, an empty one closes it',async()=>{
  const streams=monitor(),session={id:'host',hostId:'h1',name:'builder',connected:true};
  const refresh=async(valid=true)=>{await followHerdrServer(streams,vi.mocked(invoke) as never,session,()=>valid);await advance(0);};
  await refresh(false);
  expect(starts).toEqual([]);
  await refresh();await refresh();
  expect(starts).toEqual(['main']);
  listing=new Error('host unreachable');await refresh();
  listing=[{name:'a'},{name:'a'}];await refresh();
  expect(stops).toEqual([]);
  listing=[];await refresh();
  expect(stops).toEqual(['watch-1']);
  // Two servers are no choice, unless the terminal is attached to one of them.
  listing=[{name:'a'},{name:'b'}];await refresh();
  expect(starts).toEqual(['main']);
  Object.assign(session,{attached:{kind:'tmux',name:'b'}});await refresh();
  expect(starts).toEqual(['main']);
  Object.assign(session,{attached:{kind:'herdr',name:'b'}});await refresh();
  expect(starts).toEqual(['main','b']);
  streams.close();
});
