// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import ChatPanel from './ChatPanel';
import {acknowledgeAccessReady,accessSnapshot} from './access';
import {chatFollowAccess} from './test/chatFollowAccess';
import {attachmentFile,attachmentSession,attachmentUploadedPath} from './test/attachmentData';
import {selectChatAttachment,attachmentReply} from './test/chatAttachment';
import {shellPath} from './attachment';
import {t} from './i18n/core';

vi.mock('@tauri-apps/api/core',async original=>(await import('./test/nativeCoreMock')).mockNativeCore(original));
beforeEach(()=>{
  chatFollowAccess();acknowledgeAccessReady(accessSnapshot().epoch);
  vi.mocked(invoke).mockReset().mockImplementation(async command=>attachmentReply(command));
});
afterEach(cleanup);
const draft=()=>screen.getByLabelText(t('chatDraftLabel'));
it('keeps typed Chat text through upload and appends only the canonical path on explicit action',async()=>{
  render(<ChatPanel sessionId={attachmentSession}/>);
  fireEvent.change(draft(),{target:{value:'Review my existing text 世界'}});
  await selectChatAttachment();await screen.findByLabelText(t('attachmentHostPath'));
  expect(draft()).toHaveProperty('value','Review my existing text 世界');
  expect(vi.mocked(invoke).mock.calls.map(([name])=>name)).toEqual(['upload_reserve','upload_file']);
  fireEvent.click(screen.getByRole('button',{name:'Add uploaded path to Chat draft'}));
  expect(draft()).toHaveProperty('value',`Review my existing text 世界\n${shellPath(attachmentUploadedPath)}`);
  expect(screen.queryByLabelText(t('attachmentHostPath'))).toBeNull();
  expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==='upload_file')).toHaveLength(1);
});

it('refuses overflow without truncating either draft or uploaded path and permits explicit retry',async()=>{
  render(<ChatPanel sessionId={attachmentSession}/>);
  const initial='x'.repeat(65536-shellPath(attachmentUploadedPath).length);
  fireEvent.change(draft(),{target:{value:initial}});
  await selectChatAttachment();await screen.findByLabelText(t('attachmentHostPath'));
  fireEvent.click(screen.getByRole('button',{name:t('attachmentAddToChat')}));
  expect(screen.getByText(t('chatAttachmentTooLong'))).toBeTruthy();
  expect(draft()).toHaveProperty('value',initial);
  expect(screen.getByLabelText(t('attachmentHostPath'))).toHaveProperty('value',shellPath(attachmentUploadedPath));
  fireEvent.change(draft(),{target:{value:'Review'}});
  fireEvent.click(screen.getByRole('button',{name:t('attachmentAddToChat')}));
  expect(draft()).toHaveProperty('value',`Review\n${shellPath(attachmentUploadedPath)}`);
  expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==='upload_file')).toHaveLength(1);
});
it.each(['cancel','close','session','lease','unmount'] as const)('does not append or publish a held upload after %s',async transition=>{
  let finish!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation(async command=>command==='upload_file'?new Promise(resolve=>{finish=resolve;}):attachmentReply(command));
  const view=render(<ChatPanel sessionId={attachmentSession}/>);
  fireEvent.change(draft(),{target:{value:'Keep exact text'}});
  await selectChatAttachment();await waitFor(()=>expect(finish).toBeTypeOf('function'));
  if(transition==='cancel')fireEvent.click(screen.getByRole('button',{name:t('attachmentCancel')}));
  else if(transition==='close')fireEvent.click(screen.getByRole('button',{name:t('chatCloseAttachment')}));
  else if(transition==='session'){
    view.rerender(<ChatPanel sessionId="replacement"/>);
    fireEvent.change(draft(),{target:{value:'Replacement draft'}});
  }else if(transition==='lease')await act(async()=>{chatFollowAccess(true);chatFollowAccess();acknowledgeAccessReady(accessSnapshot().epoch);});
  else view.unmount();
  await act(async()=>{finish({path:attachmentUploadedPath});});
  expect(screen.queryByRole('button',{name:t('attachmentAddToChat')})).toBeNull();
  if(transition!=='unmount')expect(draft()).toHaveProperty('value',transition==='session'?'Replacement draft':'Keep exact text');
  expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==='upload_file')).toHaveLength(1);
});
it('keeps the draft after native upload failure and never offers a path handoff',async()=>{
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command==='upload_file')throw {message:'Original upload denied'};
    return attachmentReply(command);
  });
  render(<ChatPanel sessionId={attachmentSession}/>);
  fireEvent.change(draft(),{target:{value:'Preserved draft'}});
  await selectChatAttachment();await screen.findByText('Original upload denied');
  expect(draft()).toHaveProperty('value','Preserved draft');
  expect(screen.queryByRole('button',{name:t('attachmentAddToChat')})).toBeNull();
});

it('drops the old path on a new source and does not append while IME composition is active',async()=>{
  render(<ChatPanel sessionId={attachmentSession}/>);
  fireEvent.change(draft(),{target:{value:'Composing'}});
  await selectChatAttachment();await screen.findByLabelText(t('attachmentHostPath'));
  fireEvent.compositionStart(draft());
  fireEvent.click(screen.getByRole('button',{name:t('attachmentAddToChat')}));
  expect(draft()).toHaveProperty('value','Composing');
  fireEvent.compositionEnd(draft());
  fireEvent.change(screen.getByLabelText(t('attachmentChooseLabel')),{target:{files:[attachmentFile(undefined,'replacement.txt')]}});
  await screen.findByText(/replacement.txt/);
  expect(screen.queryByRole('button',{name:t('attachmentAddToChat')})).toBeNull();
  expect(draft()).toHaveProperty('value','Composing');
});
it.each(['pending','failed'] as const)('retires the prior path handoff when a repeat upload is %s',async phase=>{
  render(<ChatPanel sessionId={attachmentSession}/>);
  fireEvent.change(draft(),{target:{value:'Current unsent draft'}});
  await selectChatAttachment();await screen.findByRole('button',{name:t('attachmentAddToChat')});
  let finish!:(value:unknown)=>void,fail!:(error:unknown)=>void;
  vi.mocked(invoke).mockImplementation(async command=>command==='upload_file'?new Promise((resolve,reject)=>{finish=resolve;fail=reject;}):command==='upload_reserve'?{uploadId:'dd378c73-93a9-49eb-969e-27de325b0b03'}:attachmentReply(command));
  fireEvent.click(screen.getByRole('button',{name:t('attachmentUpload')}));
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  if(phase==='failed'){
    await act(async()=>{fail({message:'Second transfer failed'});});
    await screen.findByText('Second transfer failed');
  }
  try{
    expect(screen.queryByRole('button',{name:t('attachmentAddToChat')})).toBeNull();
    expect(draft()).toHaveProperty('value','Current unsent draft');
  }finally{
    if(phase==='pending')await act(async()=>{finish({path:'/second/late-path'});});
  }
});
