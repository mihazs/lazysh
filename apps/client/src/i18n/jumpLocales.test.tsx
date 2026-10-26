// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import TmuxJumpPanel from '../TmuxJumpPanel';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../access';
import {tmuxJumpSnapshot as snapshot} from '../test/tmuxJumpData';
import {t,uiI18n,formatNumber} from './core';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:()=>true}));
beforeEach(()=>{
  vi.mocked(invoke).mockReset();
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic Jump To locale fixture',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'f'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
});
afterEach(async()=>{cleanup();vi.restoreAllMocks();localStorage.clear();await uiI18n.changeLanguage('en');});
async function cycle(assertView:()=>void){
  const calls=vi.mocked(invoke).mock.calls.slice();
  for(const language of ['pt-BR','es','en']){
    await act(async()=>{await uiI18n.changeLanguage(language);});
    assertView();expect(vi.mocked(invoke).mock.calls).toEqual(calls);
  }
}

it('keeps a held snapshot, focused layout and raw names while captions and the numeric index translate',async()=>{
  let finish!:(value:typeof snapshot)=>void;
  vi.mocked(invoke).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const writes=vi.spyOn(Storage.prototype,'setItem');
  const close=vi.fn(),jumped=vi.fn();
  render(<TmuxJumpPanel sessionId="locale-display" onClose={close} onJump={jumped}/>);
  const layout=screen.getByRole('combobox',{name:t('jumpLayout')});
  fireEvent.change(layout,{target:{value:'grid'}});layout.focus();
  const saved=writes.mock.calls.length;
  await cycle(()=>{
    expect(screen.getByRole('status').textContent).toBe(t('appReadingTmuxDestinations'));
    expect(screen.getByRole('combobox',{name:t('jumpLayout')})).toBe(layout);
    expect(document.activeElement).toBe(layout);expect(layout).toHaveProperty('value','grid');
    expect(writes).toHaveBeenCalledTimes(saved);
  });
  const name='jumpCurrent <raw> {{name}}';
  const result={...snapshot,sessions:[{...snapshot.sessions[0],name,windows:[{...snapshot.sessions[0].windows[0],name,index:1000}]}]};
  await act(async()=>{finish(result);});
  const current=screen.getByRole('button',{current:'location'});
  await cycle(()=>{
    expect(screen.getByText(name,{selector:'summary'})).toBeTruthy();
    expect(screen.getByRole('button',{current:'location'})).toBe(current);
    expect(current.textContent).toBe(`${formatNumber(1000)}: ${name} · ${t('jumpCurrent')}`);
    expect(localStorage.getItem('lazysh.multiplexer.layout')).toBe('grid');
  });
  fireEvent.click(current);expect(close).toHaveBeenCalledOnce();expect(jumped).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledExactlyOnceWith('tmux_jump_snapshot',{sessionId:'locale-display'},{headers:{'X-Lazysh-Access':'f'.repeat(64)}});
});

it('keeps a held jump on the original native generation and exact target IDs through language changes',async()=>{
  let finish!:(value:typeof snapshot)=>void;
  vi.mocked(invoke).mockResolvedValueOnce(snapshot).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const close=vi.fn(),jumped=vi.fn();
  render(<TmuxJumpPanel sessionId="original-display" onClose={close} onJump={jumped}/>);
  const target=await screen.findByRole('button',{name:'1: build'});fireEvent.click(target);
  await cycle(()=>{expect(target).toHaveProperty('disabled',true);expect(jumped).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();});
  expect(invoke).toHaveBeenLastCalledWith('tmux_jump',{sessionId:'original-display',generation:'actor-one',targetSessionId:'$2',windowId:'@4'},{headers:{'X-Lazysh-Access':'f'.repeat(64)}});
  const result={...snapshot,current:{sessionId:'$2',windowId:'@4'}};
  await act(async()=>{finish(result);});
  expect(jumped).toHaveBeenCalledExactlyOnceWith(result);expect(close).toHaveBeenCalledOnce();expect(invoke).toHaveBeenCalledTimes(2);
});

it('retranslates only the unavailable prefix while key-shaped native diagnostics remain literal',async()=>{
  const raw='jumpCurrent <native/path> {{reason}}';
  vi.mocked(invoke).mockRejectedValueOnce({name:'LocalUiError',key:'jumpCurrent',message:raw});
  render(<TmuxJumpPanel sessionId="failed-display" onClose={vi.fn()} onJump={vi.fn()}/>);
  const alert=await screen.findByRole('alert');
  await cycle(()=>{expect(screen.getByRole('alert')).toBe(alert);expect(alert.textContent).toBe(`${t('jumpUnavailable')} ${raw}`);expect(alert.textContent).toContain(raw);});
});
