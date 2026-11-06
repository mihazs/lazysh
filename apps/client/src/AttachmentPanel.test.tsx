import {attachmentPngHeader,attachmentReceipt} from './test/attachmentData';
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AttachmentPanel from './AttachmentPanel';
import { api } from './bridge';

vi.mock('./bridge', () => ({ api: { uploadFile: vi.fn(), reserveUpload:vi.fn(),cancelUpload:vi.fn() } }));
beforeEach(()=>{vi.mocked(api.reserveUpload).mockResolvedValue({uploadId:attachmentReceipt});vi.mocked(api.cancelUpload).mockResolvedValue({outcome:'unknown_or_settled'});});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
function file(name = 'report.txt', content = 'hello') {
  const value = new File([content], name, { type: 'text/plain' });
  Object.defineProperty(value, 'arrayBuffer', { value: async () => new TextEncoder().encode(content).buffer });
  return value;
}
it('stages a private file, uploads only on explicit action, and exposes a quoted editable prompt', async () => {
  vi.mocked(api.uploadFile).mockResolvedValue({path:"/work/a'b.txt"});
  render(<AttachmentPanel sessionId="ssh-one" />);
  fireEvent.change(screen.getByLabelText('Choose attachment'), { target: { files: [file()] } });
  await screen.findByText(/report.txt · 5 bytes/);
  expect(api.uploadFile).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Destination path'), { target: { value: "/work/a'b.txt" } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload attachment' }));
  await screen.findByLabelText('Host path');
  expect(api.uploadFile).toHaveBeenCalledWith('ssh-one', "/work/a'b.txt", [104, 101, 108, 108, 111],attachmentReceipt);
  expect(screen.getByLabelText('Host path')).toHaveProperty('value', "'/work/a'\\''b.txt'");
  expect(screen.getByLabelText('Editable prompt')).toHaveProperty('value', "Please review the attached file '/work/a'\\''b.txt'.");
  fireEvent.change(screen.getByLabelText('Editable prompt'), { target: { value: 'My own prompt' } });
  expect(screen.getByLabelText('Editable prompt')).toHaveProperty('value', 'My own prompt');
  const staged = vi.fn(); window.addEventListener('lazysh-prompt-draft', staged);
  fireEvent.click(screen.getByRole('button', { name: 'Stage in terminal' }));
  expect(staged).toHaveBeenCalledOnce();
  expect((staged.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 'ssh-one', text: 'My own prompt' });
  window.removeEventListener('lazysh-prompt-draft', staged);
});
it('saves to a private host /tmp file by default and shows the path the host chose', async () => {
  vi.mocked(api.uploadFile).mockResolvedValue({path:'/tmp/lazysh-0123456789ab-report.txt'});
  render(<AttachmentPanel sessionId="ssh-one" />);
  fireEvent.change(screen.getByLabelText('Choose attachment'), { target: { files: [file()] } });
  const destination = await screen.findByLabelText('Destination path');
  expect(destination).toHaveProperty('value', '');
  expect(document.getElementById(destination.getAttribute('aria-describedby')!)?.textContent).toBe('Leave empty to save a private copy under /tmp with a unique name. Enter a path to save it there instead.');
  fireEvent.click(screen.getByRole('button', { name: 'Upload attachment' }));
  await screen.findByLabelText('Host path');
  expect(api.uploadFile).toHaveBeenCalledExactlyOnceWith('ssh-one', 'report.txt', [104, 101, 108, 108, 111], attachmentReceipt, true);
  expect(screen.getByLabelText('Host path')).toHaveProperty('value', "'/tmp/lazysh-0123456789ab-report.txt'");
});
it('labels a default /tmp upload in the terminal draft with the picked file name, and a typed path with its own name', async () => {
  const attach = vi.fn();
  vi.mocked(api.uploadFile).mockResolvedValueOnce({path:'/tmp/lazysh-0123456789ab-report.txt'}).mockResolvedValueOnce({path:'/work/notes.txt'});
  render(<AttachmentPanel sessionId="ssh-one" attachTarget="composer" onAttach={attach} />);
  fireEvent.change(screen.getByLabelText('Choose attachment'), { target: { files: [file()] } });
  await screen.findByText(/report.txt · 5 bytes/);
  fireEvent.click(screen.getByRole('button', { name: 'Upload attachment' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add to the terminal draft' }));
  expect(attach).toHaveBeenLastCalledWith('/tmp/lazysh-0123456789ab-report.txt', {name:'report.txt',kind:'file',preview:undefined});
  fireEvent.change(screen.getByLabelText('Destination path'), { target: { value: '/work/notes.txt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload attachment' }));
  await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(2));
  fireEvent.click(await screen.findByRole('button', { name: 'Add to the terminal draft' }));
  expect(attach).toHaveBeenLastCalledWith('/work/notes.txt', {name:'notes.txt',kind:'file',preview:undefined});
});
it('cancels before upload, rejects invalid destination, and reports native no-overwrite errors', async () => {
  vi.mocked(api.uploadFile).mockRejectedValue({ message: 'Remote file already exists' });
  render(<AttachmentPanel sessionId="ssh-one" />);
  fireEvent.change(screen.getByLabelText('Choose attachment'), { target: { files: [file()] } });
  await screen.findByLabelText('Destination path');
  fireEvent.change(screen.getByLabelText('Destination path'), { target: { value: '/a\tb' } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload attachment' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Enter a destination without control characters, no longer than 4096 characters.');
  expect(api.uploadFile).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Destination path'), { target: { value: '/exists' } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload attachment' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveProperty('textContent', 'Remote file already exists'));
  expect(screen.queryByLabelText('Host path')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel attachment' }));
  expect(screen.queryByLabelText('Destination path')).toBeNull();
});
it('handles clipboard permission denial without automatic uploads', async () => {
  const read = vi.fn().mockRejectedValue(new Error('Clipboard permission denied'));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read } });
  render(<AttachmentPanel sessionId="ssh-one" />);
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Paste clipboard image' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Clipboard permission denied');
  expect(api.uploadFile).not.toHaveBeenCalled();
});

async function openEditableImage(onRestoreFileTransfer?:(restored:()=>void)=>void,destination?:string) {
  const bytes = attachmentPngHeader();
  const image = new File([bytes], 'shot.png', { type: 'image/png' });
  Object.defineProperty(image, 'arrayBuffer', { value: async () => bytes.buffer });
  const context = { clearRect: vi.fn(), drawImage: vi.fn(), translate: vi.fn(), strokeRect: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('Image', class {
    naturalWidth = 100; naturalHeight = 80; onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(value: string) { if (value) queueMicrotask(() => this.onload?.()); }
  });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:local-image') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.mocked(api.uploadFile).mockResolvedValue({path:"/work/a'b.txt"});
  render(<AttachmentPanel sessionId="ssh-one" onRestoreFileTransfer={onRestoreFileTransfer} />);
  fireEvent.change(screen.getByLabelText('Choose attachment'), { target: { files: [image] } });
  const editing=await screen.findByLabelText('Crop or annotate PNG/JPEG');
  if(destination)fireEvent.change(screen.getByLabelText('Destination path'),{target:{value:destination}});
  fireEvent.click(editing);
  await waitFor(() => expect(context.drawImage).toHaveBeenCalled());
  return context;
}
it('flattens an explicit crop to PNG before the bounded upload', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback({ size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Blob));
  const context=await openEditableImage();
  fireEvent.change(screen.getByLabelText('Crop x'), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText('Crop width'), { target: { value: '50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload attachment' }));
  await screen.findByLabelText('Host path');
  expect(context.translate).toHaveBeenCalledWith(-10, -0);
  expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
  expect(api.uploadFile).toHaveBeenCalledWith('ssh-one', 'shot-edited.png', [1, 2, 3],attachmentReceipt,true);
});

it('turning on editing keeps a destination the user already typed',async()=>{
  vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(callback=>callback({size:3,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer} as Blob));
  await openEditableImage(undefined,'/srv/keep.png');
  expect(screen.getByLabelText('Destination path')).toHaveProperty('value','/srv/keep.png');
  fireEvent.click(screen.getByRole('button',{name:'Upload attachment'}));
  await screen.findByLabelText('Host path');
  expect(api.uploadFile).toHaveBeenCalledWith('ssh-one','/srv/keep.png',[1,2,3],attachmentReceipt);
});

it('cancelling held PNG encoding never reserves or uploads its late final bytes',async()=>{
  let encode!:BlobCallback;
  vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(callback=>{encode=callback;});
  await openEditableImage();
  fireEvent.click(screen.getByRole('button',{name:'Upload attachment'}));
  await waitFor(()=>expect(encode).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button',{name:'Cancel attachment'}));
  await act(async()=>{encode({size:3,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer} as Blob);});
  expect(api.reserveUpload).not.toHaveBeenCalled();expect(api.uploadFile).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Host path')).toBeNull();
});
it('a clipboard read started earlier cannot replace the selection during an owned upload',async()=>{
  let paste!:(items:unknown[])=>void;let finish!:(value:{path:string})=>void;
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:()=>new Promise(resolve=>{paste=resolve;})}});
  const decode=vi.fn(async()=>attachmentPngHeader().buffer);vi.stubGlobal('File',class extends File {arrayBuffer=decode;});
  vi.mocked(api.uploadFile).mockImplementation(()=>new Promise<{path:string}>(resolve=>{finish=resolve;}));
  render(<AttachmentPanel sessionId="ssh-one"/>);
  fireEvent.click(screen.getByRole('button',{name:'Paste clipboard image'}));
  await waitFor(()=>expect(paste).toBeTypeOf('function'));
  fireEvent.change(screen.getByLabelText('Choose attachment'),{target:{files:[file()]}});
  await screen.findByText(/report.txt · 5 bytes/);fireEvent.click(screen.getByRole('button',{name:'Upload attachment'}));
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  await act(async()=>{paste([{types:['image/png'],getType:async()=>new Blob([attachmentPngHeader()],{type:'image/png'})}]);});
  expect(screen.getByText(/report.txt · 5 bytes/)).toBeTruthy();expect(decode).not.toHaveBeenCalled();
  await act(async()=>{finish({path:"/host/report.txt"});});expect(screen.getByLabelText('Host path')).toHaveProperty('value',"'/host/report.txt'");
});

it('keeps edited attachment and destination through explicit upload recovery without retrying automatically',async()=>{
  let restored!:()=>void;const recover=vi.fn((done:()=>void)=>{restored=done;});
  await openEditableImage(recover);
  vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(callback=>callback({size:3,arrayBuffer:async()=>new Uint8Array([7,8,9]).buffer} as Blob));
  const warning='The SSH file-transfer connection is closed. A partial new file may remain; uploads never overwrite existing files.';
  vi.mocked(api.uploadFile).mockRejectedValue({kind:'ssh_control_closed',message:warning});
  fireEvent.change(screen.getByLabelText('Crop x'),{target:{value:'10'}});
  fireEvent.change(screen.getByLabelText('Crop width'),{target:{value:'40'}});
  fireEvent.change(screen.getByLabelText('Destination path'),{target:{value:'./original-edited.png'}});
  fireEvent.click(screen.getByRole('button',{name:'Upload attachment'}));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',warning);
  expect(screen.queryByRole('button',{name:'Reconnect host tools'})).toBeNull();
  fireEvent.click(await screen.findByRole('button',{name:'Reconnect uploads'}));
  expect(recover).toHaveBeenCalledOnce();
  await act(async()=>restored());
  expect(screen.getByLabelText('Crop x')).toHaveProperty('value','10');
  expect(screen.getByLabelText('Destination path')).toHaveProperty('value','./original-edited.png');
  expect(screen.getByRole('status').textContent).toContain('Uploads reconnected');
  expect(api.uploadFile).toHaveBeenCalledTimes(1);
  vi.mocked(api.uploadFile).mockResolvedValue({path:'/owned/original-edited.png'});
  fireEvent.click(screen.getByRole('button',{name:'Upload attachment'}));
  await waitFor(()=>expect(api.uploadFile).toHaveBeenCalledTimes(2));
  expect(api.uploadFile).toHaveBeenLastCalledWith('ssh-one','./original-edited.png',[7,8,9],attachmentReceipt);
});

it('puts the explicit uploaded-path action before optional tools without sending automatically',async()=>{
  const onPastePath=vi.fn().mockResolvedValue(undefined);
  vi.mocked(api.uploadFile).mockResolvedValue({path:'/work/report.txt'});
  render(<AttachmentPanel sessionId="ssh-one" onPastePath={onPastePath}/>);
  fireEvent.change(screen.getByLabelText('Choose attachment'),{target:{files:[file()]}});
  await screen.findByText(/report.txt · 5 bytes/);
  expect(screen.getByText('Upload options').closest('details')?.open).toBe(false);
  const selected=screen.getByText(/report.txt · 5 bytes/).closest('details')!;
  expect(selected.open).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Upload attachment'}));
  const paste=await screen.findByRole('button',{name:'Paste uploaded path'});
  const options=screen.getByText('More attachment actions').closest('details')!;
  expect(options.open).toBe(false);
  expect(selected.open).toBe(false);
  expect(screen.getByRole('button',{name:'Upload attachment'}).closest('details')).toBe(selected);
  expect(paste.compareDocumentPosition(options)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(onPastePath).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText(/report.txt · 5 bytes/));
  expect(screen.getByRole('button',{name:'Upload attachment'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'Cancel attachment'})).toBeTruthy();
  expect(api.uploadFile).toHaveBeenCalledTimes(1);
  fireEvent.click(paste);
  await waitFor(()=>expect(onPastePath).toHaveBeenCalledTimes(1));
});
