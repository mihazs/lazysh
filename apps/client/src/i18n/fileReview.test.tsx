// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {FilesPanel,DiffPanel} from '../SessionTools';
import RepositoryPanel,{parseRepositoryStatus} from '../RepositoryPanel';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../access';
import {fileReviewName,fileReviewOid,fileReviewPatch,fileReviewReply,fileReviewRoot,fileReviewSession,fileReviewSource} from '../test/fileReviewData';
import {t,uiI18n} from './core';
vi.mock('@tauri-apps/api/core',async original=>(await import('../test/nativeCoreMock')).mockNativeCore(original));
beforeEach(()=>{
  sessionStorage.clear();
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic file-review locale fixture',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'d'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
  vi.mocked(invoke).mockImplementation(async command=>fileReviewReply(command));
});
afterEach(async()=>{cleanup();vi.clearAllMocks();await uiI18n.changeLanguage('en');});
it.each(['en','pt-BR','es'])('%s file and historical review actions preserve original paths, revisions, comments and leases across locale changes',async locale=>{
  await uiI18n.changeLanguage(locale);
  const stage=vi.fn();window.addEventListener('lazysh-prompt-draft',stage);
  try {
    const view=render(<><FilesPanel sessionId={fileReviewSession}/><RepositoryPanel sessionId={fileReviewSession}/><DiffPanel sessionId={fileReviewSession}/></>);
    const files=within(screen.getByRole('region',{name:t('filesRemote')}));
    fireEvent.click(await files.findByRole('button',{name:new RegExp(fileReviewName)}));
    const rawFile=await files.findByText(/const literal =/);
    const preview=rawFile.closest('pre')!;
    expect(preview.tabIndex).toBe(0);
    const reads=vi.mocked(invoke).mock.calls.length;
    fireEvent.click(files.getByRole('button',{name:t('codeHighlight')}));
    await waitFor(()=>expect(preview.querySelector('.hljs-keyword')).not.toBeNull());
    expect(preview.textContent).toBe(fileReviewSource);
    fireEvent.click(files.getByRole('button',{name:t('codePlain')}));
    expect(preview.textContent).toBe(fileReviewSource);
    expect(preview.querySelector('.hljs-keyword')).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(reads);
    fireEvent.click(screen.getByRole('button',{name:t('repoOpen')}));
    await screen.findByRole('option',{name:/Literal commit subject/});
    fireEvent.change(screen.getByRole('combobox',{name:t('repoRevisionLabel')}),{target:{value:fileReviewOid}});
    const repository=within(screen.getByRole('region',{name:t('repoTitle')}));
    fireEvent.click(await repository.findByRole('button',{name:new RegExp(fileReviewName)}));
    await repository.findByText(/const literal =/);
    fireEvent.click(repository.getByRole('button',{name:t('repoAddComment')}));
    const comment=repository.getByRole('textbox',{name:new RegExp(fileReviewName+':1')});
    fireEvent.change(comment,{target:{value:'Please explain this literal line.'}});
    fireEvent.click(repository.getByRole('button',{name:t('repoUsePrompt')}));
    expect(stage.mock.calls[0][0].detail).toEqual({sessionId:fileReviewSession,text:`${fileReviewRoot}/${fileReviewName}:1 (commit ${fileReviewOid})\nPlease explain this literal line.`});
    const originalCalls=vi.mocked(invoke).mock.calls.length;
    (comment as HTMLTextAreaElement).focus();
    await act(async()=>{await uiI18n.changeLanguage(locale==='es'?'pt-BR':'es');});
    expect(screen.getByRole('textbox',{name:new RegExp(fileReviewName+':1')})).toBe(comment);
    expect(document.activeElement).toBe(comment);expect(comment).toHaveProperty('value','Please explain this literal line.');
    expect(screen.getByRole('combobox',{name:t('repoRevisionLabel')})).toHaveProperty('value',fileReviewOid);
    expect(rawFile.isConnected).toBe(true);expect(invoke).toHaveBeenCalledTimes(originalCalls);
    expect(screen.getByText(t('repoCommentsStaged'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:t('diffRead')}));
    await screen.findByText('before literal',{exact:false});
    expect(view.container.querySelector('.diff-content')?.textContent).toBe(fileReviewPatch+'\n');
    expect(view.container.querySelector('img,script,iframe')).toBeNull();
    expect(()=>parseRepositoryStatus(null)).toThrow(t('repoInvalid'));
    for(const call of vi.mocked(invoke).mock.calls)expect(call[2]).toEqual({headers:{'X-Lazysh-Access':'d'.repeat(64)}});
    expect(invoke).toHaveBeenCalledWith('repository_blob',{sessionId:fileReviewSession,path:fileReviewRoot,objectId:fileReviewOid},expect.anything());
    expect(invoke).toHaveBeenCalledWith('read_file',{sessionId:fileReviewSession,path:'./'+fileReviewName},expect.anything());
  } finally {window.removeEventListener('lazysh-prompt-draft',stage);}
});
it.each(['en','pt-BR','es'])('%s keeps file-size validation and pending repository loading translated while raw failures remain verbatim',async locale=>{
  await uiI18n.changeLanguage(locale);
  const view=render(<><FilesPanel sessionId={fileReviewSession}/><RepositoryPanel sessionId={fileReviewSession}/></>);
  await screen.findByRole('button',{name:new RegExp(fileReviewName)});
  const file=new File(['small'],'too-large.bin');Object.defineProperty(file,'size',{value:10485761});
  fireEvent.change(view.container.querySelector('input[type=file]')!,{target:{files:[file]}});
  expect(screen.getByRole('alert').textContent).toBe(t('filesTooLarge'));
  let reject!: (reason:Error)=>void;
  vi.mocked(invoke).mockImplementationOnce(()=>new Promise((_,rejectCall)=>{reject=rejectCall;}));
  fireEvent.click(screen.getByRole('button',{name:t('repoOpen')}));
  expect(screen.getByText(t('repoReading'))).toBeTruthy();
  await act(async()=>{await uiI18n.changeLanguage(locale==='en'?'pt-BR':'en');});
  expect(screen.getByText(t('repoReading'))).toBeTruthy();
  await act(async()=>{reject(new Error('EXACT remote /path failure: <literal>'));});
  expect(screen.getByText('EXACT remote /path failure: <literal>')).toBeTruthy();
});

it.each(['session','unmount','lease'] as const)('does not expose a late source preview after %s changes',async transition=>{
  let complete!: (text:string)=>void;
  vi.mocked(invoke).mockImplementation(async command=>command==='read_file'
    ? new Promise<string>(resolve=>{complete=resolve;}) : fileReviewReply(command));
  const view=render(<FilesPanel sessionId={fileReviewSession}/>);
  fireEvent.click(await screen.findByRole('button',{name:new RegExp(fileReviewName)}));
  if(transition==='session')view.rerender(<FilesPanel sessionId="replacement-session"/>);
  else if(transition==='unmount')view.unmount();
  else await act(async()=>{applyAccessStatus({initialized:true,supported:true,enabled:true,locked:true,reason:'Synthetic revoked file lease',generation:String(BigInt(accessSnapshot().status!.generation)+1n)});});
  await act(async()=>{complete('const obsoletePrivate = 1;');});
  expect(screen.queryByText('const obsoletePrivate = 1;')).toBeNull();
  expect(screen.queryByRole('button',{name:t('codeHighlight')})).toBeNull();
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='read_file')).toHaveLength(1);
});
