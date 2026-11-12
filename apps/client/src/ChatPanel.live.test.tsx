// @vitest-environment jsdom
import {invoke} from '@tauri-apps/api/core';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {chatFollowAccess as access} from './test/chatFollowAccess';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import ChatPanel from './ChatPanel';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn(),Channel:class{onmessage:((event:unknown)=>void)|undefined;}}));

// Counts how often each message body is rendered: an update must not re-render the unchanged ones.
const markdownRenders=vi.hoisted(()=>new Map<string,number>());
vi.mock('react-markdown',()=>({default:({children}:{children:string})=>{markdownRenders.set(children,(markdownRenders.get(children)??0)+1);return <p>{children}</p>;}}));

type Channel={onmessage:(event:unknown)=>void};
const text=(id:string,role:string,value:string)=>({id,role,blocks:[{type:'text',text:value}]});
const entry=(message:ReturnType<typeof text>,rev=1)=>({id:message.id,rev,message});
const polled=(...messages:unknown[])=>({schemaVersion:1,agent:'claude',view:'active_branch',messages,nextOffset:0,hasMore:false});
let channel:Channel,starts:unknown[],stops:unknown[],watchFails:boolean,pollFails:boolean,poll:unknown;
const calls=(name:string)=>vi.mocked(invoke).mock.calls.filter(([command])=>command===name).map(([,args])=>args);
const advance=async(ms:number)=>{await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});};
const send=(frame:unknown)=>act(async()=>{channel.onmessage({type:'frame',frame});});
const hello={type:'hello',protocol:1,agent:'claude'};
const snapshot=(gen:number,seq:number,entries:unknown[],activity?:string)=>({type:'snapshot',gen,seq,entries,...(activity?{activity}:{})});
const delta=(gen:number,seq:number,upserts:unknown[],extra={})=>({type:'delta',gen,seq,upserts,drops:[],...extra});
const first=[text('p1','user','Question'),text('a1','assistant','Answer')];
/** The stream opens and carries the first two messages. */
const goLive=async()=>{await send(hello);await send(snapshot(1,1,first.map(message=>entry(message))));};
/** The list as a 400 px window onto 2000 px of thread. */
const sizedList=()=>{
  const list=document.querySelector<HTMLElement>('.chat-messages')!;
  Object.defineProperty(list,'scrollHeight',{configurable:true,get:()=>2000});Object.defineProperty(list,'clientHeight',{configurable:true,value:400});
  return list;
};
function render_(sessionId='host',shown=true,onOpenCompanion?:()=>void) {
  const bound={agent:'claude' as const,path:'/host/session.jsonl'};
  const view=render(<ChatPanel sessionId={sessionId} shown={shown} bound={bound} timeline onOpenCompanion={onOpenCompanion}/>);
  return {rerender:(props:{shown:boolean})=>view.rerender(<ChatPanel sessionId={sessionId} shown={props.shown} bound={bound} timeline onOpenCompanion={onOpenCompanion}/>)};
}
beforeEach(()=>{
  vi.useFakeTimers();vi.mocked(invoke).mockReset();access();starts=[];stops=[];watchFails=false;pollFails=false;poll=polled(...first);
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='agent_transcript'){if(pollFails)throw new Error('offline');return poll;}
    if(command==='agent_watch_start'){if(watchFails)throw new Error('no channel');starts.push(args);channel=(args as {events:Channel}).events;return `watch-${starts.length}`;}
    if(command==='agent_watch_stop'){stops.push(args);return;}
    throw new Error(`Unexpected ${command}`);
  });
});
afterEach(()=>{cleanup();vi.useRealTimers();});

describe('a bound conversation with a live watch',()=>{
  it('opens one channel for the bound conversation and patches a reply that grows in parts without a reload, a poll or a scroll jump',async()=>{
    render_();await advance(0);
    expect(starts).toEqual([{sessionId:'host',target:{kind:'path',agent:'claude',path:'/host/session.jsonl'},events:expect.anything()}]);
    await goLive();
    const list=sizedList();
    // The reader is looking at earlier text: 1500 px above the tail.
    list.scrollTop=100;fireEvent.scroll(list);
    const article=screen.getByText('Answer').closest('article')!;
    await send(delta(1,2,[entry(text('a1','assistant','Answer, part one'),2)]));
    expect(screen.getByText('Answer, part one').closest('article')).toBe(article);
    await send(delta(1,3,[entry(text('a1','assistant','Answer, part one and part two'),3)]));
    expect(screen.getByText('Answer, part one and part two').closest('article')).toBe(article);
    expect(list.scrollTop).toBe(100);expect(screen.getByRole('button',{name:'Jump to latest'})).toBeTruthy();
    // The stream carries it all: no page was fetched after the first read, however long it runs.
    await advance(20_000);expect(calls('agent_transcript')).toHaveLength(1);
    expect(document.querySelector('section.chat-panel')!.getAttribute('data-watch')).toBe('live');
    expect(screen.queryByText(/Live updates are unavailable/)).toBeNull();
  });
  it('renders only the entry that changed, however many frames arrive',async()=>{
    render_();await advance(0);
    const many=Array.from({length:40},(_,index)=>[text(`p${index}`,'user',`Question ${index}`),text(`a${index}`,'assistant',`Answer ${index}`)]).flat();
    await send(hello);await send(snapshot(1,1,many.map(message=>entry(message))));
    markdownRenders.clear();
    for(let part=1;part<=5;part++)await send(delta(1,1+part,[entry(text('a39','assistant',`Answer 39, part ${part}`),1+part)]));
    // Five frames re-rendered five bodies: the one that grew. The other 79 stayed as they were.
    expect([...markdownRenders.keys()]).toEqual([1,2,3,4,5].map(part=>`Answer 39, part ${part}`));
    expect([...markdownRenders.values()].every(count=>count===1)).toBe(true);
  });
  it('follows the tail when the reader is at the latest message',async()=>{
    render_();await advance(0);await goLive();
    const list=sizedList();
    await send(delta(1,2,[entry(text('p2','user','Next question'))]));
    expect(list.scrollTop).toBe(2000);expect(screen.queryByRole('button',{name:'Jump to latest'})).toBeNull();
  });
  it('keeps order, ignores duplicates and old revisions, drops from the head and rebuilds on a new generation',async()=>{
    render_();await advance(0);await send(hello);
    await send(snapshot(1,1,[entry(text('p1','user','Question')),entry(text('a1','assistant','Answer'),2)]));
    await send(delta(1,2,[entry(text('a2','assistant','Second'))]));
    // A frame seen before changes nothing, and neither does an older revision of an entry.
    await send(delta(1,2,[entry(text('a2','assistant','Replayed'))]));
    await send(delta(1,3,[entry(text('a1','assistant','Old answer'),1)]));
    expect(screen.queryByText('Replayed')).toBeNull();expect(screen.queryByText('Old answer')).toBeNull();
    expect(screen.getByText('Answer')).toBeTruthy();
    const order=()=>screen.getAllByRole('article').map(node=>node.textContent);
    expect(order()).toEqual(['Question','Answer','Second']);
    await send(snapshot(2,4,[entry(text('p9','user','After a rewrite'))]));
    expect(order()).toEqual(['After a rewrite']);
    await send(snapshot(2,5,[entry(text('p9','user','Replaced twice'))]));
    expect(order()).toEqual(['Replaced twice']);
    expect(document.querySelector('section.chat-panel')!.getAttribute('data-watch')).toBe('live');
  });
  it('shows the recorded turn state as a working row that follows the stream',async()=>{
    render_();await advance(0);await send(hello);
    await send(snapshot(1,1,first.map(message=>entry(message)),'working'));
    expect(screen.getByRole('status',{name:''}).textContent).toBe('Agent is working');
    await send(delta(1,2,[],{activity:'waiting'}));expect(screen.getByText('Agent is waiting for your answer')).toBeTruthy();
    await send(delta(1,3,[],{activity:null}));expect(screen.queryByText(/Agent is (working|waiting)/)).toBeNull();
  });
  it('closes the channel when the view is hidden and opens a new one when it is shown again',async()=>{
    const view=render_();await advance(0);await goLive();
    view.rerender({shown:false});await advance(0);
    expect(stops).toEqual([{sessionId:'host',watchId:'watch-1'}]);
    view.rerender({shown:true});await advance(0);
    expect(starts).toHaveLength(2);
  });
});

describe('when the stream cannot be had',()=>{
  it('polls every 2 s with a delayed hint when the channel cannot open, and goes live when it can',async()=>{
    watchFails=true;render_();await advance(0);
    expect(screen.getByText(/Live updates are unavailable, so this view refreshes every 2 seconds/)).toBeTruthy();
    poll=polled(...first,text('a2','assistant','Polled'));await advance(2000);
    expect(screen.getByText('Polled')).toBeTruthy();expect(calls('agent_transcript').length).toBeGreaterThanOrEqual(2);
    watchFails=false;await advance(1000);await send(hello);await send(snapshot(1,1,first.map(message=>entry(message))));
    expect(screen.queryByText(/Live updates are unavailable/)).toBeNull();
    const reads=calls('agent_transcript').length;await advance(10_000);expect(calls('agent_transcript')).toHaveLength(reads);
  });
  it('marks the thread stale after a lost stream, keeps the last update and recovers on the next snapshot',async()=>{
    render_();await advance(0);await goLive();
    pollFails=true;await act(async()=>{channel.onmessage({type:'closed',reason:'disconnected'});});
    expect(document.querySelector('section.chat-panel')!.getAttribute('data-watch')).toBe('stale');
    expect(screen.getByText('Answer')).toBeTruthy();
    await advance(7000);expect(screen.getByText(/Connection lost\. Showing the last update from .*; reconnecting\./)).toBeTruthy();
    expect(stops).toHaveLength(1);expect(starts.length).toBeGreaterThanOrEqual(2);
    await send(hello);await send(snapshot(1,1,[...first,text('a2','assistant','After reconnect')].map(message=>entry(message))));
    expect(screen.queryByText(/Connection lost/)).toBeNull();expect(screen.getByText('After reconnect')).toBeTruthy();
  });
  it.each([
    ['a frame out of order','stale',[snapshot(1,1,first.map(message=>entry(message))),delta(1,3,[entry(text('a3','assistant','Skipped'))])]],
    ['a frame that is not a valid page','delayed',[snapshot(1,1,[{id:'x',rev:1,message:{id:'x',role:'bogus',blocks:[]}}])]],
    ['an end frame','stale',[snapshot(1,1,first.map(message=>entry(message))),{type:'end',reason:'IoError'}]],
  ])('falls back to polling after %s and never shows what it could not place',async(_name,state,frames)=>{
    render_();await advance(0);await send(hello);
    for(const frame of frames)await send(frame);
    expect(screen.queryByText('Skipped')).toBeNull();expect(screen.queryByText('x')).toBeNull();
    expect(document.querySelector('section.chat-panel')!.getAttribute('data-watch')).toBe(state);
    expect(screen.getByText(/Live updates are unavailable/)).toBeTruthy();
    const reads=calls('agent_transcript').length;await advance(2000);expect(calls('agent_transcript').length).toBeGreaterThan(reads);
  });
  it('ignores frame types it does not know and heartbeats without re-rendering the thread',async()=>{
    render_();await advance(0);await goLive();
    const article=screen.getByText('Answer').closest('article')!;
    await send({type:'heartbeat'});await send({type:'progress',percent:50});
    expect(screen.getByText('Answer').closest('article')).toBe(article);
    expect(document.querySelector('section.chat-panel')!.getAttribute('data-watch')).toBe('live');
  });
  it('says what to update when the host companion has no transcript watch, and does not ask again at once',async()=>{
    const open=vi.fn();render_('host',true,open);await advance(0);
    await act(async()=>{channel.onmessage({type:'unavailable',reason:'companion_required'});});
    expect(screen.getByText(/Live updates need a newer host companion/)).toBeTruthy();
    expect(document.querySelector('section.chat-panel')!.getAttribute('data-watch')).toBe('unsupported');
    fireEvent.click(screen.getByRole('button',{name:'Host companion installation'}));expect(open).toHaveBeenCalledOnce();
    // The conversation still updates by polling, and the host is not asked again for a minute.
    poll=polled(...first,text('a2','assistant','Polled'));await advance(2000);expect(screen.getByText('Polled')).toBeTruthy();
    await advance(30_000);expect(starts).toHaveLength(1);
  });
  it('keeps the background-work panel current from the stream: a snapshot carries the work, a delta that changes it replaces it and one that does not leaves it',async()=>{
    render_();await advance(0);await send(hello);
    const task=(state:string)=>({id:'b1',kind:'shell',title:'Wait for CI',state,events:[],startedAt:new Date().toISOString()});
    await send({...snapshot(1,1,first.map(message=>entry(message))),work:[task('running')]});
    expect(screen.getByRole('button',{name:'1 running'})).toBeTruthy();
    await send(delta(1,2,[entry(text('a2','assistant','More'))]));
    expect(screen.getByRole('button',{name:'1 running'})).toBeTruthy();
    await send(delta(1,3,[],{work:[task('done')]}));
    expect(screen.queryByRole('button',{name:/running/})).toBeNull();
    await send(delta(1,4,[],{work:[task('running')]}));
    expect(screen.getByRole('button',{name:'1 running'})).toBeTruthy();
    await send(delta(1,5,[],{work:null}));
    expect(screen.queryByRole('button',{name:/running/})).toBeNull();
  });
});
