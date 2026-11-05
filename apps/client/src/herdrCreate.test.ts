import {describe,expect,it} from 'vitest';
import {agentName,branchFromLabel,knownDirectories,suggestWorktreePath,validAbsolutePath,validBase,validBranch,validLabel,validPrompt,workspaceDirectory} from './herdrCreate';
import type {HerdrTree} from './useHerdrNavigation';

describe('Herdr creation validation',()=>{
  it('applies git branch name rules before any host call',()=>{
    for(const name of ['main','feat/x','fix/ssh-host_binding.2','$(touch${IFS}x)','a@b','ü'])expect(validBranch(name),name).toBe(true);
    for(const name of ['','-x','HEAD','@','a..b','a b','a~1','a^','a:b','a?','a*','a[','a\\b','a/','/a','a//b','.a','a/.b','a.lock','a/b.lock/c','a@{1}','a.','a\nb','a\u007f','a\u0085b','a\u009fb','x'.repeat(201)])
      expect(validBranch(name),JSON.stringify(name)).toBe(false);
  });
  it('accepts only absolute single-line paths without dot segments or backslashes',()=>{
    expect(validAbsolutePath('/srv/it\'s $(here)')).toBe(true);
    for(const path of ['','relative','~/x','/a/../b','/a/./b','/a\nb','/a\\b','   '])expect(validAbsolutePath(path),path).toBe(false);
  });
  it('bounds labels, base revisions and prompts like the native checks',()=>{
    expect(validLabel('a;$(touch nope)\'')).toBe(true);
    expect(validLabel(' ')).toBe(false);
    expect(validLabel('é'.repeat(101))).toBe(false);
    expect(validBase('origin/main~2')).toBe(true);
    for(const base of ['-b','--orphan','a b',''])expect(validBase(base),base).toBe(false);
    expect(validPrompt('')).toBe(true);
    expect(validPrompt('review \'this\' $(id)')).toBe(true);
    for(const prompt of ['-p','two\nlines','back\\slash'])expect(validPrompt(prompt),prompt).toBe(false);
  });
});

describe('Herdr worktree suggestions',()=>{
  it('derives a valid branch from the label and avoids the current HEAD',()=>{
    expect(branchFromLabel('My API: v2 / Fixes!')).toBe('my-api-v2/fixes');
    expect(branchFromLabel('main','main')).toBe('main-2');
    expect(branchFromLabel('…')).toBe('worktree');
    expect(validBranch(branchFromLabel('.hidden.lock'))).toBe(true);
  });
  it('follows the repository convention when linked worktrees share a parent',()=>{
    expect(suggestWorktreePath({main:'/srv/app',worktrees:['/srv/app']},'feat/x')).toBe('/srv/app-worktrees/feat-x');
    expect(suggestWorktreePath({main:'/srv/app',worktrees:['/srv/app','/wt/app/a','/wt/app/b']},'fix')).toBe('/wt/app/fix');
    expect(suggestWorktreePath({main:'/srv/app',worktrees:['/srv/app','/one/a','/two/b']},'fix')).toBe('/srv/app-worktrees/fix');
    expect(suggestWorktreePath({main:'/app',worktrees:[]},'x')).toBe('/app-worktrees/x');
  });
  it('names agents within Herdr limits',()=>{
    expect(agentName('mastracode',new Uint8Array([0,15,160,255]))).toBe('mastracode-000fa0ff');
    expect(agentName('codex')).toMatch(/^codex-[0-9a-f]{8}$/);
  });
  it('reads workspace and known directories only from reported absolute cwd values',()=>{
    const tree:HerdrTree={workspaces:[{workspace_id:'w1',label:'a',focused:true,agent_status:'idle'}],
      tabs:[{workspace_id:'w1',tab_id:'w1:t2',label:'b',number:2,focused:false,agent_status:'idle'},{workspace_id:'w1',tab_id:'w1:t1',label:'a',number:1,focused:true,agent_status:'idle'}],
      panes:[{workspace_id:'w1',tab_id:'w1:t2',pane_id:'w1:p2',cwd:'/second',focused:false,agent_status:'idle'},{workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p1',cwd:null,focused:true,agent_status:'idle'},{workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p3',cwd:'/first',focused:false,agent_status:'idle'}]};
    expect(workspaceDirectory(tree,'w1')).toBe('/first');
    expect(workspaceDirectory(tree,'w9')).toBeUndefined();
    expect(knownDirectories(tree,['/first','relative','/project'])).toEqual(['/second','/first','/project']);
  });
});
