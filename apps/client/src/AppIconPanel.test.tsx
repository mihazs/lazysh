// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import AppIconPanel from './AppIconPanel';
import { applyAccessStatus } from './access';
vi.mock('@tauri-apps/api/core', () => ({invoke: vi.fn(), isTauri: () => true}));
const status = (current = 'default', available = true) => ({available, current, reason: 'Actual UIKit readback'});
let generation = 0;
const unlocked = () => ({initialized: true, supported: true, enabled: false, locked: false, reason: '', generation: String(generation), nonce: 'a'.repeat(64)});
beforeEach(() => { generation += 10; applyAccessStatus(unlocked()); vi.mocked(invoke).mockReset(); });
import {t,uiI18n} from './i18n/core';
afterEach(async()=>{cleanup();await uiI18n.changeLanguage('en');});
it('does not offer changes on unsupported platforms', async () => {
  vi.mocked(invoke).mockResolvedValue(status('default', false)); render(<AppIconPanel />);
  await screen.findByText('Actual UIKit readback');
  expect(screen.getByRole<HTMLButtonElement>('button', {name: 'Apply app icon'}).disabled).toBe(true);
});
it('waits for native completion before reporting the actual icon', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockResolvedValueOnce(status()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<AppIconPanel />); await screen.findByText('Actual UIKit readback');
  fireEvent.change(screen.getByLabelText('Home Screen icon'), {target:{value:'amber'}});
  fireEvent.click(screen.getByRole('button', {name:'Apply app icon'}));
  expect(screen.getByText('Current icon: Default')).toBeTruthy();
  finish(status('amber')); await screen.findByText('Current icon: Amber');
  expect(screen.getByRole('status').childNodes).toHaveLength(1);
  expect(invoke).toHaveBeenLastCalledWith('set_app_icon', {icon:'amber'}, {headers: {'X-Lazysh-Access': 'a'.repeat(64)}});
});
it('refreshes actual state after failure and can restore the primary icon', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(status('amber')).mockRejectedValueOnce('iOS rejected the change').mockResolvedValueOnce(status('amber')).mockResolvedValueOnce(status());
  render(<AppIconPanel />); await screen.findByText('Current icon: Amber');
  fireEvent.change(screen.getByLabelText('Home Screen icon'), {target:{value:'default'}});
  fireEvent.click(screen.getByRole('button', {name:'Apply app icon'}));
  await screen.findByText('iOS rejected the change');
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
  expect(screen.getByText('Current icon: Amber')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Home Screen icon'), {target:{value:'default'}});
  fireEvent.click(screen.getByRole('button', {name:'Apply app icon'}));
  await screen.findByText('Current icon: Default');
});
it('fails closed on malformed status', async () => {
  vi.mocked(invoke).mockResolvedValue({available:true,current:'fake'}); render(<AppIconPanel />);
  await screen.findByRole('alert');
  expect(screen.getByRole<HTMLButtonElement>('button',{name:'Apply app icon'}).disabled).toBe(true);
});

it.each(['success', 'failure'])('drops a stale native %s on the same mounted view across lock and unlock', async outcome => {
  let finish!: (value: unknown) => void;
  let fail!: (error: unknown) => void;
  vi.mocked(invoke).mockResolvedValueOnce(status()).mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  const old = render(<AppIconPanel />);
  await screen.findByText('Current icon: Default');
  fireEvent.change(screen.getByLabelText('Home Screen icon'), {target:{value:'amber'}});
  fireEvent.click(screen.getByRole('button', {name:'Apply app icon'}));
  await act(async () => { generation++; applyAccessStatus({...unlocked(), locked: true, nonce: undefined}); });
  await act(async () => { generation++; applyAccessStatus(unlocked()); });
  // Keep the old mount: unmount cleanup must not be what rejects stale callbacks.
  const requests = vi.mocked(invoke).mock.calls.length;
  await act(async () => { if (outcome === 'success') finish(status('amber')); else fail('Old native icon failure'); });
  expect(screen.getByText('Current icon: Default')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(requests);
  old.unmount();
  vi.mocked(invoke).mockResolvedValue(status('amber'));
  render(<AppIconPanel />);
  await screen.findByText('Current icon: Amber');
  fireEvent.change(screen.getByLabelText('Home Screen icon'), {target:{value:'default'}});
  vi.mocked(invoke).mockResolvedValue(status());
  fireEvent.click(screen.getByRole('button', {name:'Apply app icon'}));
  await screen.findByText('Current icon: Default');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('retranslates a retained owned read failure without starting another native read',async()=>{
  vi.mocked(invoke).mockRejectedValue(new Error('RAW native status failed'));render(<AppIconPanel/>);
  await screen.findByRole('alert');
  await act(async()=>{await uiI18n.changeLanguage('pt-BR');});
  expect(screen.getByRole('alert').textContent).toBe(t('iconsCannotReadTheCurrentAppIconTryRefreshing'));
  expect(invoke).toHaveBeenCalledTimes(1);
});

async function iconLanguages(check:()=>void){
  const{enablePseudoLocale}=await import('./test/pseudoLocale');const calls=[...vi.mocked(invoke).mock.calls];
  for(const locale of ['en','pt-BR','es','en-XA']){
    await act(async()=>{if(locale==='en-XA')await enablePseudoLocale(uiI18n);else await uiI18n.changeLanguage(locale);});check();expect(vi.mocked(invoke).mock.calls).toEqual(calls);
  }
}
it('keeps a held initial read and its native reason without repeating work on language changes',async()=>{
  let finish!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));render(<AppIconPanel/>);
  const select=screen.getByLabelText('Home Screen icon');
  await iconLanguages(()=>{expect(screen.getByLabelText(t('iconsHomeScreenIcon'))).toBe(select);expect(select).toHaveProperty('disabled',true);expect(screen.queryByRole('alert')).toBeNull();});
  await act(async()=>finish({...status('amber'),reason:'Cannot read the current app icon. Try refreshing.'}));
  await iconLanguages(()=>{expect(select).toHaveProperty('value','amber');expect(screen.getByText('Cannot read the current app icon. Try refreshing.')).toBeTruthy();});
});
it.each(['malformed','unknown'] as const)('retains the local %s apply cause and original payload through locale changes',async(outcome)=>{
  let finish!:()=>void;
  vi.mocked(invoke).mockResolvedValueOnce(status()).mockImplementationOnce(()=>new Promise((resolve,reject)=>{finish=()=>outcome==='malformed'?resolve(null):reject(false);})).mockResolvedValueOnce(status());
  render(<AppIconPanel/>);await screen.findByText('Current icon: Default');
  const select=screen.getByLabelText('Home Screen icon');fireEvent.change(select,{target:{value:'amber'}});
  fireEvent.click(screen.getByRole('button',{name:'Apply app icon'}));
  await iconLanguages(()=>{expect(screen.getByLabelText(t('iconsHomeScreenIcon'))).toBe(select);expect(select).toHaveProperty('value','amber');expect(select).toHaveProperty('disabled',true);});
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='set_app_icon')).toEqual([['set_app_icon',{icon:'amber'},{headers:{'X-Lazysh-Access':'a'.repeat(64)}}]]);
  await act(async()=>finish());
  await iconLanguages(()=>{expect(screen.getByRole('alert').textContent).toBe(t(outcome==='malformed'?'iconsCannotReadTheCurrentAppIcon':'appIOSCouldNotChangeTheAppIcon'));expect(select).toHaveProperty('value','default');});
  expect(invoke).toHaveBeenCalledTimes(3);
});
it.each(['',new Error(''),'Cannot read the current app icon. Try refreshing.',new Error('RAW native <{{reason}}>')])('keeps native apply error %j literal with the original Error.message formatting',async(raw)=>{
  vi.mocked(invoke).mockResolvedValueOnce(status()).mockRejectedValueOnce(raw).mockResolvedValueOnce({...status(),reason:''});
  render(<AppIconPanel/>);await screen.findByText('Current icon: Default');
  fireEvent.change(screen.getByLabelText('Home Screen icon'),{target:{value:'amber'}});fireEvent.click(screen.getByRole('button',{name:'Apply app icon'}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(3));
  await iconLanguages(()=>{expect(screen.queryByRole('alert')?.textContent??'').toBe(raw instanceof Error?raw.message:raw);expect(document.querySelector('fieldset > p')?.textContent).toBe('');});
});
