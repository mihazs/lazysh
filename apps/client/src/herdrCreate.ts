import type {HerdrTree} from './useHerdrNavigation';

/** Mirrors the native checks so the dialog explains a problem before any host call. */
const control=/[\x00-\x1f\x7f-\x9f]/u;
const bytes=(value:string)=>new TextEncoder().encode(value).length;
function freeText(value:string,limit:number) {
  return value.trim().length>0 && bytes(value)<=limit && !control.test(value) && !value.includes('\\');
}
export function validLabel(value:string) {return freeText(value,200);}
export function validAbsolutePath(value:string) {
  return freeText(value,4096) && value.startsWith('/') && !value.split('/').slice(1).some(part=>part==='.'||part==='..');
}
/** `git check-ref-format --branch` rules, checked without the repository. */
export function validBranch(value:string) {
  if(!value || bytes(value)>200 || value==='HEAD' || value==='@')return false;
  return !(value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')
    || value.includes('..') || value.includes('//') || value.includes('@{') || control.test(value) || /[ ~^:?*[\\]/.test(value)
    || value.split('/').some(part=>part.startsWith('.') || part.endsWith('.lock')));
}
export function validBase(value:string) {
  return freeText(value,256) && !value.startsWith('-') && !/\s/.test(value);
}
export function validPrompt(value:string) {
  return value.trim()==='' || (freeText(value,2000) && !value.startsWith('-'));
}

/** A branch suggestion from a workspace label that differs from the current HEAD. */
export function branchFromLabel(label:string,head?:string) {
  const slug=label.toLocaleLowerCase().normalize('NFKD').replace(/[^a-z0-9/_-]+/g,'-').replace(/\/+/g,'/')
    .split('/').map(part=>part.replace(/^[-.]+|[-.]+$/g,'').replace(/\.lock$/,'')).filter(Boolean).join('/').slice(0,80).replace(/[-./]+$/,'');
  const branch=validBranch(slug)?slug:'worktree';
  return branch===head?`${branch}-2`:branch;
}
const parent=(path:string)=>path.slice(0,Math.max(1,path.lastIndexOf('/')));
const name=(path:string)=>path.slice(path.lastIndexOf('/')+1);
/** The repository's own convention when every linked worktree shares a parent, else `<repo>-worktrees`. */
export function suggestWorktreePath(repository:{main:string;worktrees:readonly string[]},branch:string) {
  const leaf=branch.replaceAll('/','-');
  const linked=repository.worktrees.filter(path=>path!==repository.main);
  const parents=new Set(linked.map(parent));
  const directory=parents.size===1?[...parents][0]:`${parent(repository.main)==='/'?'':parent(repository.main)}/${name(repository.main)}-worktrees`;
  return `${directory}/${leaf}`;
}
/** Herdr agent names are `[a-z][a-z0-9_-]{0,31}` and unique per server. */
export function agentName(kind:string,random:Uint8Array=crypto.getRandomValues(new Uint8Array(4))) {
  return `${kind}-${[...random].map(value=>value.toString(16).padStart(2,'0')).join('')}`;
}
/** The first reported directory of a workspace, in tab order. */
export function workspaceDirectory(tree:HerdrTree,workspace:string) {
  const tabs=tree.tabs.filter(tab=>tab.workspace_id===workspace).sort((a,b)=>a.number-b.number);
  for(const tab of tabs){const pane=tree.panes.find(pane=>pane.tab_id===tab.tab_id && pane.cwd);if(pane?.cwd)return pane.cwd;}
  return undefined;
}
/** The workspace a worktree can start from, with its directory: the focused one, else the first that reported a directory. */
export function worktreeSource(tree:HerdrTree) {
  for(const {workspace_id,label} of [...tree.workspaces].sort((a,b)=>Number(b.focused)-Number(a.focused))) {
    const directory=workspaceDirectory(tree,workspace_id);
    if(directory)return {workspace_id,label,directory};
  }
  return undefined;
}
export function knownDirectories(tree:HerdrTree|undefined,projects:readonly string[]=[]) {
  return [...new Set([...(tree?.panes.map(pane=>pane.cwd??'')??[]),...projects].filter(validAbsolutePath))];
}
