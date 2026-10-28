// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import RepositoryPanel, {diffLines} from './RepositoryPanel';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from './access';
import {fileReviewReply,fileReviewRoot,fileReviewSession} from './test/fileReviewData';
vi.mock('@tauri-apps/api/core',async original=>(await import('./test/nativeCoreMock')).mockNativeCore(original));
const patch='@@ -2,2 +2,3 @@\n context\n-old\n+new\n+added\n@@ -20,2 +21 @@\n-deleted\n tail';
function authority(locked=false) {
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked,reason:'Owned diff-note fixture',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),...(locked?{}:{nonce:'a'.repeat(64)})});
  acknowledgeAccessReady(accessSnapshot().epoch);
}
beforeEach(()=>{
  sessionStorage.clear();authority();
  vi.mocked(invoke).mockImplementation(async command=>command==='repository_status'
    ? {path:fileReviewRoot,changes:[{path:'new.ts',originalPath:'old.ts',index:'R',worktree:'M'}]}
    : command==='repository_diff'?{patch,binary:false}:fileReviewReply(command));
});
afterEach(()=>{cleanup();vi.resetAllMocks();sessionStorage.clear();});
async function openDiff(staged=false) {
  const view=render(<RepositoryPanel sessionId={fileReviewSession}/>);
  fireEvent.click(screen.getByRole('button',{name:'Open repository'}));
  fireEvent.click(await screen.findByRole('button',{name:staged?'Staged diff':'Unstaged diff'}));
  await screen.findByText('old',{exact:true});
  return view;
}
it('adds editable notes for real before/after diff lines without reading files or sending input',async()=>{
  const events=vi.fn();window.addEventListener('lazysh-prompt-draft',events);
  try {
    await openDiff();
    const calls=vi.mocked(invoke).mock.calls.length;
    fireEvent.click(screen.getByRole('button',{name:'Comment on Before line 3'}));
    const note=screen.getByRole('textbox',{name:/new.ts:3/});
    fireEvent.change(note,{target:{value:'Please explain the removed line.'}});
    expect(events).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(calls);
    fireEvent.click(screen.getByRole('button',{name:'Use in next prompt'}));
    expect(events.mock.calls[0][0].detail).toEqual({sessionId:fileReviewSession,text:`${fileReviewRoot}/new.ts:3 (observed unstaged diff, before; rename old.ts -> new.ts)\nPlease explain the removed line.`});
    expect(screen.getByText('Comments refer to the displayed snapshot. Host files may have changed; review paths and lines before sending.')).toBeTruthy();
    expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='write_stdin')).toBe(false);
    expect(screen.queryByRole('button',{name:'Comment on Before line 4'})).toBeNull();
    expect(screen.getByRole('button',{name:'Comment on After line 4'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'Comment on Before line 20'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Comment on After line 20'})).toBeNull();
  }finally{window.removeEventListener('lazysh-prompt-draft',events);}
});
it('keeps staged/unstaged and before/after identities distinct and retains drafts across review changes',async()=>{
  await openDiff(true);
  for(const side of ['Before','After'])fireEvent.click(screen.getByRole('button',{name:`Comment on ${side} line 3`}));
  fireEvent.click(screen.getByRole('button',{name:'Comment on Before line 3'}));
  expect(screen.getAllByRole('textbox',{name:/new.ts:3/})).toHaveLength(2);
  const before=screen.getByRole('textbox',{name:/Staged diff, Before/});
  fireEvent.change(before,{target:{value:'Keep the staged before reference.'}});
  fireEvent.change(screen.getByLabelText('Repository directory'),{target:{value:'/not-opened'}});
  fireEvent.click(screen.getByRole('button',{name:'Unstaged diff'}));
  await screen.findByText('old',{exact:true});
  fireEvent.click(screen.getByRole('button',{name:'Comment on Before line 3'}));
  expect(screen.getAllByRole('textbox',{name:/new.ts:3/})).toHaveLength(3);
  expect(before).toHaveProperty('value','Keep the staged before reference.');
  expect(before.isConnected).toBe(true);
  expect(screen.queryByRole('textbox',{name:/not-opened/})).toBeNull();
});
it.each(['session','unmount','revoke'])('suppresses late diff publication after %s changes',async transition=>{
  let complete!: (value:unknown)=>void;
  vi.mocked(invoke).mockImplementation(command=>command==='repository_diff'?new Promise(done=>{complete=done;}):Promise.resolve(command==='repository_status'
    ?{path:fileReviewRoot,changes:[{path:'new.ts',originalPath:null,index:'M',worktree:'M'}]}:fileReviewReply(command)));
  const view=render(<RepositoryPanel sessionId={fileReviewSession}/>);
  fireEvent.click(screen.getByRole('button',{name:'Open repository'}));
  fireEvent.click(await screen.findByRole('button',{name:'Unstaged diff'}));
  if(transition==='session')view.rerender(<RepositoryPanel sessionId="different-session"/>);
  else if(transition==='unmount')view.unmount();
  else await act(async()=>{authority(true);authority();});
  await act(async()=>{complete({patch,binary:false});});
  expect(screen.queryByRole('button',{name:'Comment on Before line 3'})).toBeNull();
  expect(screen.queryByText('old',{exact:true})).toBeNull();
});
it('never stages or copies old-view notes after original access is revoked and unlocked',async()=>{
  const events=vi.fn();window.addEventListener('lazysh-prompt-draft',events);
  const clipboard=vi.fn();Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:clipboard}});
  try{
    await openDiff();fireEvent.click(screen.getByRole('button',{name:'Comment on Before line 3'}));
    fireEvent.change(screen.getByRole('textbox',{name:/new.ts:3/}),{target:{value:'Do not replay this note.'}});
    await act(async()=>{authority(true);authority();});
    fireEvent.click(screen.getByRole('button',{name:'Use in next prompt'}));
    fireEvent.click(screen.getByRole('button',{name:'Copy comments'}));
    expect(events).not.toHaveBeenCalled();expect(clipboard).not.toHaveBeenCalled();
  }finally{window.removeEventListener('lazysh-prompt-draft',events);}
});
it.each(['edit','stage','session','unmount','revoke'])('discards old clipboard completion status after %s',async transition=>{
  let complete!:()=>void;
  const clipboard=vi.fn(()=>new Promise<void>(done=>{complete=done;}));
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:clipboard}});
  const view=await openDiff();fireEvent.click(screen.getByRole('button',{name:'Comment on After line 4'}));
  const field=screen.getByRole('textbox',{name:/new.ts:4/});
  fireEvent.change(field,{target:{value:'Original note'}});
  fireEvent.click(screen.getByRole('button',{name:'Copy comments'}));
  if(transition==='edit')fireEvent.change(field,{target:{value:'Changed note'}});
  else if(transition==='stage')fireEvent.click(screen.getByRole('button',{name:'Use in next prompt'}));
  else if(transition==='session')view.rerender(<RepositoryPanel sessionId="different-session"/>);
  else if(transition==='unmount')view.unmount();
  else await act(async()=>{authority(true);authority();});
  await act(async()=>{complete();});
  expect(screen.queryByText('Comments copied.')).toBeNull();
  if(transition==='stage')expect(screen.getByText('Comments staged for your next prompt. Review before sending.')).toBeTruthy();
  if(transition==='edit')expect(field).toHaveProperty('value','Changed note');
});
it('bounds notes and exposes no action for missing, zero or unsafe line numbers',async()=>{
  const additions=Array.from({length:22},(_,index)=>`+line ${index}`).join('\n');
  vi.mocked(invoke).mockImplementation(async command=>command==='repository_diff'?{patch:`@@ -0,0 +1,22 @@\n${additions}\n@@ -999999999999999999999 +0 @@\n-old\n+zero`,binary:false}:command==='repository_status'
    ?{path:fileReviewRoot,changes:[{path:'new.ts',originalPath:null,index:'M',worktree:'M'}]}:fileReviewReply(command));
  render(<RepositoryPanel sessionId={fileReviewSession}/>);fireEvent.click(screen.getByRole('button',{name:'Open repository'}));
  fireEvent.click(await screen.findByRole('button',{name:'Staged diff'}));
  await screen.findByText('line 0');
  expect(screen.queryAllByRole('button',{name:/Comment on Before/})).toHaveLength(0);
  expect(screen.queryByRole('button',{name:'Comment on After line 0'})).toBeNull();
  const actions=screen.getAllByRole('button',{name:/Comment on After line/});
  expect(actions).toHaveLength(22);
  for(const action of actions.slice(0,20))fireEvent.click(action);
  expect(screen.getAllByRole('textbox',{name:/new.ts:/})).toHaveLength(20);
  for(const action of actions.slice(20))expect(action).toHaveProperty('disabled',true);
  for(const field of screen.getAllByRole('textbox',{name:/new.ts:/}))expect(field).toHaveProperty('maxLength',2000);
});
it('verifies real Git no-renames pathspec semantics for a staged rename followed by unstaged edits',()=>{
  const parent=join(homedir(),'dev','.worktrees');mkdirSync(parent,{recursive:true});
  const directory=mkdtempSync(join(parent,'.lazysh-diff-contract-'));
  try{
    const empty=join(directory,'empty-config');writeFileSync(empty,'');
    const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath='+directory,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false',...args],
      {cwd:directory,encoding:'utf8',timeout:5000,maxBuffer:1048576,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,GIT_CONFIG_GLOBAL:empty,GIT_CONFIG_SYSTEM:empty}});
    git('init','--quiet');writeFileSync(join(directory,'old.ts'),'first\nold\ntail\n');git('add','old.ts');git('commit','--quiet','-m','owned fixture');git('mv','old.ts','new.ts');
    const diff=(staged:boolean)=>git('diff','--no-ext-diff','--no-textconv','--no-color','--no-renames',...(staged?['--cached']:[]),'--','new.ts');
    const staged=diffLines(diff(true)).filter(row=>row.kind!=='hunk');
    expect(staged.length).toBe(3);expect(staged.every(row=>row.before===undefined&&Number.isSafeInteger(row.after))).toBe(true);
    writeFileSync(join(directory,'new.ts'),'first\nnew\ntail\n');
    const unstaged=diff(false);
    expect(unstaged).toContain('--- a/new.ts');expect(unstaged).toContain('+++ b/new.ts');
    expect(diffLines(unstaged).find(row=>row.left==='old')).toMatchObject({before:2,after:2,right:'new'});
  }finally{rmSync(directory,{recursive:true,force:true});}
});
it('does not mislabel copy-origin metadata as a rename',async()=>{
  vi.mocked(invoke).mockResolvedValueOnce({path:fileReviewRoot,changes:[{path:'new.ts',originalPath:'copied.ts',index:'C',worktree:'M'}]});
  await openDiff();fireEvent.click(screen.getByRole('button',{name:'Comment on Before line 3'}));
  const field=screen.getByRole('textbox',{name:/new.ts:3/});
  expect(field.closest('label')?.textContent).not.toContain('rename');
});
