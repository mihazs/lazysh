// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MultiplexerShortcuts from './MultiplexerShortcuts';
import { api } from './bridge';
import {uiI18n,t} from './i18n/core';
import {accessSnapshot,applyAccessStatus} from './access';
function access(locked=false){applyAccessStatus({initialized:true,supported:true,enabled:true,locked,reason:'test',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),...(locked?{}:{nonce:'a'.repeat(64)})});}
beforeEach(()=>access());
vi.mock('./bridge', () => ({ api: { writeSequence: vi.fn().mockResolvedValue(undefined) }, native: true }));
afterEach(async() => { cleanup();await uiI18n.changeLanguage('en'); localStorage.clear(); vi.clearAllMocks(); });
it('discards a held old acknowledgement without changing stale UI or issuing a fresh request',async()=>{
  let reject!:(error:Error)=>void;
  vi.mocked(api.writeSequence).mockImplementationOnce(()=>new Promise<void>((_resolve,fail)=>{reject=fail;}));
  const old=render(<MultiplexerShortcuts sessionId="attached-tmux" kind="tmux" />);
  fireEvent.click(screen.getByRole('button',{name:'New window'}));
  expect(api.writeSequence).toHaveBeenCalledTimes(1);
  access(true);access();
  await act(async()=>reject(new Error('private stale failure')));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button',{name:'New window'}).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'New window'}));
  expect(api.writeSequence).toHaveBeenCalledTimes(1);
  old.unmount();render(<MultiplexerShortcuts sessionId="attached-tmux" kind="tmux" />);
  fireEvent.click(screen.getByRole('button',{name:'New window'}));
  await waitFor(()=>expect(api.writeSequence).toHaveBeenCalledTimes(2));
});
it('sends a validated custom prefix and action only to the attached PTY', async () => {
  render(<MultiplexerShortcuts sessionId="attached-tmux" kind="tmux" />);
  fireEvent.change(screen.getByLabelText('Multiplexer prefix key'), { target: { value: 'Ctrl+a' } });
  fireEvent.click(screen.getByRole('button', { name: 'New window' }));
  await waitFor(() => expect(api.writeSequence).toHaveBeenCalledWith('attached-tmux', ['\x01','c']));
});
it('disables multi-step prefixes before any terminal write', () => {
  render(<MultiplexerShortcuts sessionId="attached-herdr" kind="herdr" />);
  for(const value of ['Ctrl+b\tn','Ctrl+b,n','text:a','text:abc']) {
    fireEvent.change(screen.getByLabelText('Multiplexer prefix key'), { target: { value } });
    expect(screen.getByRole('button', { name: 'New tab' }).hasAttribute('disabled')).toBe(true);
  }
  expect(api.writeSequence).not.toHaveBeenCalled();
});

it('translates the existing shortcut button without replacing it or changing a held write',async()=>{
  const {uiI18n}=await import('./i18n/core');
  let finish!:()=>void;
  vi.mocked(api.writeSequence).mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
  render(<MultiplexerShortcuts sessionId="locale-tmux" kind="tmux"/>);
  const button=screen.getByRole('button',{name:'New window'});
  fireEvent.change(screen.getByLabelText('Multiplexer prefix key'),{target:{value:'Ctrl+a'}});
  fireEvent.click(button);
  await act(async()=>{await uiI18n.changeLanguage('pt-BR');});
  try {
    expect(screen.getByRole('button',{name:'Nova janela'})).toBe(button);
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(api.writeSequence).toHaveBeenCalledExactlyOnceWith('locale-tmux',['\x01','c']);
    await act(async()=>finish());
  } finally {await act(async()=>{await uiI18n.changeLanguage('en');});}
});

it.each(['tmux','herdr'] as const)('keeps %s custom prefix, focused input and action/index bytes across all locales',async(kind)=>{
  render(<MultiplexerShortcuts sessionId="locale-index" kind={kind}/>);
  const input=screen.getByRole('textbox');fireEvent.change(input,{target:{value:'Ctrl+a'}});input.focus();
  const first=screen.getByRole('button',{name:kind==='tmux'?'New window':'New tab'});
  for(const locale of ['pt-BR','es','en']){
    await act(async()=>{await uiI18n.changeLanguage(locale);});
    expect(screen.getByRole('textbox')).toBe(input);expect(document.activeElement).toBe(input);
    expect(input).toHaveProperty('value','Ctrl+a');
    expect(screen.getByRole('button',{name:t(kind==='tmux'?'muxShortcutNewWindow':'muxShortcutNewTab')})).toBe(first);
    const index=kind==='tmux'?0:1;
    fireEvent.click(screen.getByRole('button',{name:t(kind==='tmux'?'muxShortcutWindow':'muxShortcutTab',{index:String(index)})}));
    await waitFor(()=>expect(first.hasAttribute('disabled')).toBe(false));
    expect(api.writeSequence).toHaveBeenLastCalledWith('locale-index',['\x01',String(index)]);
  }
});
it('translates retained save failure while keeping native error strings verbatim',async()=>{
  render(<MultiplexerShortcuts sessionId="raw-error" kind="herdr"/>);
  const save=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('raw storage');});
  fireEvent.click(screen.getByRole('button',{name:'Save prefix key'}));
  for(const locale of ['pt-BR','es']){
    await act(async()=>{await uiI18n.changeLanguage(locale);});
    expect(screen.getByRole('alert').textContent).toBe(t('muxShortcutSaveFailed'));
  }
  save.mockRestore();
  for(const raw of ['Prefix works for this session, but could not be saved.','', 'RAW host {{value}} <tag>']){
    vi.mocked(api.writeSequence).mockRejectedValueOnce(raw);
    fireEvent.click(screen.getByRole('button',{name:t('muxShortcutNewTab')}));
    await waitFor(()=>expect(screen.getByRole('button',{name:t('muxShortcutNewTab')}).hasAttribute('disabled')).toBe(false));
    await act(async()=>{await uiI18n.changeLanguage('pt-BR');});
    expect(screen.queryByRole('alert')?.textContent??'').toBe(raw);
  }
});
