// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import AboutPanel from '../AboutPanel';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../access';
import {aboutLegalFiles,aboutLocales} from '../test/aboutData';
import {t,uiI18n} from './core';
vi.mock('@tauri-apps/api/core',async original=>({...await (await import('../test/nativeCoreMock')).mockNativeCore(original),isTauri:()=>true}));
const revision='0123456789abcdef'.repeat(2)+'01234567';
const bodies=aboutLegalFiles.map(path=>readFileSync(new URL('../../../../'+path,import.meta.url),'utf8'));
beforeEach(()=>{
  vi.stubGlobal('__LAZYSH_SOURCE_REVISION__',revision);vi.stubGlobal('__LAZYSH_SOURCE_DIRTY__',true);
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic About access',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'f'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
});
afterEach(async()=>{cleanup();vi.clearAllMocks();vi.unstubAllGlobals();await uiI18n.changeLanguage('en');});
it.each(aboutLocales)('$locale translates interface text while legal bytes, identifiers and source metadata remain unchanged',async labels=>{
  await uiI18n.changeLanguage(labels.locale);const view=render(<AboutPanel/>);
  expect(screen.getByRole('region',{name:labels.region})).toBeTruthy();
  expect(screen.getByText(labels.license)).toBeTruthy();
  expect(screen.getByText(t('aboutLicense',{component:'Eternal Terminal adapter'}))).toBeTruthy();
  expect(screen.getByText(t('aboutDescription',{version:'0.1.0'}))).toBeTruthy();
  expect(view.container.querySelector('code')?.textContent).toBe(revision);
  expect(screen.getByText(new RegExp(t('aboutDirty')))).toBeTruthy();
  expect([...view.container.querySelectorAll('pre')].map(node=>node.textContent)).toEqual(bodies);
  fireEvent.click(screen.getByRole('button',{name:labels.source}));
  expect(invoke).toHaveBeenLastCalledWith('open_web_url',{url:`https://github.com/mihazs/lazysh/tree/${revision}`},{headers:{'X-Lazysh-Access':'f'.repeat(64)}});
  const licenseNode=view.container.querySelector('pre');const sourceButton=screen.getByRole('button',{name:labels.source});sourceButton.focus();
  await act(async()=>{await uiI18n.changeLanguage(labels.locale==='en'?'es':'en');});
  expect(screen.getByRole('button',{name:t('aboutSource')})).toBe(sourceButton);
  expect(document.activeElement).toBe(sourceButton);expect(view.container.querySelector('pre')).toBe(licenseNode);
  expect([...view.container.querySelectorAll('pre')].map(node=>node.textContent)).toEqual(bodies);
  expect(vi.mocked(invoke).mock.calls).toHaveLength(1);
});
it.each([{revision:'',dirty:true},{revision,dirty:false}])('keeps source-archive and clean-build metadata behavior for $revision',async build=>{
  vi.stubGlobal('__LAZYSH_SOURCE_REVISION__',build.revision);vi.stubGlobal('__LAZYSH_SOURCE_DIRTY__',build.dirty);
  await uiI18n.changeLanguage('es');const view=render(<AboutPanel/>);
  expect(view.container.querySelector('code')?.textContent??'').toBe(build.revision);
  expect(screen.queryByText(new RegExp(t('aboutDirty')))).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:t('aboutMoshSource')}));
  expect(invoke).toHaveBeenLastCalledWith('open_web_url',{url:'https://github.com/mihazs/lazysh'+(build.revision?`/tree/${build.revision}`:'')},expect.anything());
});
it('keeps raw native errors verbatim across language changes and never bypasses revoked source-opening access',async()=>{
  await uiI18n.changeLanguage('pt-BR');const raw='Native source error <literal> {{untouched}} /private/path';
  vi.mocked(invoke).mockRejectedValueOnce(new Error(raw));render(<AboutPanel/>);
  fireEvent.click(screen.getByRole('button',{name:t('aboutSource')}));
  expect((await screen.findByRole('alert')).textContent).toBe(raw);
  await act(async()=>{await uiI18n.changeLanguage('es');});expect(screen.getByRole('alert').textContent).toBe(raw);
  applyAccessStatus({...accessSnapshot().status!,locked:true,nonce:undefined});
  fireEvent.click(screen.getByRole('button',{name:t('aboutMoshSource')}));
  await act(async()=>{});expect(vi.mocked(invoke).mock.calls).toHaveLength(1);
});
