// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import AttachmentPanel from './AttachmentPanel';
import {api} from './bridge';
import {attachmentFile,attachmentReceipt,attachmentUploadedPath} from './test/attachmentData';
import {attachmentTerminalInput,type AttachmentPathPaste} from './attachmentPaste';
import {accessSnapshot,applyAccessStatus} from './access';

vi.mock('./bridge',()=>({api:{reserveUpload:vi.fn(),cancelUpload:vi.fn(),uploadFile:vi.fn()}}));
beforeEach(()=>{
  authority();
  vi.mocked(api.reserveUpload).mockResolvedValue({uploadId:attachmentReceipt});
  vi.mocked(api.uploadFile).mockResolvedValue({path:attachmentUploadedPath});
  vi.mocked(api.cancelUpload).mockResolvedValue({outcome:'unknown_or_settled'});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.clearAllMocks();});
function authority(locked=false){applyAccessStatus({initialized:true,supported:true,enabled:true,locked,
  generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),reason:'Synthetic attachment paste fixture',...(locked?{}:{nonce:'a'.repeat(64)})});}
async function upload(){
  fireEvent.change(screen.getByLabelText('Choose attachment'),{target:{files:[attachmentFile()]}});
  fireEvent.click(await screen.findByRole('button',{name:'Upload attachment'}));
  return await screen.findByLabelText('Editable prompt');
}

it('admits only an explicit paste of the completed original path without changing the prompt',async()=>{
  const paste=vi.fn(async(request:{sessionId:string;path:string;claim:()=>boolean})=>{expect(request.claim()).toBe(true);});
  render(<AttachmentPanel sessionId="ssh-original" {...{onPastePath:paste}}/>);
  expect(screen.queryByRole('button',{name:'Paste uploaded path'})).toBeNull();
  const prompt=await upload();
  fireEvent.change(prompt,{target:{value:'  keep my exact draft  '}});
  expect(paste).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Paste uploaded path'}));
  await screen.findByText('Path sent without Enter. Check the terminal before continuing.');
  expect(paste).toHaveBeenCalledWith({sessionId:'ssh-original',path:attachmentUploadedPath,claim:expect.any(Function)});
  expect((prompt as HTMLTextAreaElement).value).toBe('  keep my exact draft  ');
});

it.each([undefined,null,{},[], 'relative.txt','C:relative','/a/../b','/a/./b','/','/file/',
  '/a\rb','/a\nb','/a\tb','/a\x1b[201~b','/a\x7fb','/a\x85b','/a\x9bb','/a\u2028b','/a\u2029b','/a\ud800b',
  '/'+ 'a'.repeat(4096),'/'+ '界'.repeat(1366)].map(path=>({path})))('refuses invalid terminal path %# without stripping it',({path})=>{
  expect(()=>attachmentTerminalInput(path,true)).toThrow('valid single-line absolute path');
});
it.each([[false,false],[true,false],[true,true]] as const)('quotes literal bytes with public terminal paste modes (%s, ignore=%s)',(bracketed,ignore)=>{
  const literal="'/host/a'\\''b $(touch NEVER) & 中文.txt'";
  expect(attachmentTerminalInput("/host/a'b $(touch NEVER) & 中文.txt",bracketed,ignore)).toBe(bracketed&&!ignore?`\x1b[200~${literal}\x1b[201~`:literal);
  expect(attachmentTerminalInput('C:/host/space name.txt',false)).toBe("'C:/host/space name.txt'");
});
it('holds one native paste, preserves edits and never retries a rejected write',async()=>{
  let reject!:(error:unknown)=>void;
  const paste=vi.fn((request:AttachmentPathPaste)=>{expect(request.claim()).toBe(true);expect(request.claim()).toBe(false);return new Promise<void>((_,fail)=>{reject=fail;});});
  render(<AttachmentPanel sessionId="ssh-original" onPastePath={paste}/>);
  const prompt=await upload();
  const button=screen.getByRole('button',{name:'Paste uploaded path'});
  fireEvent.click(button);fireEvent.click(button);
  expect(paste).toHaveBeenCalledOnce();
  expect(screen.getByRole('button',{name:'Sending path…'})).toHaveProperty('disabled',true);
  fireEvent.change(prompt,{target:{value:'  edited while sending  '}});
  await act(async()=>reject('RAW original write failure'));
  expect(screen.getByRole('alert').textContent).toBe('RAW original write failure');
  expect((prompt as HTMLTextAreaElement).value).toBe('  edited while sending  ');
  expect(paste).toHaveBeenCalledOnce();
});
it.each(['hidden','unmount','revoked','session'] as const)('rejects a retained claim and late publication after %s',async boundary=>{
  let request!:AttachmentPathPaste;let finish!:()=>void;
  const paste=vi.fn((value:AttachmentPathPaste)=>{request=value;return new Promise<void>(resolve=>{finish=resolve;});});
  const view=render(<AttachmentPanel sessionId="ssh-original" onPastePath={paste}/>);
  await upload();fireEvent.click(screen.getByRole('button',{name:'Paste uploaded path'}));
  act(()=>{
    if(boundary==='hidden')vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
    else if(boundary==='unmount')view.unmount();
    else if(boundary==='revoked'){authority(true);authority();}
    else view.rerender(<AttachmentPanel sessionId="ssh-replacement" onPastePath={paste}/>);
  });
  expect(request.claim()).toBe(false);
  await act(async()=>finish());
  expect(screen.queryByText('Path sent without Enter. Check the terminal before continuing.')).toBeNull();
  expect(paste).toHaveBeenCalledOnce();
});
it.each(['edit','cancel','failure','chat'] as const)('does not expose terminal paste for an invalidated upload or Chat (%s)',async boundary=>{
  const paste=vi.fn(async()=>{});
  if(boundary==='failure')vi.mocked(api.uploadFile).mockRejectedValue('RAW upload failure');
  render(<AttachmentPanel sessionId="ssh-original" onPastePath={paste} {...(boundary==='chat'?{onAttach:()=>{}}:{})}/>);
  if(boundary==='failure'){
    fireEvent.change(screen.getByLabelText('Choose attachment'),{target:{files:[attachmentFile()]}});
    fireEvent.click(await screen.findByRole('button',{name:'Upload attachment'}));
    await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe('RAW upload failure'));
  }else{
    await upload();
    if(boundary==='edit')fireEvent.change(screen.getByLabelText('Destination path'),{target:{value:'/different/file.txt'}});
    if(boundary==='cancel')fireEvent.click(screen.getByRole('button',{name:'Cancel attachment'}));
  }
  expect(screen.queryByRole('button',{name:'Paste uploaded path'})).toBeNull();
  expect(paste).not.toHaveBeenCalled();
});
