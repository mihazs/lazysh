// @vitest-environment jsdom
import {invoke} from '@tauri-apps/api/core';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {chatFollowAccess as access} from './test/chatFollowAccess';
import {act,cleanup,render,screen} from '@testing-library/react';
import ChatPanel from './ChatPanel';
vi.mock('@tauri-apps/api/core',async original=>(await import('./test/nativeCoreMock')).mockNativeCoreWithChannel(original));

/** A page as the host companion reads a Gemini CLI session (apps/agent/tests/gemini_conversation.rs builds the same shapes). */
const plan={kind:'plan',entries:[{text:'Write the reader',status:'completed'},{text:'Test it',status:'in_progress'},{text:'Ship it',status:'pending'}]};
const messages=[
  {id:'u1',role:'user',blocks:[{type:'text',text:'Build the reader'}]},
  {id:'g1',role:'assistant',blocks:[
    {type:'thinking',text:'Planning: split the work'},
    {type:'tool_use',id:'todo',name:'write_todos',text:'{}',card:plan},
    {type:'tool_use',id:'search',name:'google_web_search',text:'{"query":"gemini"}'},
    {type:'tool_use',id:'fail',name:'run_shell_command',text:'{"command":"false"}'},
  ]},
  {id:'g1:results',role:'tool',blocks:[{type:'tool_result',id:'search',text:'three results',isError:false},{type:'tool_result',id:'fail',text:'exit 1',isError:true}]},
  {id:'g2',role:'assistant',blocks:[{type:'text',text:'The reader is done.'}]},
];
const work=[
  {id:'sub',kind:'agent',title:'codebase_investigator',state:'running',events:[]},
  {id:'bg',kind:'shell',title:'Dev server',command:'npm run dev',state:'running',events:[]},
];
const page=(extra:object={})=>({schemaVersion:1,agent:'gemini',view:'active_branch',messages,nextOffset:0,hasMore:false,truncated:false,activity:'idle',session:{model:'gemini-3-pro',usage:{usedTokens:1200}},...extra});
let reply:unknown;
beforeEach(()=>{
  vi.useFakeTimers();vi.mocked(invoke).mockReset();access();reply=page({work});
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command==='agent_transcript')return reply;
    if(command==='agent_watch_start')throw new Error('no channel');
    if(command==='agent_watch_stop')return;
    throw new Error(`Unexpected ${command}`);
  });
});
afterEach(()=>{cleanup();vi.useRealTimers();});
async function open() {
  render(<ChatPanel sessionId="host" shown bound={{agent:'gemini',path:'/host/.gemini/tmp/p/chats/session-1.jsonl'}} timeline />);
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
}

describe('a Gemini CLI conversation in the Agent view',()=>{
  it('reads the session file through the companion with the Gemini adapter and its conversation view',async()=>{
    await open();
    const [, args] = vi.mocked(invoke).mock.calls.find(([command])=>command==='agent_transcript')!;
    expect(args).toMatchObject({sessionId:'host',agent:'gemini',path:'/host/.gemini/tmp/p/chats/session-1.jsonl',view:'conversation'});
  });

  it('shows the same plan chip and background-work panel as for Claude Code, from the same components',async()=>{
    await open();
    expect(screen.getByText('The reader is done.')).toBeTruthy();
    expect(screen.getByText(/1 of 3/)).toBeTruthy();
    const panel=screen.getByRole('region',{name:'Background work'});
    // The sub-agent and the background shell both run; the shell has its own counter.
    expect(panel.textContent).toMatch(/2 running/);
    expect(panel.textContent).toMatch(/1 shell/);
  });

  it('renders a tool the mapping does not know as an ordinary tool block, with no error', async()=>{
    await open();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('The reader is done.')).toBeTruthy();
    expect(document.body.textContent).toContain('google_web_search');
  });

  it('refuses a plan card whose status Gemini does not define instead of guessing',async()=>{
    reply=page({messages:[messages[0],{...messages[1],blocks:[{type:'tool_use',id:'todo',name:'write_todos',text:'{}',card:{kind:'plan',entries:[{text:'x',status:'someday'}]}}]}]});
    await open();
    expect(screen.queryByText('The reader is done.')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
