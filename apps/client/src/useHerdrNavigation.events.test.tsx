// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {applyAccessStatus} from './access';
import {useHerdrNavigation,type HerdrTree} from './useHerdrNavigation';

vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn(),Channel:class{onmessage:((event:unknown)=>void)|undefined;}}));
type Channel={onmessage:(event:unknown)=>void};
let channel:Channel|undefined,starts:number,stops:number,failStart:boolean,revision=0,status:string;
const tree=():HerdrTree=>({workspaces:[{workspace_id:'w1',label:'work',focused:true,agent_status:'idle'}],tabs:[{workspace_id:'w1',tab_id:'w1:t1',label:'1',number:1,focused:true,agent_status:'idle'}],
  panes:[{workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p1',terminal_id:'term-1',cwd:'/work',focused:true,agent_status:status as 'idle'}],
  agents:[{terminal_id:'term-1',workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p1',agent_status:status as 'idle',agent:'codex',name:null}]});
const reads=()=>vi.mocked(invoke).mock.calls.filter(([command])=>command==='herdr_tree').length;
const advance=(ms:number)=>act(async()=>{await vi.advanceTimersByTimeAsync(ms);});
const emit=(frame:unknown)=>act(async()=>{channel!.onmessage({type:'frame',frame});});
function Probe({visible=true}:{visible?:boolean}) {
  const {data,watch}=useHerdrNavigation({sessionId:'ssh1',herdrSession:'main',visible});
  return <output data-watch={watch}>{data?.rows[0]?.agent_status??'none'}</output>;
}
const shown=()=>screen.getByRole('status');
beforeEach(()=>{
  vi.useFakeTimers();channel=undefined;starts=0;stops=0;failStart=false;status='working';
  applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(++revision+2000),nonce:'d'.repeat(64)});
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='multiplexer_sessions')return [{name:'main'}];
    if(command==='herdr_tree')return tree();
    if(command==='agent_watch_start'){if(failStart)throw new Error('no channel');starts++;channel=(args as {events:Channel}).events;return 'watch';}
    if(command==='agent_watch_stop'){stops++;return;}
    throw new Error(`Unexpected ${command}`);
  });
});
afterEach(()=>{cleanup();vi.useRealTimers();});

it('reads the tree once at the start and again only when an event arrives while the stream is live',async()=>{
  render(<Probe/>);await advance(0);
  expect(reads()).toBe(1);expect(shown().textContent).toBe('working');expect(starts).toBe(1);
  await emit({type:'hello',protocol:1,session:'main'});
  expect(shown().dataset.watch).toBe('live');
  // Eleven 5 s ticks pass and nothing is read: the stream carries the changes.
  await advance(5000*11);expect(reads()).toBe(1);
  status='blocked';
  await emit({type:'status',paneId:'w1:p1',workspaceId:'w1',status:'blocked',agent:'codex',cwd:'/work'});
  expect(reads()).toBe(1);
  await advance(250);
  expect(reads()).toBe(2);expect(shown().textContent).toBe('blocked');
});

it('reads once after a burst of events and after the read that was already running',async()=>{
  render(<Probe/>);await advance(0);await emit({type:'hello',protocol:1,session:'main'});
  const baseline=reads();
  for(const frame of [{type:'changed'},{type:'changed'},{type:'changed'}])await emit(frame);
  await advance(249);expect(reads()).toBe(baseline);
  await advance(1);expect(reads()).toBe(baseline+1);
  // A frame that lands while a read is open waits for it instead of being dropped.
  let release!:()=>void;
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='multiplexer_sessions')return [{name:'main'}];
    if(command==='herdr_tree'){await new Promise<void>(resolve=>{release=resolve;});return tree();}
    if(command==='agent_watch_start'){channel=(args as {events:Channel}).events;return 'watch';}
    return undefined;
  });
  await emit({type:'changed'});await advance(250);
  const during=reads();
  await emit({type:'changed'});await advance(750);
  expect(reads()).toBe(during);
  status='done';release();await advance(0);
  await advance(250);release();await advance(0);
  expect(reads()).toBe(during+1);
});

it('still reads once a minute while live, as a net under a missed event',async()=>{
  render(<Probe/>);await advance(0);await emit({type:'hello',protocol:1,session:'main'});
  await advance(60000);
  expect(reads()).toBe(2);
});

it('polls every five seconds again while the host cannot stream',async()=>{
  render(<Probe/>);await advance(0);
  channel!.onmessage({type:'unavailable',reason:'events_unsupported'});
  await advance(0);
  expect(shown().dataset.watch).toBe('unsupported');
  const before=reads();
  await advance(5000*3);expect(reads()).toBe(before+3);
});

it('polls again as soon as a live stream is lost',async()=>{
  render(<Probe/>);await advance(0);
  await emit({type:'hello',protocol:1,session:'main'});
  await advance(5000);expect(reads()).toBe(1);
  channel!.onmessage({type:'closed',reason:'ended'});
  await advance(0);
  expect(shown().dataset.watch).toBe('stale');
  const lost=reads();
  await advance(5000);expect(reads()).toBe(lost+1);
});

it('polls as before when no stream can open',async()=>{
  failStart=true;
  render(<Probe/>);await advance(0);
  expect(shown().dataset.watch).toBe('delayed');
  const before=reads();
  await advance(5000*2);expect(reads()).toBe(before+2);
});

it('opens no stream while hidden and closes it when the view is hidden',async()=>{
  const view=render(<Probe visible={false}/>);await advance(0);
  expect(starts).toBe(0);expect(reads()).toBe(0);
  view.rerender(<Probe/>);await advance(0);
  expect(starts).toBe(1);
  await emit({type:'hello',protocol:1,session:'main'});
  view.rerender(<Probe visible={false}/>);await advance(0);
  expect(stops).toBe(1);
  expect(shown().dataset.watch).toBe('off');
  cleanup();await advance(0);
  expect(stops).toBe(1);
});

it('shares one stream between two views of the same server',async()=>{
  render(<><Probe/><Probe/></>);await advance(0);
  expect(starts).toBe(1);
});
