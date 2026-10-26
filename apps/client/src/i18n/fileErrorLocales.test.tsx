// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {FilesPanel} from '../SessionTools';
import RepositoryPanel from '../RepositoryPanel';
import {fileReviewName,fileReviewOid,fileReviewReply,fileReviewSession} from '../test/fileReviewData';
import {t,uiI18n} from './core';
vi.mock('@tauri-apps/api/core',async original=>(await import('../test/nativeCoreMock')).mockNativeCore(original));
beforeEach(()=>{sessionStorage.clear();vi.mocked(invoke).mockImplementation(async command=>fileReviewReply(command));});
afterEach(async()=>{cleanup();vi.clearAllMocks();await uiI18n.changeLanguage('en');});

async function verifyVisibleError(expected:()=>string) {
  const alert=await screen.findByRole('alert');
  expect(alert.textContent).toBe(expected());
  const calls=[...vi.mocked(invoke).mock.calls];
  const inputs=[...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')].map(input=>({input,value:input.value}));
  for(const language of ['pt-BR','es','en']) {
    await act(async()=>{await uiI18n.changeLanguage(language);});
    expect(screen.getByRole('alert')).toBe(alert);
    expect(alert.textContent).toBe(expected());
    expect(invoke).toHaveBeenCalledTimes(calls.length);
    expect(vi.mocked(invoke).mock.calls).toEqual(calls);
    for(const {input,value} of inputs){expect(input.isConnected).toBe(true);expect(input.value).toBe(value);}
    expect(document.querySelector('img,script,iframe')).toBeNull();
  }
}

it('retranslates an already-visible oversized-upload validation without reading or uploading the file',async()=>{
  render(<FilesPanel sessionId={fileReviewSession}/>);
  await screen.findByRole('button',{name:new RegExp(fileReviewName)});
  fireEvent.change(screen.getByRole('textbox',{name:t('filesDirectory')}),{target:{value:'/unchanged/user directory'}});
  const file=new File(['not read'],'literal <name>.bin');Object.defineProperty(file,'size',{value:10485761});
  fireEvent.change(screen.getByLabelText(t('filesChooseUpload')),{target:{files:[file]}});
  await verifyVisibleError(()=>t('filesTooLarge'));
  expect(vi.mocked(invoke).mock.calls.map(([command])=>command)).toEqual(['list_directory']);
});

const rawDiagnostic='repoInvalid\nInvalid repository response. Update the client and reconnect.\n<literal /private/user-path {{key}}>';
it('preserves a file-host diagnostic even when its text resembles a local key or translated message',async()=>{
  vi.mocked(invoke).mockRejectedValueOnce({name:'LocalFileError',key:'repoInvalid',message:rawDiagnostic});
  render(<FilesPanel sessionId={fileReviewSession}/>);
  await verifyVisibleError(()=>rawDiagnostic);
});

it.each([
  {name:'status parser',command:'repository_status',step:'open',key:'repoInvalid'},
  {name:'history parser with local cause',command:'repository_history',step:'open',key:'repoInvalid',history:true},
  {name:'history native failure',command:'repository_history',step:'open',raw:true,history:true},
  {name:'tree parser',command:'repository_tree',step:'revision',key:'repoInvalid'},
  {name:'blob parser',command:'repository_blob',step:'blob',key:'repoInvalid'},
  {name:'diff parser',command:'repository_diff',step:'diff',key:'repoInvalid'},
  {name:'image parser',command:'repository_image',step:'image',key:'repoInvalid'},
  {name:'submodule validation',command:'unused',step:'submodule',key:'repoSubmodule'},
  {name:'current file validation',command:'read_file',step:'file',key:'repoInvalidFile'},
  {name:'raw current-file diagnostic',command:'read_file',step:'file',raw:true},
] as const)('keeps $name errors live in the current locale without changing original requests',async scenario=>{
  const historical=['revision','blob','image','submodule'].includes(scenario.step);
  const selected=scenario.step==='image'?'literal.png':fileReviewName;
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command===scenario.command) {
      if('raw' in scenario)throw new Error(rawDiagnostic);
      return null;
    }
    if(command==='repository_tree')return [{path:selected,oid:fileReviewOid,kind:scenario.step==='submodule'?'commit':'blob',size:20}];
    return fileReviewReply(command);
  });
  render(<RepositoryPanel sessionId={fileReviewSession}/>);
  fireEvent.change(screen.getByRole('textbox',{name:t('repoDirectory')}),{target:{value:'/unchanged/request path'}});
  fireEvent.click(screen.getByRole('button',{name:t('repoOpen')}));
  if(scenario.step!=='open') {
    await screen.findByRole('option',{name:/Literal commit subject/});
    if(historical)fireEvent.change(screen.getByRole('combobox',{name:t('repoRevisionLabel')}),{target:{value:fileReviewOid}});
    if(scenario.step!=='revision')fireEvent.click(await screen.findByRole('button',{name:historical?new RegExp(selected):t(scenario.step==='diff'?'repoStaged':'repoRead')}));
  }
  await verifyVisibleError(()=>{
    const cause='raw' in scenario?rawDiagnostic:t(scenario.key);
    return 'history' in scenario?t('repoHistoryUnavailable',{error:cause}):cause;
  });
});
