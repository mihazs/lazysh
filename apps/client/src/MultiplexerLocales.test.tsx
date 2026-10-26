// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {MuxPanel} from './MultiplexerPanel';
import HerdrPanel from './HerdrPanel';
import ZellijPanel from './ZellijPanel';
import {uiI18n} from './i18n/core';
import {applyAccessStatus,captureAccess} from './access';
import {muxFixture,herdrFixture,muxLocales,remoteMuxName,remoteMuxDirectory,remoteMuxError} from './test/multiplexerFixture';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:()=>true}));
let generation=0;
beforeEach(()=>applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'',generation:String(++generation),nonce:'a'.repeat(64)}));
afterEach(async()=>{cleanup();vi.resetAllMocks();localStorage.clear();await uiI18n.changeLanguage('en');});
it.each(muxLocales)('$locale labels preserve tmux identities, literal edits and raw remote errors',async labels=>{
  await uiI18n.changeLanguage(labels.locale);
  vi.mocked(invoke).mockImplementation(async command=>{if(command==='multiplexer_tree')return muxFixture;if(command==='tmux_action')return;throw remoteMuxError;});
  render(<MuxPanel sessionId="literal-control" onAttach={vi.fn()}/>);
  await screen.findByRole('region',{name:labels.region});
  fireEvent.click(await screen.findByRole('button',{name:labels.rename}));
  const input=screen.getByRole('textbox',{name:labels.name});
  expect(input).toHaveProperty('value',remoteMuxName);
  fireEvent.change(input,{target:{value:' literal {{name}} <i>new</i> '}});
  fireEvent.click(screen.getByRole('button',{name:labels.save}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('tmux_action',{sessionId:'literal-control',action:{type:'renameSession',target:'$41',name:' literal {{name}} <i>new</i> '}},expect.anything()));
  vi.mocked(invoke).mockRejectedValueOnce(remoteMuxError);
  fireEvent.click(await screen.findByRole('button',{name:labels.refresh}));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',remoteMuxError);
});
it.each(muxLocales)('$locale Herdr labels leave workspace, pane status and directory payloads literal',async labels=>{
  await uiI18n.changeLanguage(labels.locale);vi.mocked(invoke).mockResolvedValue(herdrFixture);
  render(<HerdrPanel sessionId="literal-control" name={remoteMuxName} projectDirectory={remoteMuxDirectory}/>);
  expect(await screen.findByRole('region',{name:labels.herdrRegion})).toBeTruthy();
  await screen.findByText(/w7:p9 · unknown/);
  fireEvent.click(screen.getByRole('button',{name:labels.newHerdr}));
  fireEvent.change(screen.getByRole('textbox',{name:labels.herdrLabel}),{target:{value:remoteMuxName}});
  fireEvent.click(screen.getByRole('button',{name:labels.herdrSave}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('herdr_action',{sessionId:'literal-control',name:remoteMuxName,action:{type:'createWorkspace',label:remoteMuxName,directory:remoteMuxDirectory}},expect.anything()));
});
it.each([
  {locale:'en',counts:['0 windows','1 window','2 windows'],index:'1,234,567'},
  {locale:'pt-BR',counts:['0 janelas','1 janela','2 janelas'],index:'1.234.567'},
  {locale:'es',counts:['0 ventanas','1 ventana','2 ventanas'],index:'1.234.567'},
])('$locale formats display counts and indexes without formatting their native payloads',async labels=>{
  await uiI18n.changeLanguage(labels.locale);
  const sessions=[0,1,2].map(count=>({id:`$${count}`,name:`session-${count}`,windows:Array.from({length:count},(_,index)=>({id:`@${count}-${index}`,index:count===1?1234567:index,name:'literal window',active:false,panes:[]}))}));
  vi.mocked(invoke).mockResolvedValue({...muxFixture,sessions});
  const view=render(<MuxPanel sessionId="numbers-control" onAttach={vi.fn()}/>);
  for(const [index,count] of labels.counts.entries())expect(await screen.findByText(`session-${index} · ${count}`,{selector:'summary'})).toBeTruthy();
  expect(screen.getByText(`${labels.index}: literal window`,{selector:'summary'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:new RegExp(labels.index.replaceAll('.','\\.').replaceAll(',','\\,'))}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('tmux_action',{sessionId:'numbers-control',action:{type:'selectWindow',target:'@1-0'}},expect.anything()));
  view.unmount();
  vi.mocked(invoke).mockResolvedValue({...herdrFixture,tabs:[{...herdrFixture.tabs[0],number:1234567}]});
  render(<HerdrPanel sessionId="numbers-control" name={remoteMuxName}/>);
  expect(await screen.findByText(new RegExp(`^${labels.index.replaceAll('.','\\.').replaceAll(',','\\,')}: literal tab`),{selector:'summary'})).toBeTruthy();
});
it('changes language during a held Zellij operation without replacing the draft, focus or request',async()=>{
  let finish!:()=>void;vi.mocked(invoke).mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
  render(<ZellijPanel sessionId="literal-control" name={remoteMuxName} projectDirectory={remoteMuxDirectory}/>);
  const title=screen.getByRole('textbox',{name:'New tab name'});fireEvent.change(title,{target:{value:remoteMuxName}});
  fireEvent.click(screen.getByRole('button',{name:'Create Zellij tab'}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(1));
  for(const labels of muxLocales){
    await act(()=>uiI18n.changeLanguage(labels.locale));
    expect(screen.getByRole('region',{name:labels.zellijRegion})).toBeTruthy();
    expect(screen.getByRole('textbox',{name:labels.tab})).toBe(title);
    expect(title).toHaveProperty('value',remoteMuxName);
  }
  await act(async()=>{finish();});
  for(const labels of muxLocales){await act(()=>uiI18n.changeLanguage(labels.locale));expect(screen.getByRole('status')).toHaveProperty('textContent',labels.sent);}
  expect(invoke).toHaveBeenCalledExactlyOnceWith('zellij_action',{sessionId:'literal-control',name:remoteMuxName,action:{type:'newTab',name:remoteMuxName,directory:remoteMuxDirectory}},expect.anything());
});
it('keeps a requested named-server picker on its original lease across language changes and lock',async()=>{
  const original=captureAccess(),attach=vi.fn();vi.mocked(invoke).mockResolvedValue(muxFixture);
  render(<MuxPanel sessionId="literal-control" requested={{sessionId:'literal-control',lease:original,mux:{kind:'tmux',tmuxServer:"世界 '$(literal);"}}} onAttach={attach}/>);
  await screen.findByRole('button',{name:`Attach ${remoteMuxName}`});
  for(const labels of muxLocales){
    await act(()=>uiI18n.changeLanguage(labels.locale));
    expect(screen.getByRole('textbox',{name:labels.server})).toHaveProperty('value',"世界 '$(literal);");
    expect(screen.queryByRole('button',{name:labels.browse})).toBeNull();
  }
  await act(async()=>{applyAccessStatus({initialized:true,supported:true,enabled:true,locked:true,reason:'',generation:String(++generation)});});
  fireEvent.click(screen.getByRole('button',{name:`Adjuntar ${remoteMuxName}`}));
  expect(attach).not.toHaveBeenCalled();expect(invoke).toHaveBeenCalledTimes(1);
});
