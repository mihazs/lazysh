// Diagnostic text is untrusted: retain only finite fields after this case's
// unique native marker. No crash message, stack, process name or raw line escapes.
export class OwnedCaseCrashParser {
  private carry={out:'',err:''};
  private bytes=0;
  private pid:number|undefined;
  private startTime:string|undefined;
  private persisted=false;
  private javaWindow=0;
  private ownedJava=false;
  private exceptions:string[]=[];
  private native:{emitter:number,remaining:number}|undefined;
  private overflow=false;
  private ended=false;
  private records:{kind:'java'|'native',pid:number,time:string,signal?:number}[]=[];
  private forceStops:{time:string,reason:'finished-instrumentation'|'start-instrumentation'|'external-request'|'other'}[]=[];
  // These describe this adb child's collector lifetime, not the app's crash cause.
  private stderr={unexpectedEof:false,readFailure:false,deviceUnavailable:false,waitingForDevice:false,other:false};
  constructor(private readonly nonce:string) {
    if(!/^[a-f0-9]{32}$/.test(nonce))throw new Error('Invalid owned case marker');
  }
  push(chunk:Buffer) {
    this.feed(chunk,'out');
  }
  pushStderr(chunk:Buffer) {
    this.feed(chunk,'err');
  }
  private feed(chunk:Buffer,channel:'out'|'err') {
    if(this.overflow)return;
    this.bytes+=chunk.length;
    if(this.bytes>64*1024){this.overflow=true;this.clear();return;}
    // Matching syntax is ASCII; incomplete UTF-8 cannot become a valid marker.
    const rows=(this.carry[channel]+chunk.toString('utf8')).split('\n');
    this.carry[channel]=rows.pop()!;
    for(const row of rows) {
      if(Buffer.byteLength(row)>1024){this.overflow=true;break;}
      const text=row.replace(/\r$/,'');
      if(channel==='out')this.row(text);else this.errorRow(text);
    }
    if(Buffer.byteLength(this.carry[channel])>1024)this.overflow=true;
    if(this.overflow)this.clear();
  }
  private clear() {this.carry.out='';this.carry.err='';}
  finish() {
    if(this.persisted && !this.overflow && this.carry.out)this.row(this.carry.out);
    if(!this.overflow && this.carry.err)this.errorRow(this.carry.err);
    this.clear();
  }
  persistedParser() {
    if(!this.pid || !this.startTime || this.ended || this.overflow || this.persisted)return;
    const parser=new OwnedCaseCrashParser(this.nonce);
    parser.pid=this.pid;parser.startTime=this.startTime;parser.persisted=true;
    return {pid:this.pid,time:this.startTime,parser};
  }
  recoverySummary() {
    return {overflow:this.overflow,exceptions:this.overflow?[]:[...this.exceptions]};
  }
  private errorRow(text:string) {
    if(!text.trim())return;
    const flags={
      unexpectedEof:/Unexpected EOF!/i.test(text),
      readFailure:/Logcat read failure|Unexpected length[.]/i.test(text),
      deviceUnavailable:/\bdevice (?:offline|not found|disconnected)\b|\bno devices\/emulators found\b/i.test(text),
      waitingForDevice:/^- waiting for device -$/.test(text),
    };
    for(const key of Object.keys(flags) as (keyof typeof flags)[])this.stderr[key] ||= flags[key];
    if(!Object.values(flags).some(Boolean))this.stderr.other=true;
  }
  private row(row:string) {
    const line=/^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\d{1,10})\s+\d{1,10}\s+[VDIWEF]\s+(\S+)\s*:\s(.*)$/.exec(row);
    if(!line)return;
    const [,time,emitterText,tag,message]=line;
    const emitter=Number(emitterText);
    if(emitter<1||emitter>2147483647)return;
    if(this.persisted) {
      // shortcut: yearless time can reject New Year-spanning cases; use year-bearing markers if recovery must cover them.
      if(emitter!==this.pid || time<this.startTime! || tag!=='AndroidRuntime')return;
      if(message.startsWith('FATAL EXCEPTION:')){this.javaWindow=64;this.ownedJava=false;return;}
      if(!this.javaWindow || --this.javaWindow<=0)return;
      if(message.startsWith('Process:')) {
        this.ownedJava=message===`Process: app.lazysh.client, PID: ${this.pid}`;return;
      }
      const exception=/^(?:Caused by: )?([A-Za-z_$][\w$]*(?:[.][A-Za-z_$][\w$]*)+)(?::|$)/.exec(message);
      if(!this.ownedJava || !exception || this.exceptions.length>=8)return;
      // Closed categories only: exception messages, class names and frames remain private.
      const known:Record<string,string>={
        'java.lang.NullPointerException':'null-pointer','java.lang.IllegalStateException':'illegal-state',
        'java.lang.IllegalArgumentException':'illegal-argument','java.lang.SecurityException':'security',
        'java.lang.OutOfMemoryError':'out-of-memory','java.lang.ClassNotFoundException':'class-not-found',
        'java.lang.NoClassDefFoundError':'class-linkage','java.lang.UnsatisfiedLinkError':'native-linkage',
        'java.lang.NoSuchMethodError':'method-linkage',
        'java.lang.RuntimeException':'runtime','android.os.DeadObjectException':'dead-object',
        'java.lang.AssertionError':'assertion','android.util.AndroidRuntimeException':'android-runtime',
        'androidx.test.espresso.PerformException':'espresso-action','androidx.test.espresso.NoMatchingViewException':'espresso-view',
        'android.os.RemoteException':'remote','android.view.WindowManager$BadTokenException':'window-token',
        'android.content.res.Resources$NotFoundException':'resource-not-found',
      };
      this.exceptions.push(known[exception[1]]??'other');return;
    }
    if(this.ended)return;
    if(tag==='LazyshOwnedCase' && message===`start:${this.nonce}:pid:${emitter}`) {
      // A second process cannot silently rebind this case's original marker.
      if(this.pid===undefined){this.pid=emitter;this.startTime=time;}return;
    }
    if(tag==='LazyshOwnedCase' && emitter===this.pid && message===`end:${this.nonce}:pid:${emitter}`){this.ended=true;this.native=undefined;return;}
    if(!this.pid || this.records.length+this.forceStops.length>=8)return;
    if(tag==='ActivityManager') {
      const stop=/^Force stopping app[.]lazysh[.]client appid=([0-9]{1,10}) user=(-?[0-9]{1,10}): (.+)$/.exec(message);
      if(!stop || Number(stop[1])>2147483647 || Number(stop[2]) < -1 || Number(stop[2])>2147483647)return;
      const reason=stop[3]==='finished inst'?'finished-instrumentation':stop[3]==='start instr'?'start-instrumentation':/^from pid [1-9][0-9]{0,9}(?: \([^\r\n]{1,128}\))?$/.test(stop[3])?'external-request':'other';
      // Package-scoped OS text: this does not identify the affected PID or caller.
      this.forceStops.push({time,reason});return;
    }
    if(tag==='AndroidRuntime' && emitter===this.pid && /^FATAL EXCEPTION:/.test(message)) {
      this.records.push({kind:'java',pid:this.pid,time});return;
    }
    if(tag!=='DEBUG')return;
    if(this.native && --this.native.remaining<=0)this.native=undefined;
    const process=/^pid: (\d{1,10}), tid: \d{1,10}, name: .{1,128}  >>> app[.]lazysh[.]client <<<$/.exec(message);
    if(message.startsWith('pid:')) {
      this.native=process && Number(process[1])===this.pid?{emitter,remaining:16}:undefined;
      return;
    }
    const signal=/^signal (\d{1,2}) \([A-Z0-9]+\),/.exec(message);
    if(this.native && emitter===this.native.emitter && signal) {
      const value=Number(signal[1]);
      if(value>=1&&value<=64)this.records.push({kind:'native',pid:this.pid,time,signal:value});
      this.native=undefined;
    }
  }
  summary() {
    return {scope:'owned-case-marker-window',correlated:this.pid!==undefined,ended:this.ended,overflow:this.overflow,records:this.records.map(record=>({...record})),forceStop:{state:this.forceStops.length?'reported':'unknown',records:this.forceStops.map(record=>({...record}))},stderr:{...this.stderr}};
  }
}
