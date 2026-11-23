import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {OwnedProcess,descendants,identity,type OwnedPid} from '../../../tests/support/ownedProcess';
import {ibusDaemonArguments,ibusEnvironment} from './policy';
import {executable,until} from './tools';

/** An engine that composes Pinyin: `ni hao` followed by Space commits the first candidate. */
export const IME_ENGINE='libpinyin';
/** The keyboard layout engine hands every key through unchanged, which WebDriver typing needs while Pinyin is not under test. */
const PASS_THROUGH_ENGINE='xkb:us::eng';
export const IME_PINYIN=['n','i','h','a','o'];
export const IME_COMMIT=['space'];
export const IME_TEXT='你好';
const MEMCONF='/usr/libexec/ibus-memconf';

/** A real IBus daemon and engine on the owned display; keys reach the application as real X events, not WebDriver ones. */
export class OwnedInputMethod {
  private members:OwnedPid[]=[];
  private constructor(private readonly daemon:OwnedProcess,private readonly directory:string,private readonly env:NodeJS.ProcessEnv,
    private readonly tools:{ibus:string;xdotool:string}) {}

  /** `env` is the owned GUI environment with `inputMethodEnvironment` applied, so the daemon listens where the application looks. */
  static async start(directory:string,env:NodeJS.ProcessEnv) {
    // The distribution's own binaries are owned by an unmapped UID in the test namespace; CI selects owned copies like the other tools.
    const [daemon,ibus,xdotool]=await Promise.all([
      executable(process.env.LAZYSH_NATIVE_GUI_IBUS_DAEMON??'/usr/bin/ibus-daemon','IBus daemon','ibus-daemon'),
      executable(process.env.LAZYSH_NATIVE_GUI_IBUS??'/usr/bin/ibus','IBus client','ibus'),
      executable(process.env.LAZYSH_NATIVE_GUI_XDOTOOL??'/usr/bin/xdotool','X key sender','xdotool'),
    ]);
    if(!(await stat(MEMCONF).catch(()=>undefined))?.isFile())throw new Error('Missing native GUI dependency: IBus in-memory config service');
    const address=env.IBUS_ADDRESS!,socket=join(directory,'runtime/ibus');
    // The daemon quits as soon as its parent is PID 1, so it must be a child of this worker, not of a namespace init.
    const ibusEnv=ibusEnvironment(env);
    const process_=new OwnedProcess(daemon,ibusDaemonArguments(address,MEMCONF),directory,ibusEnv);
    const method=new OwnedInputMethod(process_,directory,ibusEnv,{ibus,xdotool});
    try {
      await until('owned IBus daemon',async()=>{
        if(!await process_.liveIdentity())throw new Error(`Owned IBus daemon stopped during startup; exit=${process_.child.exitCode}`);
        return (await stat(socket).catch(()=>undefined))?.isSocket()?true:undefined;
      },10_000);
      await method.selectEngine(PASS_THROUGH_ENGINE);
      return method;
    } catch(error) {try{await method.stop();}catch(cleanup){throw new AggregateError([error,cleanup],'Owned IBus startup and cleanup failed');}throw error;}
  }
  private run(stage:string,program:string,args:string[],milliseconds=10_000) {
    return new OwnedProcess(program,args,this.directory,this.env).finish(stage,milliseconds);
  }
  /** The first selection starts the engine process, which can outlast IBus's own reply timeout, so ask again until it is the global engine. */
  private async selectEngine(name:string) {
    await until('owned IBus engine',async()=>{
      await this.run('IBus engine selection',this.tools.ibus,['engine',name]).catch(()=>undefined);
      return (await this.run('IBus engine query',this.tools.ibus,['engine'],5000).catch(()=>'')).trim()===name?true:undefined;
    },60_000);
    this.members=await this.processes();
  }
  /** Run `compose` with the Pinyin engine active, then hand keys through again so later typing is not composed. */
  async withPinyin<T>(compose:()=>Promise<T>) {
    await this.selectEngine(IME_ENGINE);
    try {return await compose();}
    finally {await this.selectEngine(PASS_THROUGH_ENGINE);}
  }
  private async processes() {
    const root=await this.daemon.liveIdentity();if(!root)throw new Error('Owned IBus daemon stopped');
    const retained=new Map(this.members.map(item=>[`${item.pid}:${item.start}`,item]));
    for(const item of await descendants(root))retained.set(`${item.pid}:${item.start}`,item);
    if(retained.size>64)throw new Error('Owned IBus process history bound exceeded');
    return [...retained.values()];
  }
  /** With no window manager nothing else gives the application window X input focus, and IBus only serves a focused client. */
  async focusWindow(title:string) {
    const windows=(await this.run('application window',this.tools.xdotool,['search','--onlyvisible','--name',`^${title}$`])).trim().split('\n').filter(Boolean);
    if(windows.length!==1||!/^[1-9][0-9]*$/.test(windows[0]))throw new Error('Exactly one visible owned application window required');
    await this.run('application window focus',this.tools.xdotool,['windowfocus','--sync',windows[0]]);
  }
  /** Press the keys through the X server's test extension, so they take the same path as a keyboard. */
  async press(keys:string[]) {
    if(keys.some(key=>!/^[a-z]+$/.test(key)))throw new Error('Invalid owned input-method key');
    await this.run('input-method keys',this.tools.xdotool,['key','--delay','120',...keys]);
  }
  async diagnostic() {
    const focus=await this.run('X focus',this.tools.xdotool,['getwindowfocus']).catch(()=>'unavailable');
    return JSON.stringify({focus:focus.trim(),stderr:this.daemon.stderr.slice(-1500),stdout:this.daemon.stdout.slice(-500)});
  }
  async stop() {
    this.members=await this.processes().catch(()=>this.members);
    await this.daemon.stop();
    await until('owned IBus retirement',async()=>{
      const live=await Promise.all(this.members.map(async item=>{const current=await identity(item.pid);return current?.start===item.start&&!['Z','X'].includes(current.state);}));
      return live.some(Boolean)?undefined:true;
    },5000);
  }
}
