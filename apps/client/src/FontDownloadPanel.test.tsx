// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import PreferencesPanel from './PreferencesPanel';
import {canDownloadFont,downloadNotoFont,notoFont} from './fontDownload';
import {selectFont,type getDeviceFonts} from './fonts';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from './access';
import {t,uiI18n} from './i18n/core';
vi.mock('@tauri-apps/api/core',async original=>(await import('./test/nativeCoreMock')).mockNativeCore(original));
vi.mock('./fontDownload',async original=>({...await original<typeof import('./fontDownload')>(),canDownloadFont:vi.fn(),downloadNotoFont:vi.fn()}));
vi.mock('./fonts',async original=>({...await original<typeof import('./fonts')>(),useDeviceFonts:()=>deviceFonts,selectFont:vi.fn()}));
let deviceFonts:ReturnType<typeof getDeviceFonts>;
function authority(locked=false){
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked,reason:'Owned font UI fixture',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),...(locked?{}:{nonce:'b'.repeat(64)})});
  acknowledgeAccessReady(accessSnapshot().epoch);
}
function mount(){const view=render(<PreferencesPanel/>);fireEvent.click(screen.getByText(t('preferencesCategoryAppearance')));fireEvent.click(screen.getByText('Imported fonts',{exact:true}));return view;}
beforeEach(()=>{
  authority();vi.stubGlobal('fetch',vi.fn());
  deviceFonts={fonts:[],selection:{},warnings:[],ready:true};
  vi.mocked(canDownloadFont).mockReturnValue(true);vi.mocked(downloadNotoFont).mockResolvedValue('saved-font');
});
afterEach(async()=>{cleanup();vi.unstubAllGlobals();vi.resetAllMocks();await uiI18n.changeLanguage('en');});
it('offers explicit download without fetching or changing selection on mount',()=>{
  mount();expect(screen.getByRole('button',{name:'Download Noto Sans Mono CJK SC'})).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();expect(downloadNotoFont).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Imported CJK fallback')).toHaveProperty('value','');
});
it.each(['success','failure'])('preserves an existing selected font after download %s without automatic selection',async outcome=>{
  deviceFonts={...deviceFonts,fonts:[{id:'existing',name:'Current local font',size:12}],selection:{cjk:'existing'}};
  if(outcome==='failure')vi.mocked(downloadNotoFont).mockRejectedValue(new Error('RAW network {{reason}} <literal>'));
  mount();fireEvent.click(screen.getByRole('button',{name:'Download Noto Sans Mono CJK SC'}));
  if(outcome==='success')await screen.findByText(t('fontDownloadComplete'));
  else expect((await screen.findByRole('alert')).textContent).toBe('Error: RAW network {{reason}} <literal>');
  expect(screen.getByLabelText('Imported CJK fallback')).toHaveProperty('value','existing');
  expect(selectFont).not.toHaveBeenCalled();expect(downloadNotoFont).toHaveBeenCalledOnce();
});
it('reports capability failure without a dead-end request',()=>{
  vi.mocked(canDownloadFont).mockReturnValue(false);mount();
  expect(screen.getByRole('button',{name:'Download Noto Sans Mono CJK SC'})).toHaveProperty('disabled',true);
  expect(screen.getByText(t('fontDownloadUnavailable'))).toBeTruthy();expect(downloadNotoFont).not.toHaveBeenCalled();
});
it.each(['cancel','unmount','revoke'])('cancels exact original work on %s and suppresses late success',async transition=>{
  let finish!:(id:string)=>void;
  vi.mocked(downloadNotoFont).mockImplementationOnce(()=>new Promise(done=>{finish=done;}));
  const view=mount();fireEvent.click(screen.getByRole('button',{name:'Download Noto Sans Mono CJK SC'}));
  const [signal,current]=vi.mocked(downloadNotoFont).mock.calls[0];expect(current()).toBe(true);
  if(transition==='cancel'){
    fireEvent.click(screen.getByRole('button',{name:'Cancel font download'}));
    expect(screen.getByText(t('fontDownloadStopping'))).toBeTruthy();
    expect(screen.getByRole('button',{name:'Download Noto Sans Mono CJK SC'})).toHaveProperty('disabled',true);
  }else if(transition==='unmount')view.unmount();
  else await act(async()=>{authority(true);authority();});
  expect(signal.aborted).toBe(true);
  if(transition!=='cancel')expect(current()).toBe(false);
  await act(async()=>{finish('late-import');});
  expect(screen.queryByText(t('fontDownloadComplete'))).toBeNull();expect(selectFont).not.toHaveBeenCalled();
  if(transition==='cancel')expect(screen.getByText(t('fontDownloadCancelled'))).toBeTruthy();
});
it('keeps one original download while language changes and translates progress without a retry',async()=>{
  let finish!:(id:string)=>void;
  vi.mocked(downloadNotoFont).mockImplementationOnce(()=>new Promise(done=>{finish=done;}));
  mount();fireEvent.click(screen.getByRole('button',{name:'Download Noto Sans Mono CJK SC'}));
  const [signal,current,progress]=vi.mocked(downloadNotoFont).mock.calls[0];
  fireEvent.click(screen.getByText(t('preferencesCategoryAppearance')));
  expect(signal.aborted).toBe(false);expect(current()).toBe(true);
  fireEvent.click(screen.getByText(t('preferencesCategoryAppearance')));
  await act(async()=>{progress!(1024);});
  for(const locale of ['pt-BR','es','en']){
    await act(async()=>{await uiI18n.changeLanguage(locale);});
    expect(screen.getByRole('button',{name:t('fontDownloadNoto')})).toHaveProperty('disabled',true);
    expect(screen.getByText(t('fontDownloadProgress',{received:new Intl.NumberFormat(locale).format(1024),total:new Intl.NumberFormat(locale).format(notoFont.bytes)}))).toBeTruthy();
    expect(signal.aborted).toBe(false);expect(current()).toBe(true);expect(downloadNotoFont).toHaveBeenCalledOnce();
  }
  await act(async()=>{finish('saved');});await screen.findByText(t('fontDownloadComplete'));
});
