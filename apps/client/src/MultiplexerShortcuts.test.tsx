// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MultiplexerShortcuts from './MultiplexerShortcuts';
import { api } from './bridge';
import {accessSnapshot,applyAccessStatus} from './access';
function access(locked=false){applyAccessStatus({initialized:true,supported:true,enabled:true,locked,reason:'test',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),...(locked?{}:{nonce:'a'.repeat(64)})});}
beforeEach(()=>access());
vi.mock('./bridge', () => ({ api: { writeSequence: vi.fn().mockResolvedValue(undefined) }, native: true }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });
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
