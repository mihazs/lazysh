// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {cleanupNativeMocks} from './test/nativeCoreMock';
import {chatFollowAccess} from './test/chatFollowAccess';
import {openFolds} from './test/openFolds';
import ChatPanel,{parseTranscript} from './ChatPanel';
vi.mock('@tauri-apps/api/core',async original=>(await import('./test/nativeCoreMock')).mockNativeCore(original));
afterEach(cleanupNativeMocks);
const response=(text:string,view='active_branch')=>({schemaVersion:1,agent:'grok-acp',view,nextOffset:100,hasMore:false,messages:[{id:'same',role:'assistant',blocks:[{type:'text',text}]}]});
function panel() {
  render(<ChatPanel sessionId="owned-grok"/>);
  fireEvent.change(screen.getByLabelText('Agent'),{target:{value:'grok-acp'}});
  fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:'/fixture/updates.jsonl'}});
}
it('keeps Records default and explicitly replaces a Grok conversation without enabling Claude Follow',async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(response('record','record_stream')).mockResolvedValueOnce(response('abandoned')).mockResolvedValueOnce(response('replacement'));
  panel();expect(screen.getByLabelText('View')).toHaveProperty('value','records');
  fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));await screen.findByText('record');
  expect(vi.mocked(invoke).mock.calls[0][1]).not.toHaveProperty('view');
  fireEvent.change(screen.getByLabelText('View'),{target:{value:'conversation'}});
  fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));await screen.findByText('abandoned');
  const original=vi.mocked(invoke).mock.calls[1][2];
  fireEvent.click(screen.getByRole('button',{name:'Refresh new messages'}));await screen.findByText('replacement');
  expect(screen.queryByText('abandoned')).toBeNull();expect(screen.queryByText('record')).toBeNull();
  expect(invoke).toHaveBeenLastCalledWith('agent_transcript',{sessionId:'owned-grok',agent:'grok-acp',path:'/fixture/updates.jsonl',view:'conversation',offset:0},original);
  expect(screen.queryByLabelText('Follow selected Claude branch')).toBeNull();
});
it('keeps the explicit Records fallback available after a rejected reconstruction with raw diagnostics intact',async()=>{
  vi.mocked(invoke).mockRejectedValueOnce('unsupported fixture control <raw>').mockResolvedValueOnce(response('raw record','record_stream'));
  panel();fireEvent.change(screen.getByLabelText('View'),{target:{value:'conversation'}});
  fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','unsupported fixture control <raw>');
  expect(screen.getByText(/Unsupported controls or ambiguous rewinds/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('View'),{target:{value:'records'}});
  fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));await screen.findByText('raw record');
  await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(2));
  expect(()=>parseTranscript(response('okay'))).not.toThrow();
  expect(()=>parseTranscript(response('wrong','future'))).toThrow('Unsupported transcript response');
});
const planPage=(card:object)=>({...response('x'),messages:[{id:'grok-record-3',role:'assistant',blocks:[{type:'tool_use',id:'grok-plan-3',name:'plan',text:'',card}]}]});
async function openConversation() {
  panel();fireEvent.change(screen.getByLabelText('View'),{target:{value:'conversation'}});
  fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));
}
it('shows a recorded Grok plan as the plan card with each step and its state',async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(planPage({kind:'plan',entries:[{text:'Read the code',status:'completed'},{text:'Write the fix',status:'in_progress'},{text:'Ship it',status:'pending'}]}));
  await openConversation();
  const card=await screen.findByRole('region',{name:'Plan'});
  expect(within(card).getAllByRole('listitem').map(item=>item.textContent)).toEqual(['DoneRead the code','In progressWrite the fix','PendingShip it']);
});
it('accepts only the plan card on a Grok conversation',async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(planPage({kind:'question',questions:[{question:'Which?',multiple:false,options:[]}]}));
  await openConversation();
  expect((await screen.findByRole('alert')).textContent).toBe('Invalid recorded plan or question.');
});

/** The Agent view's reader on the session log a Grok Build hook reported (apps/agent/tests/grok_hooks.rs builds the same shapes). */
describe('a Grok Build conversation in the Agent view',()=>{
  const logPath='/home/u/.grok/sessions/work-project/s1/updates.jsonl';
  const log=[
    {id:'u1',role:'user',blocks:[{type:'text',text:'Run the tests'}]},
    {id:'a1',role:'assistant',blocks:[{type:'text',text:'Running them.'}]},
    {id:'grok-tool-9',role:'assistant',blocks:[
      {type:'tool_use',id:'t1',name:'npm test',text:'{"command":"npm test"}',status:'completed'},
      {type:'tool_result',id:'t1',text:'12 passed',status:'completed'},
    ]},
    {id:'grok-record-12',role:'assistant',blocks:[{type:'tool_use',id:'grok-plan-12',name:'plan',text:'',card:{kind:'plan',entries:[{text:'Run the tests',status:'completed'},{text:'Report',status:'in_progress'},{text:'Ship it',status:'pending'}]}}]},
  ];
  let served:unknown;
  const serve=(messages:unknown[],nextOffset=900)=>{served={...response('unused'),nextOffset,truncated:false,messages};};
  const transcriptReads=()=>vi.mocked(invoke).mock.calls.filter(([command])=>command==='agent_transcript');
  beforeEach(()=>{
    vi.useFakeTimers();chatFollowAccess();serve(log);
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
    vi.mocked(invoke).mockReset().mockImplementation(async command=>{if(command!=='agent_transcript')throw new Error(`Unexpected ${command}`);return served;});
  });
  afterEach(()=>{vi.useRealTimers();vi.mocked(invoke).mockReset();});
  async function openBound() {
    render(<ChatPanel sessionId="host" shown bound={{agent:'grok-acp',path:logPath}} timeline/>);
    await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  }

  it('reads the reported session log through the companion with the Grok adapter and its conversation view',async()=>{
    await openBound();
    expect(transcriptReads()[0][1]).toMatchObject({sessionId:'host',agent:'grok-acp',path:logPath,view:'conversation'});
  });

  it('shows the turn, the tool call with its output and the plan with its steps',async()=>{
    await openBound();await openFolds();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Running them.')).toBeTruthy();
    expect(document.body.textContent).toContain('npm test');
    expect(document.body.textContent).toContain('12 passed');
    expect(screen.getByText(/1 of 3/)).toBeTruthy();
  });

  it('follows the session log while the agent writes it, which the picker never does for this view',async()=>{
    await openBound();
    expect(screen.queryByText('Now the report.')).toBeNull();
    serve([...log,{id:'a2',role:'assistant',blocks:[{type:'text',text:'Now the report.'}]}],1200);
    await act(async()=>{await vi.advanceTimersByTimeAsync(2500);});
    expect(screen.getByText('Now the report.')).toBeTruthy();
    expect(transcriptReads().length).toBeGreaterThan(1);
    expect(transcriptReads().every(([,args])=>(args as {view?:string}).view==='conversation')).toBe(true);
  });

  it('refuses a plan card with a step state Grok does not record instead of guessing',async()=>{
    serve([log[0],{...log[3],blocks:[{type:'tool_use',id:'p',name:'plan',text:'',card:{kind:'plan',entries:[{text:'x',status:'blocked'}]}}]}]);
    await openBound();
    expect(screen.queryByText('Run the tests')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
