// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,screen} from '@testing-library/react';
import type {BoundConversation} from './ChatPanel';
import {answerTranscripts,openBound} from './test/boundTranscript';
import {openFolds} from './test/openFolds';
vi.mock('@tauri-apps/api/core',async original=>(await import('./test/nativeCoreMock')).mockNativeCoreWithChannel(original));

/** A page as the host companion reads a Grok Build session (apps/agent/tests/grok_work.rs builds the same shapes): the edit is a
 * completed `edit` call whose input carries the recorded diff, a tool the mapping does not know keeps its recorded title. */
const edit={file_path:'/repo/src/lib.rs',old_string:'let total = a + b;',new_string:'let total = a + b + c;'};
const messages=[
  {id:'u1',role:'user',blocks:[{type:'text',text:'Fix the sum'}]},
  {id:'grok-tool-1',role:'assistant',blocks:[{type:'tool_use',id:'edit',name:'edit',text:JSON.stringify(edit),status:'completed'}]},
  {id:'grok-tool-2',role:'assistant',blocks:[
    {type:'tool_use',id:'odd',name:'Teleport `home`',text:'{"where":"home"}',status:'completed'},
    {type:'tool_result',id:'odd',text:'arrived',status:'completed'},
  ]},
  {id:'a1',role:'assistant',blocks:[{type:'text',text:'The sum is fixed.'}]},
];
const work=[
  {id:'sub-1',kind:'agent',title:'Map the module layout',subtitle:'explore',state:'done',events:[],last:'The module has three layers.'},
  {id:'bg-1',kind:'shell',title:'Start the dev server',command:'npm run dev',state:'running',events:[]},
];
const page=(extra:object={})=>({schemaVersion:1,agent:'grok-acp',view:'active_branch',messages,nextOffset:0,hasMore:false,truncated:false,...extra});
// The Agent view binds Claude Code, Codex, OpenCode and Gemini CLI until it follows Grok Build; the panel itself reads any agent's page.
const bound={agent:'grok-acp',path:'/host/.grok/sessions/p/s/updates.jsonl'} as unknown as BoundConversation;
let reply:unknown;
beforeEach(()=>{reply=page({work});answerTranscripts(()=>reply);});
afterEach(()=>{cleanup();vi.useRealTimers();});

describe('a Grok Build conversation with work records in the Agent view',()=>{
  it('shows the same background-work panel as for Claude Code, from the same component',async()=>{
    await openBound(bound);
    const panel=screen.getByRole('region',{name:'Background work'});
    // The finished sub-agent is not counted; the dev server still runs and has its own shell counter.
    expect(panel.textContent).toMatch(/1 running/);
    expect(panel.textContent).toMatch(/1 shell/);
  });

  it('draws the recorded edit as the shared diff card',async()=>{
    await openBound(bound);await openFolds();
    const card=screen.getByText('edit').closest('details')!;
    expect(card.getAttribute('data-kind')).toBe('diff');
    expect(card.querySelector('.agent-diff-lines')!.textContent).toBe('-let total = a + b;\n+let total = a + b + c;\n');
  });

  it('renders a tool the mapping does not know as an ordinary tool block, with no error',async()=>{
    await openBound(bound);await openFolds();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('The sum is fixed.')).toBeTruthy();
    expect(screen.getByText('Teleport `home`').closest('details')!.getAttribute('data-kind')).not.toBe('diff');
  });

  it('shows the conversation without a panel when the session recorded no work',async()=>{
    reply=page();
    await openBound(bound);
    expect(screen.getByText('The sum is fixed.')).toBeTruthy();
    expect(screen.queryByRole('region',{name:'Background work'})).toBeNull();
  });
});
