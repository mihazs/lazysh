// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {applyAccessStatus} from './access';
import HerdrNavigation from './HerdrNavigation';
import {herdrNavigationTree as base} from './test/herdrNavigation';
import {t} from './i18n/core';

vi.mock('@tauri-apps/api/core', async original => ({...await original<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn(),Channel:class {onmessage?:unknown;}}));

const key='lazysh.multiplexer.layout';
const tree={...base,
  workspaces:[...base.workspaces,{workspace_id:'w3',label:'Review',focused:false,agent_status:'idle'}],
  tabs:[...base.tabs,{tab_id:'w3:t1',workspace_id:'w3',label:'Review tab',number:1,focused:false,agent_status:'idle'}]};
const props={sessionId:'layouts',hostLabel:'Owned host',visible:true,mode:'spaces' as const,onAttach:vi.fn(),onClose:vi.fn()};
let generation=0;

async function mount(onNavigate=vi.fn(async()=>{})) {
  const {invoke}=await import('@tauri-apps/api/core');
  vi.mocked(invoke).mockImplementation(async command=>command==='multiplexer_sessions'?[{name:'default'}]:tree);
  const view=render(<HerdrNavigation {...props} onNavigate={onNavigate}/>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
  return {view,onNavigate};
}
const layout=()=>screen.getByRole('combobox',{name:t('jumpLayout')}) as HTMLSelectElement;
const choose=(value:string)=>fireEvent.change(layout(),{target:{value}});

beforeEach(()=>{
  applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(++generation),nonce:'a'.repeat(64)});
  localStorage.removeItem(key);vi.useFakeTimers();
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();localStorage.removeItem(key);});

it('lists every space expanded by default and opens only the focused space in the accordion layout',async()=>{
  await mount();
  expect(layout().value).toBe('list');
  expect(screen.getByText('Code')).toBeTruthy();expect(screen.getByText('Review tab')).toBeTruthy();
  choose('accordion');
  expect(screen.getByText('Code')).toBeTruthy();expect(screen.queryByText('Review tab')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:t('herdrNavigationCollapse',{name:'Review'})}));
  expect(screen.getByText('Review tab')).toBeTruthy();
  choose('list');
  expect(document.querySelector('.herdr-navigation-tree')?.classList.contains('herdr-layout-list')).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:t('herdrNavigationCollapse',{name:'Review'})}));
  expect(screen.queryByText('Review tab')).toBeNull();
});

it('remembers the layout in the shared preference and restores it in a new view',async()=>{
  const first=await mount();
  choose('grid');
  expect(localStorage.getItem(key)).toBe('grid');
  expect(document.querySelector('.herdr-navigation-tree')?.classList.contains('herdr-layout-grid')).toBe(true);
  first.view.unmount();
  await mount();
  expect(layout().value).toBe('grid');
  expect(document.querySelector('.herdr-navigation-tree')?.classList.contains('herdr-layout-grid')).toBe(true);
});

it('adopts the layout the tmux Jump To panel saved and ignores a value it does not know',async()=>{
  localStorage.setItem(key,'accordion');
  const first=await mount();
  expect(layout().value).toBe('accordion');
  first.view.unmount();
  localStorage.setItem(key,'carousel');
  await mount();
  expect(layout().value).toBe('list');
});

it('keeps working when storage is unavailable',async()=>{
  vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('blocked');});
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('blocked');});
  await mount();
  expect(layout().value).toBe('list');
  choose('grid');
  expect(layout().value).toBe('grid');
  expect(document.querySelector('.herdr-navigation-tree')?.classList.contains('herdr-layout-grid')).toBe(true);
});

it.each(['list','accordion','grid'])('opens the exact tab it shows in the %s layout',async value=>{
  localStorage.setItem(key,value);
  const {onNavigate}=await mount();
  // The accordion keeps the unfocused space closed; its heading row is still the exact workspace target.
  fireEvent.click(screen.getAllByRole('button',{name:/^Review/})[0]);await act(async()=>{});
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith('default',{kind:'workspace',workspace:'w3'},expect.anything(),expect.any(Function));
  if(value!=='accordion') {
    onNavigate.mockClear();
    fireEvent.click(screen.getByRole('button',{name:/^Review tab/}));await act(async()=>{});
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('default',{kind:'tab',workspace:'w3',tab:'w3:t1'},expect.anything(),expect.any(Function));
  }
});

it.each(['list','accordion','grid'])('marks only the focused space as current in the %s layout',async value=>{
  localStorage.setItem(key,value);
  await mount();
  const current=(name:RegExp)=>screen.getAllByRole('button',{name}).filter(row=>row.getAttribute('data-current')==='true');
  expect(current(/^Work/)).toHaveLength(1);
  expect(current(/^Review/)).toHaveLength(0);
});
