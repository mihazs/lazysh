// @vitest-environment jsdom
import {invoke} from '@tauri-apps/api/core';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen} from '@testing-library/react';
import ChatPanel from './ChatPanel';
import {chatFollowAccess} from './test/chatFollowAccess';
import {forgetConversations} from './agentConversationCache';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn(),Channel:class{onmessage:((event:unknown)=>void)|undefined;}}));

const bubble=(id:string,role:string,text:string)=>({id,role,blocks:[{type:'text',text}]});
const pageOf=(...messages:unknown[])=>({schemaVersion:1,agent:'claude',view:'active_branch',messages,nextOffset:0,hasMore:false,truncated:true});
const open=(path='/host/a.jsonl',sessionId='first')=>render(<ChatPanel sessionId={sessionId} bound={{agent:'claude',path}} timeline allowStage={false}/>);
const settle=()=>act(async()=>{await vi.advanceTimersByTimeAsync(0);});
const panel=()=>document.querySelector('section.chat-panel')!;
let release: (() => void) | undefined;
/** The host answers `pages` in order; with `hold` the next answer waits until `release()`. */
function host(pages: unknown[], hold = false) {
  vi.mocked(invoke).mockImplementation(async command => {
    if (command !== 'agent_transcript') throw new Error(`Unexpected ${command}`);
    if (hold) await new Promise<void>(resolve => {release = resolve;});
    return pages.length > 1 ? pages.shift() : pages[0];
  });
}
beforeEach(()=>{vi.useFakeTimers();vi.mocked(invoke).mockReset();chatFollowAccess();forgetConversations();release=undefined;Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});});
afterEach(()=>{cleanup();vi.useRealTimers();});

describe('coming back to a conversation',()=>{
  it('shows the last known messages before the host answers, then replaces them with its answer',async()=>{
    host([pageOf(bubble('p','user','Old question'),bubble('a','assistant','Old answer'))]);
    open();await settle();
    expect(screen.getByText('Old answer')).toBeTruthy();expect(panel().hasAttribute('data-stale')).toBe(false);
    cleanup();
    host([pageOf(bubble('p','user','Old question'),bubble('a','assistant','Old answer'),bubble('b','assistant','New answer'))],true);
    open();await settle();
    // The host has not answered: the old messages are up, marked as not yet refreshed.
    expect(screen.getByText('Old answer')).toBeTruthy();expect(screen.queryByText('New answer')).toBeNull();
    expect(panel().hasAttribute('data-stale')).toBe(true);
    release!();await settle();
    expect(screen.getByText('New answer')).toBeTruthy();expect(panel().hasAttribute('data-stale')).toBe(false);
  });

  it('keeps the last known messages when the host cannot answer, with its error beside them',async()=>{
    host([pageOf(bubble('p','user','Remembered prompt'),bubble('a','assistant','Remembered answer'))]);
    open();await settle();cleanup();
    vi.mocked(invoke).mockRejectedValue(new Error('offline'));
    open();await settle();
    expect(screen.getByText('Remembered answer')).toBeTruthy();expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('shows nothing of another conversation, another session, or after the app was locked',async()=>{
    const private_=()=>host([pageOf(bubble('p','user','Private prompt'),bubble('a','assistant','Private answer'))]);
    /** Opens `path` in `session` while the host holds its answer, and says whether the private answer is up. */
    const showsPrivate=async(path:string,session:string)=>{
      host([pageOf()],true);open(path,session);await settle();
      const shown=!!screen.queryByText('Private answer');
      release!();await settle();cleanup();
      return shown;
    };
    private_();open();await settle();cleanup();
    expect(await showsPrivate('/host/a.jsonl','first')).toBe(true);
    private_();open();await settle();cleanup();
    expect(await showsPrivate('/host/other.jsonl','first')).toBe(false);
    expect(await showsPrivate('/host/a.jsonl','second')).toBe(false);
    private_();open();await settle();cleanup();
    chatFollowAccess(true);chatFollowAccess();
    expect(await showsPrivate('/host/a.jsonl','first')).toBe(false);
  });
});
