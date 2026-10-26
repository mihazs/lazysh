// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import {chatFollowAccess} from './test/chatFollowAccess';
import {grokFollowPage,grokReceipt} from './test/recordedFollowData';
import {t,uiI18n} from './i18n/core';
import ChatPanel from './ChatPanel';
vi.mock('@tauri-apps/api/core',async original=>(await import('./test/nativeCoreMock')).mockNativeCore(original));
beforeEach(async()=>{
  await uiI18n.changeLanguage('en');
  vi.useFakeTimers();vi.mocked(invoke).mockReset();chatFollowAccess();
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
});
afterEach(async()=>{cleanup();vi.useRealTimers();await uiI18n.changeLanguage('en');});
const advance=async(ms=2000)=>{await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});};
function mount() {
  const view=render(<ChatPanel sessionId="original-ssh"/>);
  fireEvent.change(screen.getByLabelText('Agent'),{target:{value:'grok-acp'}});
  fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:'/raw/updates.jsonl'}});
  return view;
}
async function start(){await act(async()=>{fireEvent.click(screen.getByRole('button',{name:t('chatRecordedStart')}));});}
function follow(){return screen.getByLabelText(t('chatRecordedFollow'));}
const args=()=>vi.mocked(invoke).mock.calls.map(([,arg])=>arg as Record<string,unknown>);

it('keeps manual pages until verified preparation succeeds, then starts append-only polling',async()=>{
  let resolve!:(value:unknown)=>void;
  const legacy={...grokFollowPage(4,4,'Legacy page'),checkpoint:undefined};
  vi.mocked(invoke).mockResolvedValueOnce(legacy).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}))
    .mockResolvedValueOnce(grokFollowPage(10,21,'','c')).mockResolvedValueOnce(grokFollowPage(22,22,'Appended','d'));
  mount();await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));});
  await advance(10000);expect(invoke).toHaveBeenCalledTimes(1);
  await start();expect(screen.getByText('Legacy page')).toBeTruthy();
  expect(args()[1]).toEqual({sessionId:'original-ssh',agent:'grok-acp',path:'/raw/updates.jsonl',checkpointed:true,offset:0});
  await act(async()=>{resolve(grokFollowPage(10,20));});
  expect(screen.queryByText('Legacy page')).toBeNull();expect(follow()).toHaveProperty('checked',true);
  await advance(1999);expect(invoke).toHaveBeenCalledTimes(2);
  await advance(1);expect(screen.getByText('Verified recorded text')).toBeTruthy();
  expect(args()[2]).toMatchObject({checkpointed:true,offset:10,checkpoint:grokReceipt(10,20)});
  await advance();expect(screen.getByText('Appended')).toBeTruthy();
  expect(args()[3]).toMatchObject({offset:10,checkpoint:grokReceipt(10,21,'c')});
  expect(vi.mocked(invoke).mock.calls.every(([command])=>command==='agent_transcript')).toBe(true);
});

it.each(['native failure','missing proof'])('failed preparation preserves legacy pages and never retries/falls back: %s',async failure=>{
  vi.mocked(invoke).mockResolvedValueOnce({...grokFollowPage(4,4,'Keep manual'),checkpoint:undefined});
  if(failure==='native failure') vi.mocked(invoke).mockRejectedValueOnce({kind:'remote_command_failed',message:'unknown option --checkpointed'});
  else vi.mocked(invoke).mockResolvedValueOnce({...grokFollowPage(10,10,'Unverified replacement'),checkpoint:undefined});
  mount();await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));});await start();
  expect(screen.getByText('Keep manual')).toBeTruthy();expect(screen.queryByText('Unverified replacement')).toBeNull();
  expect(screen.queryByLabelText('Follow recorded file')).toBeNull();expect(screen.getByRole('alert')).toBeTruthy();
  await advance(20000);expect(invoke).toHaveBeenCalledTimes(2);
});

it('manual continuation of a paused verified stream keeps its receipt and a failed legacy Open does not switch mode',async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(grokFollowPage()).mockResolvedValueOnce(grokFollowPage(20,20,'Manual append','c'))
    .mockRejectedValueOnce(new Error('Raw legacy failure')).mockResolvedValueOnce(grokFollowPage(30,30,'Still verified','d'));
  mount();await start();fireEvent.click(follow());
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Refresh new messages'}));});
  expect(args()[1]).toMatchObject({checkpointed:true,offset:10,checkpoint:grokReceipt(10)});
  expect(follow()).toHaveProperty('checked',false);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));});
  expect(args()[2]).not.toHaveProperty('checkpointed');expect(args()[2]).not.toHaveProperty('checkpoint');
  expect(screen.getByText('Manual append')).toBeTruthy();expect(follow()).toHaveProperty('checked',false);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Refresh new messages'}));});
  expect(args()[3]).toMatchObject({checkpointed:true,offset:20,checkpoint:grokReceipt(20,20,'c')});
  await advance(20000);expect(invoke).toHaveBeenCalledTimes(4);
});

it('errors pause without reset, explicit resume retains the token, and successful legacy Open leaves Follow',async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(grokFollowPage()).mockRejectedValueOnce(new Error('chatRecordedChanged'))
    .mockResolvedValueOnce(grokFollowPage(10,10,'')).mockResolvedValueOnce({...grokFollowPage(4,4,'Manual again'),checkpoint:undefined});
  mount();await start();await advance();
  expect(screen.getByRole('alert').textContent).toBe('chatRecordedChanged');expect(follow()).toHaveProperty('checked',false);
  for(const locale of ['pt-BR','es','en']) {
    await act(async()=>{await uiI18n.changeLanguage(locale);});
    expect(screen.getByRole('alert').textContent).toBe('chatRecordedChanged');
    expect(invoke).toHaveBeenCalledTimes(2);
  }
  await advance(10000);expect(invoke).toHaveBeenCalledTimes(2);
  fireEvent.click(follow());await advance();expect(args()[2]).toMatchObject({offset:10,checkpoint:grokReceipt(10)});
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Open transcript'}));});
  expect(screen.queryByLabelText('Follow recorded file')).toBeNull();expect(screen.getByText('Manual again')).toBeTruthy();
  await advance(10000);expect(invoke).toHaveBeenCalledTimes(4);
});

it.each(['success','error'])('hidden→visible cannot revive a held automatic %s or overlap its original receipt',async outcome=>{
  let settle!:(value:unknown)=>void;
  vi.mocked(invoke).mockResolvedValueOnce(grokFollowPage()).mockImplementationOnce(()=>new Promise((resolve,reject)=>{settle=outcome==='success'?resolve:reject;}))
    .mockResolvedValue(grokFollowPage(20,20,'Fresh after pause','c'));
  mount();await start();await advance();await advance(20000);expect(invoke).toHaveBeenCalledTimes(2);
  fireEvent(window,new Event('pagehide'));fireEvent(window,new Event('pageshow'));
  await act(async()=>{settle(outcome==='success'?grokFollowPage(99,99,'Discarded result'):new Error('Discarded error'));});
  expect(screen.queryByText('Discarded result')).toBeNull();expect(screen.queryByRole('alert')).toBeNull();
  expect(follow()).toHaveProperty('checked',true);
  await advance(1999);expect(invoke).toHaveBeenCalledTimes(2);await advance(1);
  expect(args()[2]).toEqual(args()[1]);expect(screen.getByText('Fresh after pause')).toBeTruthy();
});

it.each(['path','session','lease','view','unmount'].flatMap(change=>['success','error'].map(outcome=>({change,outcome}))))('original owner suppresses held $outcome after $change changes',async ({change,outcome})=>{
  let settle!:(value:unknown)=>void;
  vi.mocked(invoke).mockResolvedValueOnce(grokFollowPage()).mockImplementationOnce(()=>new Promise((resolve,reject)=>{settle=outcome==='success'?resolve:reject;}));
  const view=mount();await start();await advance();
  if(change==='path')fireEvent.change(screen.getByLabelText('Transcript path'),{target:{value:'/other/file'}});
  if(change==='view')fireEvent.change(screen.getByLabelText('View'),{target:{value:'conversation'}});
  if(change==='session')view.rerender(<ChatPanel sessionId="new-ssh"/>);
  if(change==='lease')await act(async()=>{chatFollowAccess(true);chatFollowAccess();});
  if(change==='unmount')view.unmount();
  await act(async()=>{settle(outcome==='success'?grokFollowPage(20,20,'Stale owner','c'):new Error('Stale error'));});
  expect(screen.queryByText('Stale owner')).toBeNull();expect(screen.queryByRole('alert')).toBeNull();
  await advance(10000);expect(invoke).toHaveBeenCalledTimes(2);
});

it('rejects nonempty no-progress rows without replacing verified content',async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(grokFollowPage()).mockResolvedValueOnce(grokFollowPage(10,10,'Forbidden no progress'));
  mount();await start();await advance();
  expect(screen.queryByText('Forbidden no progress')).toBeNull();expect(screen.getByText('Verified recorded text')).toBeTruthy();
  expect(follow()).toHaveProperty('checked',false);expect(screen.getByRole('alert').textContent).toBe(t('chatRecordedChanged'));
});

it('keeps at most 500 rows and never follows reconstructed Grok conversation',async()=>{
  let cursor=0;
  vi.mocked(invoke).mockImplementation(async()=>{
    cursor+=100;return {...grokFollowPage(cursor),messages:Array.from({length:100},(_,i)=>({id:`grok-record-${cursor-100+i}`,role:'assistant',blocks:[{type:'text',text:`Record row ${cursor-100+i}`}]}))};
  });
  mount();await start();for(let i=0;i<5;i++)await advance();
  expect(screen.getAllByRole('article')).toHaveLength(500);expect(screen.queryByText('Record row 0')).toBeNull();
  expect(screen.getByText('Record row 599')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('View'),{target:{value:'conversation'}});
  expect(screen.queryByRole('button',{name:'Start following recorded file'})).toBeNull();
  expect(follow()).toHaveProperty('disabled',true);await advance(10000);expect(invoke).toHaveBeenCalledTimes(6);
});

it.each(['pt-BR','es'])('localizes owned controls/errors in %s without recapturing the source or translating native text',async locale=>{
  vi.mocked(invoke).mockResolvedValueOnce(grokFollowPage()).mockResolvedValueOnce(grokFollowPage(10,10,'No progress'));
  mount();await start();await advance();
  await act(async()=>{await uiI18n.changeLanguage(locale);});
  expect(screen.getByRole('alert').textContent).toBe(t('chatRecordedChanged'));
  expect(screen.getByLabelText(t('chatRecordedFollow'))).toHaveProperty('checked',false);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('rejects a forward page replaying an earlier physical ID without overwriting its verified row',async()=>{
  const original=grokFollowPage(10,10,'Verified original');
  const replay=grokFollowPage(20,20,'Forbidden replacement','c');
  original.messages[0].id='grok-record-0';replay.messages[0].id='grok-record-0';
  vi.mocked(invoke).mockResolvedValueOnce(original).mockResolvedValueOnce(replay);
  mount();await start();await advance();
  expect(screen.getByText('Verified original')).toBeTruthy();
  expect(screen.queryByText('Forbidden replacement')).toBeNull();
  expect(follow()).toHaveProperty('checked',false);
  expect(screen.getByRole('alert').textContent).toBe(t('chatRecordedChanged'));
});
