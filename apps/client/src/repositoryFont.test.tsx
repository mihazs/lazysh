// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import RepositoryPanel from './RepositoryPanel';
import {defaults,getPreferences,savePreferences} from './preferences';
import {fontFamilyFor,getDeviceFonts} from './fonts';
import {fileReviewName,fileReviewReply,fileReviewRoot,fileReviewSession} from './test/fileReviewData';

const loaded=vi.hoisted(()=>({family:undefined as string|undefined}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
vi.mock('./bridge',()=>({api:{readFile:vi.fn()}}));
vi.mock('./fonts',async()=>{
  const actual=await vi.importActual<typeof import('./fonts')>('./fonts');
  return {...actual,useDeviceFonts:()=>({...actual.getDeviceFonts(),primaryFamily:loaded.family})};
});
afterEach(()=>{cleanup();vi.clearAllMocks();sessionStorage.clear();});

it.each([undefined,'loaded-terminal-face'])('updates diff font without new requests, remounts or draft/data changes (imported=%s)',async family=>{
  loaded.family=family;
  savePreferences({...defaults,fontFamily:'serif',cjkFallback:'sans-serif'});
  vi.mocked(invoke).mockImplementation(async command=>fileReviewReply(command));
  const {api}=await import('./bridge');
  vi.mocked(api.readFile).mockResolvedValue('first line\nsecond line');
  render(<RepositoryPanel sessionId={fileReviewSession}/>);
  fireEvent.click(screen.getByRole('button',{name:'Open repository'}));
  fireEvent.click(await screen.findByRole('button',{name:'Read file'}));
  fireEvent.click(await screen.findByRole('button',{name:'Add line comment'}));
  const draft=screen.getByRole('textbox',{name:`${fileReviewRoot}/${fileReviewName}:1 Remove comment`});
  fireEvent.change(draft,{target:{value:'  unchanged user draft  '}});
  fireEvent.click(screen.getByRole('button',{name:'Unstaged diff'}));
  const table=await screen.findByRole('table',{name:'Side by side diff'});
  const contents=table.textContent;
  expect(table.style.fontFamily).toBe(fontFamilyFor(getPreferences(),{...getDeviceFonts(),primaryFamily:family}));
  const calls=vi.mocked(invoke).mock.calls.slice();
  const reads=vi.mocked(api.readFile).mock.calls.slice();
  const saved=sessionStorage.getItem(`lazysh-review:${fileReviewSession}`);
  act(()=>savePreferences({...getPreferences(),fontFamily:'monospace',cjkFallback:'serif'}));
  expect(screen.getByRole('table',{name:'Side by side diff'})).toBe(table);
  expect(table.style.fontFamily).toBe(fontFamilyFor(getPreferences(),{...getDeviceFonts(),primaryFamily:family}));
  expect(table.textContent).toBe(contents);
  expect(screen.getByRole('textbox',{name:`${fileReviewRoot}/${fileReviewName}:1 Remove comment`})).toBe(draft);
  expect((draft as HTMLTextAreaElement).value).toBe('  unchanged user draft  ');
  expect(vi.mocked(invoke).mock.calls).toEqual(calls);
  expect(vi.mocked(api.readFile).mock.calls).toEqual(reads);
  expect(sessionStorage.getItem(`lazysh-review:${fileReviewSession}`)).toBe(saved);
});
