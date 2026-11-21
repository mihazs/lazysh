// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
const install=vi.hoisted(()=>vi.fn());
const remove=vi.hoisted(()=>vi.fn());
vi.mock('./bridge',()=>({api:{installManagedHerdr:install,removeManagedHerdr:remove}}));
import ManagedHerdrPanel,{parseManagedHerdrInstall,parseManagedHerdrRemoval} from './ManagedHerdrPanel';
import {applyAccessStatus} from './access';
import {uiI18n} from './i18n/core';
const installed={schemaVersion:1,status:'installed',version:'1.70.0',path:'/home/owned/.local/share/lazysh/herdr/lazysh-herdr',cleanup:'complete'};
const removed={schemaVersion:1,status:'removed',path:installed.path};
let generation=0;
beforeEach(async()=>{install.mockReset();remove.mockReset();await uiI18n.changeLanguage('en');applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(++generation),nonce:'a'.repeat(64)});});
afterEach(()=>cleanup());
const pending=(mock:typeof install)=>{
  const requests:{finish:(value:unknown)=>void;fail:(error:unknown)=>void}[]=[];
  mock.mockImplementation(()=>new Promise((finish,fail)=>requests.push({finish,fail})));
  return requests;
};

it('accepts only complete results with an absolute host path',()=>{
  expect(parseManagedHerdrInstall(installed)).toMatchObject({status:'installed',version:'1.70.0',path:installed.path});
  expect(parseManagedHerdrInstall({...installed,status:'reused'}).status).toBe('reused');
  expect(parseManagedHerdrInstall({...installed,status:'uncertain',reason:'commitResponseLost',cleanup:'residue'})).toMatchObject({status:'uncertain',residue:true});
  expect(parseManagedHerdrRemoval(removed)).toEqual({status:'removed',path:installed.path});
  expect(parseManagedHerdrRemoval({...removed,status:'absent'}).status).toBe('absent');
  for(const value of [null,'removed',{...installed,path:'relative/lazysh-herdr'},{...installed,path:'C:\\lazysh-herdr'},{...installed,path:'/owned\nprivate'},{...installed,status:'complete'},{...installed,extra:true}])
    expect(()=>parseManagedHerdrInstall(value),JSON.stringify(value)).toThrow('Invalid managed Herdr response.');
  for(const value of [null,{...removed,status:'installed'},{...removed,path:'relative'},{...removed,schemaVersion:2},{...removed,extra:true},{schemaVersion:1,status:'removed'}])
    expect(()=>parseManagedHerdrRemoval(value),JSON.stringify(value)).toThrow('Invalid managed Herdr response.');
});
it('does nothing until asked, then installs once for the connected session and reports the release and path',async()=>{
  const requests=pending(install);
  render(<ManagedHerdrPanel sessionId="ssh-owned"/>);
  expect(install).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();
  const button=screen.getByRole('button',{name:'Install managed Herdr'});
  fireEvent.click(button);fireEvent.click(button);
  expect(install).toHaveBeenCalledTimes(1);expect(install.mock.calls[0][0]).toBe('ssh-owned');
  expect(screen.getAllByRole('button').every(item=>(item as HTMLButtonElement).disabled)).toBe(true);
  await act(async()=>{requests[0].finish(installed);});
  expect(screen.getByText('Installed the managed Herdr from release 1.70.0.')).toBeTruthy();
  expect(screen.getByText(installed.path)).toBeTruthy();
  expect((screen.getByRole('button',{name:'Install managed Herdr'}) as HTMLButtonElement).disabled).toBe(false);
  expect(remove).not.toHaveBeenCalled();
});
it('removes through its own command and says what it left alone, or that nothing was installed',async()=>{
  remove.mockResolvedValueOnce(removed).mockResolvedValueOnce({...removed,status:'absent'});
  render(<ManagedHerdrPanel sessionId="ssh-owned"/>);
  fireEvent.click(screen.getByRole('button',{name:'Remove managed Herdr'}));await act(async()=>{});
  expect(remove).toHaveBeenLastCalledWith('ssh-owned');
  expect(screen.getByText('Removed the managed Herdr. The system Herdr, running servers and session data were not touched.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Remove managed Herdr'}));await act(async()=>{});
  expect(screen.getByText('No managed Herdr is installed on this host.')).toBeTruthy();
  expect(install).not.toHaveBeenCalled();
});
it.each([
  ['companion_release_unavailable','The current release has no verified managed Herdr for this host yet.'],
  ['herdr_unsafe_location','The managed Herdr location on this host is not safe to use, so nothing was changed.'],
  ['herdr_stale_plan','The host changed while the install was being planned, so nothing was installed. Try again.'],
  ['herdr_architecture_mismatch','The managed Herdr is not available for this host\'s system or CPU.'],
  ['herdr_staged_mismatch','The file did not pass its checks on the host, so nothing was installed.'],
  ['companion_install_busy','An installation or removal is already running on this connection or host.'],
])('shows a fixed message for %s and never the remote text',async(kind,text)=>{
  install.mockRejectedValue({kind,message:'Private remote text',phase:'installing'});
  render(<ManagedHerdrPanel sessionId="ssh-owned"/>);
  fireEvent.click(screen.getByRole('button',{name:'Install managed Herdr'}));await act(async()=>{});
  expect(screen.getByRole('alert').textContent).toBe(text);
  expect(screen.queryByText('Private remote text')).toBeNull();
});
it('keeps an unconfirmed result as an alert with its residue and retires a result that arrives for another session',async()=>{
  const requests=pending(install);
  const view=render(<ManagedHerdrPanel sessionId="first"/>);
  fireEvent.click(screen.getByRole('button',{name:'Install managed Herdr'}));
  view.rerender(<ManagedHerdrPanel sessionId="second"/>);
  await act(async()=>{requests[0].finish(installed);});
  expect(screen.queryByText('Installed the managed Herdr from release 1.70.0.')).toBeNull();
  expect((screen.getByRole('button',{name:'Install managed Herdr'}) as HTMLButtonElement).disabled).toBe(false);
  install.mockResolvedValue({...installed,status:'uncertain',reason:'commitResponseLost',cleanup:'residue'});
  fireEvent.click(screen.getByRole('button',{name:'Install managed Herdr'}));await act(async()=>{});
  expect(screen.getByRole('alert').textContent).toContain('The result could not be confirmed. Retry to check it again.');
  expect(screen.getByText('Some temporary installation files remain on the host.')).toBeTruthy();
});
it('is catalogued in Brazilian Portuguese and Spanish',async()=>{
  install.mockResolvedValue(installed);
  render(<ManagedHerdrPanel sessionId="ssh-owned"/>);
  await act(async()=>{await uiI18n.changeLanguage('pt-BR');});
  fireEvent.click(screen.getByRole('button',{name:'Instalar o Herdr gerenciado'}));await act(async()=>{});
  expect(screen.getByText('Herdr gerenciado da versão 1.70.0 instalado.')).toBeTruthy();
  await act(async()=>{await uiI18n.changeLanguage('es');});
  expect(screen.getByRole('button',{name:'Quitar Herdr gestionado'})).toBeTruthy();
});
