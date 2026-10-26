// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {cleanupNativeMocks} from './test/nativeCoreMock';
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
