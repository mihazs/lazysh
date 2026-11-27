// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
const install=vi.hoisted(()=>vi.fn());
vi.mock('./bridge',()=>({api:{installCompanion:install}}));
vi.mock('@tauri-apps/api/core',async original=>(await import('./test/nativeCoreMock')).mockNativeCore(original));
import CompanionUpdateConsent,{CompanionConsentSetting} from './CompanionUpdateConsent';
import {applyAccessStatus} from './access';
import {companionUpdatedEvent,compareVersions,readConsent,writeConsent} from './companionUpdate';
import {appVersion} from './version';
import {uiI18n} from './i18n/core';

let generation=2000;
beforeEach(async()=>{
  install.mockReset();vi.mocked(invoke).mockReset();localStorage.clear();await uiI18n.changeLanguage('en');
  applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(++generation),nonce:'a'.repeat(64)});
});
afterEach(()=>cleanup());
const probe=(version:string|null,unix=true)=>vi.mocked(invoke).mockResolvedValue({schemaVersion:1,version,unix});
const versions=()=>vi.mocked(invoke).mock.calls.filter(([command])=>command==='companion_version');
function mount(props:{sessionId?:string;host?:string;companionReplied?:boolean}={},onInstalled=vi.fn()) {
  const view=render(<><CompanionUpdateConsent sessionId={props.sessionId??'s1'} host={props.host??'host-a'} ready companionReplied={props.companionReplied??false} onInstalled={onInstalled}/><CompanionConsentSetting host={props.host??'host-a'}/></>);
  return {onInstalled,view};
}
const prompt=()=>screen.findByRole('heading',{name:'Update the host companion to match this app?'});

describe('comparing versions',()=>{
  it('compares strict X.Y.Z numerically and refuses anything else',()=>{
    expect(compareVersions('1.28.0','1.56.0')).toBeLessThan(0);
    expect(compareVersions('1.9.0','1.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0','1.99.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3','1.2.3')).toBe(0);
    for(const bad of ['1.2','1.2.3-rc1','01.2.3','x']) {expect(compareVersions(bad,'1.2.3')).toBeUndefined();expect(compareVersions('1.2.3',bad)).toBeUndefined();}
  });
  it('remembers a choice per host and survives a browser that has no storage',()=>{
    writeConsent('host-a','always');writeConsent('host-b','never');
    expect([readConsent('host-a'),readConsent('host-b'),readConsent('host-c')]).toEqual(['always','never',undefined]);
    writeConsent('host-a',undefined);expect(readConsent('host-a')).toBeUndefined();
    localStorage.setItem('lazysh.companion-update-consent.v1','{"host-a":"maybe","host-b":7,"host-c":"never"}');
    expect([readConsent('host-a'),readConsent('host-b'),readConsent('host-c')]).toEqual([undefined,undefined,'never']);
    localStorage.setItem('lazysh.companion-update-consent.v1','[1]');expect(readConsent('host-c')).toBeUndefined();
    vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('blocked');});
    expect(readConsent('host-c')).toBeUndefined();vi.restoreAllMocks();
  });
});

describe('a host whose companion cannot update itself',()=>{
  it('asks once, offering Always, Not now and Never, and changes nothing until the user answers',async()=>{
    probe('0.0.1');mount();
    await prompt();
    expect(screen.getByText(`The companion on this host (0.0.1) is older than this app (${appVersion}) and cannot update itself. The host downloads and installs the new version itself, nothing is downloaded on this device, and the previous version is kept.`)).toBeTruthy();
    expect(['Always','Not now','Never'].map(name=>screen.getByRole('button',{name}).textContent)).toEqual(['Always','Not now','Never']);
    expect(install).not.toHaveBeenCalled();expect(versions()).toHaveLength(1);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('companion_version',{sessionId:'s1'},{headers:{'X-Lazysh-Access':expect.any(String)}});
  });
  it('Always installs through the host once, says so, tells open views and remembers the host',async()=>{
    probe('0.0.1');let finish!:(value:unknown)=>void;install.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const heard=vi.fn();window.addEventListener(companionUpdatedEvent,heard);
    const {onInstalled}=mount();await prompt();
    fireEvent.click(screen.getByRole('button',{name:'Always'}));
    expect((await screen.findByText(`Updating the host companion to ${appVersion}…`)).getAttribute('aria-busy')).toBe('true');
    expect(install).toHaveBeenCalledExactlyOnceWith('s1',expect.any(Function));expect(readConsent('host-a')).toBe('always');
    await act(async()=>{finish({});});
    await screen.findByText(`The host companion is now version ${appVersion}.`);
    expect(onInstalled).toHaveBeenCalledOnce();expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual({sessionId:'s1'});
    expect(screen.queryByRole('heading',{name:'Update the host companion to match this app?'})).toBeNull();
    window.removeEventListener(companionUpdatedEvent,heard);
  });
  it('does not ask again once the user said Always, and updates the next time without a question',async()=>{
    writeConsent('host-a','always');probe('0.0.1');install.mockResolvedValue({});
    mount();await screen.findByText(`The host companion is now version ${appVersion}.`);
    expect(install).toHaveBeenCalledOnce();expect(screen.queryByRole('button',{name:'Always'})).toBeNull();
  });
  it('updates the next host the panel is pointed at too, not only the first one',async()=>{
    writeConsent('host-a','always');writeConsent('host-b','always');probe('0.0.1');install.mockResolvedValue({});
    const {view}=mount();await screen.findByText(`The host companion is now version ${appVersion}.`);
    view.rerender(<CompanionUpdateConsent sessionId="s2" host="host-b" ready companionReplied={false} onInstalled={vi.fn()}/>);
    await waitFor(()=>expect(install).toHaveBeenCalledTimes(2));expect(install).toHaveBeenLastCalledWith('s2',expect.any(Function));
  });
  it('Not now hides the question for this connection only and writes nothing',async()=>{
    probe('0.0.1');const first=mount();await prompt();
    fireEvent.click(screen.getByRole('button',{name:'Not now'}));
    expect(screen.queryByRole('heading',{name:'Update the host companion to match this app?'})).toBeNull();
    expect(install).not.toHaveBeenCalled();expect(readConsent('host-a')).toBeUndefined();
    first.view.unmount();mount();await prompt();
  });
  it('Never is remembered for the host, asks nothing again, and can be taken back',async()=>{
    probe('0.0.1');const first=mount();await prompt();
    fireEvent.click(screen.getByRole('button',{name:'Never'}));
    expect(readConsent('host-a')).toBe('never');expect(install).not.toHaveBeenCalled();
    first.view.unmount();mount();
    await waitFor(()=>expect(versions()).toHaveLength(2));
    expect(screen.queryByRole('heading',{name:'Update the host companion to match this app?'})).toBeNull();
    // The choice is shown so that it can be changed; asking again brings the question back.
    fireEvent.change(screen.getByLabelText(/older than the app and cannot update itself/),{target:{value:'ask'}});
    await prompt();expect(readConsent('host-a')).toBeUndefined();
  });
  it('keeps one host\'s answer from deciding for another',async()=>{
    writeConsent('host-a','never');probe('0.0.1');
    mount({sessionId:'s2',host:'host-b'});await prompt();expect(install).not.toHaveBeenCalled();
  });
  it('says what failed, does not try again by itself and leaves the choice alone',async()=>{
    probe('0.0.1');install.mockRejectedValue({kind:'companion_release_unavailable',message:'private'});
    const {onInstalled}=mount();await prompt();fireEvent.click(screen.getByRole('button',{name:'Always'}));
    const alert=await screen.findByRole('alert');
    expect(alert.textContent).toContain(`could not be updated to ${appVersion}`);expect(alert.textContent).not.toContain('private');
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50));});
    expect(install).toHaveBeenCalledOnce();expect(onInstalled).not.toHaveBeenCalled();expect(readConsent('host-a')).toBe('always');
  });
});

describe('everything else is left alone',()=>{
  it.each([
    ['a companion as new as the app',appVersion,true],
    ['a companion newer than the app','999.0.0',true],
    ['a host with no companion',null,true],
    ['a host the app cannot install on','0.0.1',false],
  ] as const)('asks nothing about %s',async(_name,version,unix)=>{
    probe(version,unix);mount();await waitFor(()=>expect(versions()).toHaveLength(1));
    await act(async()=>{await Promise.resolve();});
    expect(screen.queryByRole('heading')).toBeNull();expect(install).not.toHaveBeenCalled();
  });
  it('does not even probe a companion that said it updates itself, or a view that is not ready',async()=>{
    probe('0.0.1');mount({companionReplied:true});
    await act(async()=>{await Promise.resolve();});expect(versions()).toHaveLength(0);
    cleanup();render(<CompanionUpdateConsent sessionId="s1" host="host-a" ready={false} companionReplied={false} onInstalled={vi.fn()}/>);
    await act(async()=>{await Promise.resolve();});expect(versions()).toHaveLength(0);
  });
  it('ignores a malformed or failed probe instead of asking about a version it cannot read',async()=>{
    for(const answer of [{schemaVersion:2,version:'0.0.1',unix:true},{schemaVersion:1,version:5,unix:true},null,'0.0.1'])
      {vi.mocked(invoke).mockReset().mockResolvedValue(answer);const {view}=mount();await waitFor(()=>expect(versions()).toHaveLength(1));await act(async()=>{await Promise.resolve();});expect(screen.queryByRole('heading')).toBeNull();view.unmount();}
    vi.mocked(invoke).mockReset().mockRejectedValue(new Error('offline'));mount();await act(async()=>{await Promise.resolve();});expect(screen.queryByRole('heading')).toBeNull();
  });
  it('speaks the interface language',async()=>{
    probe('0.0.1');await uiI18n.changeLanguage('pt-BR');mount();
    expect(await screen.findByRole('heading',{name:'Atualizar o companion do servidor para combinar com este app?'})).toBeTruthy();
    expect(['Sempre','Agora não','Nunca'].every(name=>screen.getByRole('button',{name}))).toBe(true);
    cleanup();await uiI18n.changeLanguage('es');mount();
    expect(await screen.findByRole('heading',{name:'¿Actualizar el companion del servidor para que coincida con esta app?'})).toBeTruthy();
    expect(['Siempre','Ahora no','Nunca'].every(name=>screen.getByRole('button',{name}))).toBe(true);
  });
});
