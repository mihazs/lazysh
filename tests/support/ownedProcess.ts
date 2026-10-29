import {spawn, type ChildProcess} from 'node:child_process';
import {readFile} from 'node:fs/promises';

export const OUTPUT_LIMIT=16*1024;
// shortcut: foreground fixture tools only. A background child can outlive a reaped
// leader; never signal a recycled PGID or claim that orphan was cleaned. Add a real
// supervisor/OS ownership facility before using this helper for daemonizing tools.
export class OwnedProcess {
  readonly child:ChildProcess;
  readonly done:Promise<number>;
  private readonly original:Promise<OwnedPid|undefined>;
  stdout=''; stderr='';
  constructor(program:string,args:string[],cwd?:string,env=process.env,captureOutput=true) {
    this.child=spawn(program,args,{cwd,env,detached:true,stdio:['pipe','pipe','pipe']});
    this.original=(this.child.pid?identity(this.child.pid):Promise.resolve(undefined)).catch(()=>undefined);
    this.child.stdout!.on('data',data=>{if(captureOutput)this.stdout=(this.stdout+String(data)).slice(-OUTPUT_LIMIT);});
    this.child.stderr!.on('data',data=>{if(captureOutput)this.stderr=(this.stderr+String(data)).slice(-OUTPUT_LIMIT);});
    this.done=new Promise((resolve,reject)=>{
      this.child.once('error',()=>reject(new Error('Owned fixture process could not start')));
      this.child.once('close',code=>resolve(code??1));
    });
  }
  async liveIdentity() {
    const original=await this.original;
    if(!original || this.child.exitCode!==null || this.child.signalCode!==null)return;
    const current=await identity(original.pid);
    if(this.child.exitCode===null && this.child.signalCode===null && current?.start===original.start && current.parent===process.pid && !['Z','X'].includes(current.state))return original;
  }
  async stop() {
    const original=await this.liveIdentity();
    const pid=original?.pid;
    let force:ReturnType<typeof setTimeout>|undefined;
    let deadline:ReturnType<typeof setTimeout>|undefined;
    try {
      if(original && pid && this.child.exitCode===null && this.child.signalCode===null) {
        try {process.kill(-pid,'SIGTERM');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
        force=setTimeout(()=>{void this.liveIdentity().then(current=>{if(current?.start===original.start)try{process.kill(-pid,'SIGKILL');}catch{}}).catch(()=>{});},1000);
      }
      await Promise.race([this.done,new Promise<never>((_,reject)=>{
        deadline=setTimeout(()=>reject(new Error('Owned fixture process teardown deadline')),2000);
      })]);
    } finally {
      if(force)clearTimeout(force);if(deadline)clearTimeout(deadline);
      this.child.stdin?.destroy();this.child.stdout?.destroy();this.child.stderr?.destroy();
    }
  }
  async finish(stage:string,milliseconds:number) {
    let timer:ReturnType<typeof setTimeout>|undefined;
    let primary=false;
    try {
      const code=await Promise.race([this.done,new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new Error(`Owned fixture deadline: ${stage}`)),milliseconds);
      })]);
      if(code!==0)throw new Error(`Owned fixture failed: ${stage}; exit=${code}`);
      return this.stdout;
    } catch(error) {primary=true;throw error;}
    finally {
      if(timer)clearTimeout(timer);
      try{await this.stop();}catch(error){if(!primary)throw error;console.error('Owned fixture cleanup failed after original failure');}
    }
  }
}
export type OwnedPid={pid:number,parent:number,start:string,state:string};
export async function identity(pid:number):Promise<OwnedPid|undefined> {
  try {
    const text=await readFile(`/proc/${pid}/stat`,'utf8');
    const fields=text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/);
    return {pid,parent:Number(fields[1]),start:fields[19],state:fields[0]};
  } catch(error) {if(['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))return;throw error;}
}
export async function sameIdentity(saved:OwnedPid) {
  const current=await identity(saved.pid);
  return current?.start===saved.start && current.parent===saved.parent && !['Z','X'].includes(current.state);
}
export async function descendants(parent:OwnedPid,seen:OwnedPid[]=[]):Promise<OwnedPid[]> {
  if(!await sameIdentity(parent))return seen;
  let children:string;
  try {children=await readFile(`/proc/${parent.pid}/task/${parent.pid}/children`,'utf8');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return seen;throw error;}
  if(children.length>4096)throw new Error('Owned fixture descendant bound exceeded');
  for(const value of children.trim().split(/\s+/).filter(Boolean)) {
    if(!await sameIdentity(parent))return seen;
    const child=await identity(Number(value));
    if(!child || child.parent!==parent.pid || !await sameIdentity(parent))continue;
    if(seen.length>=64)throw new Error('Owned fixture descendant count exceeded');
    seen.push(child);await descendants(child,seen);
  }
  return seen;
}
