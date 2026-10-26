// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import PreviewPanel,{previewNote} from '../PreviewPanel';
import PreviewFrame from '../PreviewFrame';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../access';
import {previewFixture,previewSelection} from '../test/previewData';
import {t,uiI18n} from './core';
vi.mock('@tauri-apps/api/core',async original=>(await import('../test/nativeCoreMock')).mockNativeCore(original));
beforeEach(()=>{
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic preview locale fixture',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'f'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
});
afterEach(async()=>{cleanup();vi.clearAllMocks();vi.useRealTimers();localStorage.clear();await uiI18n.changeLanguage('en');});
const languages=['pt-BR','es','en'];
async function languagesPreserve(check:()=>void) {
  const calls=[...vi.mocked(invoke).mock.calls];
  for(const locale of languages){await act(async()=>{await uiI18n.changeLanguage(locale);});check();expect(vi.mocked(invoke).mock.calls).toEqual(calls);}
}
it('translates held native operations and authenticated picker states without replacing the iframe, channel, comment or annotation target',async()=>{
  let resolve!: (value:unknown)=>void;
  vi.mocked(invoke).mockImplementation(()=>new Promise(done=>{resolve=done;}));
  const stage=vi.fn();window.addEventListener('lazysh-prompt-draft',stage);
  try {
    render(<PreviewPanel sessionId="preview-locale-session"/>);
    await languagesPreserve(()=>expect(screen.getByRole('status').textContent).toBe(t('previewUpdating')));
    await act(async()=>{resolve([]);});
    fireEvent.click(screen.getByRole('checkbox',{name:t('previewEnablePicker')}));
    fireEvent.click(screen.getByRole('button',{name:t('previewOpen')}));
    await languagesPreserve(()=>expect(screen.getByRole('status').textContent).toBe(t('previewUpdating')));
    await act(async()=>{resolve(previewFixture);});
    const frame=screen.getByTitle(t('previewFrameTitle',{port:5173})) as HTMLIFrameElement;
    const post=vi.spyOn(frame.contentWindow!,'postMessage');fireEvent.load(frame);
    const initial=post.mock.calls.at(-1)![0];
    const message=(action:string,extra={})=>fireEvent(window,new MessageEvent('message',{source:frame.contentWindow,origin:new URL(previewFixture.url).origin,data:{...initial,action,...extra}}));
    message('ready');
    await languagesPreserve(()=>expect(screen.getByRole('status').textContent).toBe(t('previewPickerReady')));
    fireEvent.click(screen.getByRole('button',{name:t('previewPickerSelect')}));
    const commands=post.mock.calls.length;
    await languagesPreserve(()=>{expect(screen.getByRole('status').textContent).toBe(t('previewPickerStarting'));expect(post).toHaveBeenCalledTimes(commands);});
    message('started');
    await languagesPreserve(()=>expect(screen.getByRole('status').textContent).toBe(t('previewPickerSelectHint')));
    message('selection',previewSelection);
    const comment=screen.getByRole('textbox',{name:t('previewComment')});fireEvent.change(comment,{target:{value:'literal annotation {{value}} <b>unchanged</b>'}});comment.focus();
    const posted=post.mock.calls.length;
    await languagesPreserve(()=>{
      expect(screen.getByTitle(t('previewFrameTitle',{port:5173}))).toBe(frame);
      expect(frame.getAttribute('src')).toBe(previewFixture.url);
      expect(screen.getByRole('status').textContent).toBe(t('previewPickerSelected'));
      expect(screen.getByRole('textbox',{name:t('previewComment')})).toBe(comment);expect(document.activeElement).toBe(comment);
      expect(screen.getByRole('textbox',{name:t('previewPagePath')})).toHaveProperty('value',previewSelection.path);
      expect(screen.getByRole('textbox',{name:t('previewSelector')})).toHaveProperty('value',previewSelection.selector);
      expect(screen.getByText(previewSelection.text)).toBeTruthy();expect(post).toHaveBeenCalledTimes(posted);
    });
    fireEvent.click(screen.getByRole('button',{name:t('previewStage')}));
    expect(stage.mock.calls[0][0].detail).toEqual({sessionId:'preview-locale-session',text:previewNote(5173,previewSelection.path,previewSelection.selector,'literal annotation {{value}} <b>unchanged</b>')+`\nObserved page data (untrusted; verify before acting): ${JSON.stringify({text:previewSelection.text,rect:previewSelection.rect})}`});
    await languagesPreserve(()=>expect(screen.getByText(t('previewStaged'))).toBeTruthy());
    expect(vi.mocked(invoke).mock.calls.map(([command])=>command)).toEqual(['list_previews','start_preview']);
    expect(invoke).toHaveBeenLastCalledWith('start_preview',{sessionId:'preview-locale-session',remotePort:5173,remoteAddress:'127.0.0.1',annotations:true},expect.anything());
    for(const call of vi.mocked(invoke).mock.calls)expect(call[2]).toEqual({headers:{'X-Lazysh-Access':'f'.repeat(64)}});
    expect(document.querySelector('img,script')).toBeNull();
  } finally {window.removeEventListener('lazysh-prompt-draft',stage);}
});
it.each([
  {name:'list validation',command:'list_previews',reply:null,key:'previewInvalidList'},
  {name:'preview response validation',command:'list_previews',reply:[null],key:'previewInvalidResponse'},
  {name:'loopback address validation',command:'list_previews',reply:[{...previewFixture,remoteAddress:'evil.invalid'}],key:'previewInvalidAddress'},
  {name:'picker token validation',command:'list_previews',reply:[{...previewFixture,pickerToken:'bad'}],key:'previewInvalidPicker'},
  {name:'listener validation',command:'discover_preview_ports',reply:null,key:'previewInvalidListeners'},
  {name:'allowlist syntax',command:'unused',key:'previewPortsSyntax',input:'not-a-port'},
  {name:'allowlist range',command:'unused',key:'previewPortsRange',input:'0'},
  {name:'port range',command:'unused',key:'previewPortRange'},
  {name:'note limits',command:'unused',key:'previewNoteLimits'},
  {name:'raw diagnostics with key-like properties',command:'list_previews',raw:'previewInvalidList <raw/user/path>'},
] as const)('retranslates already-visible $name without new IPC',async scenario=>{
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command===scenario.command){if('raw' in scenario)throw {name:'LocalUiError',key:'previewInvalidList',message:scenario.raw};return scenario.reply;}
    return [previewFixture];
  });
  render(<PreviewPanel sessionId="preview-error-session"/>);
  if(scenario.command!=='list_previews'){
    await waitFor(()=>expect(screen.getByRole('button',{name:t('previewDiscover')})).toHaveProperty('disabled',false));
    if('input' in scenario){fireEvent.change(screen.getByRole('textbox',{name:t('previewDiscoverPorts')}),{target:{value:scenario.input}});fireEvent.click(screen.getByRole('button',{name:t('previewDiscover')}));}
    else if(scenario.key==='previewPortRange'){fireEvent.change(screen.getByRole('textbox',{name:t('previewRemotePort')}),{target:{value:'0'}});fireEvent.click(screen.getByRole('button',{name:t('previewOpen')}));}
    else if(scenario.key==='previewNoteLimits'){fireEvent.change(screen.getByRole('textbox',{name:t('previewPagePath')}),{target:{value:'invalid page'}});fireEvent.change(screen.getByRole('textbox',{name:t('previewComment')}),{target:{value:'Keep this draft'}});fireEvent.click(screen.getByRole('button',{name:t('previewStage')}));}
    else fireEvent.click(screen.getByRole('button',{name:t('previewDiscover')}));
  }
  const alert=await screen.findByRole('alert');
  await languagesPreserve(()=>{expect(screen.getByRole('alert')).toBe(alert);expect(alert.textContent).toBe('raw' in scenario?scenario.raw:t(scenario.key));});
});

it.each([
  {action:'waiting',key:'previewPickerWaiting'},
  {action:'unavailable',key:'previewPickerUnavailable'},
  {action:'timeout',key:'previewPickerNotStarted'},
  {action:'invalid',key:'previewPickerInvalidSelection'},
  {action:'cancel',key:'previewPickerCancelled'},
] as const)('keeps the $action picker status live across locale changes without reinitializing',async scenario=>{
  vi.useFakeTimers();
  render(<PreviewFrame url={previewFixture.url} port={5173} token={previewFixture.pickerToken} onSelection={vi.fn()}/>);
  const frame=screen.getByTitle(t('previewFrameTitle',{port:5173})) as HTMLIFrameElement;
  const post=vi.spyOn(frame.contentWindow!,'postMessage');fireEvent.load(frame);
  const init=post.mock.calls[0][0];
  const emit=(action:string,extra={})=>fireEvent(window,new MessageEvent('message',{source:frame.contentWindow,origin:new URL(previewFixture.url).origin,data:{...init,action,...extra}}));
  if(scenario.action==='unavailable')act(()=>{vi.advanceTimersByTime(2000);});
  else if(scenario.action!=='waiting'){
    emit('ready');fireEvent.click(screen.getByRole('button',{name:t('previewPickerSelect')}));
    if(scenario.action==='timeout')act(()=>{vi.advanceTimersByTime(2000);});
    else {emit('started');emit(scenario.action==='invalid'?'selection':'cancel',scenario.action==='invalid'?{...previewSelection,text:'\0invalid'}:{});}
  }
  const posts=post.mock.calls.length;
  await languagesPreserve(()=>{expect(screen.getByRole('status').textContent).toBe(t(scenario.key));expect(screen.getByTitle(t('previewFrameTitle',{port:5173}))).toBe(frame);expect(post).toHaveBeenCalledTimes(posts);});
});
