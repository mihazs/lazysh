// Diagnostic text is untrusted: retain only finite fields after this case's
// unique native marker. No crash message, stack, process name or raw line escapes.
export class OwnedCaseCrashParser {
  private carry={out:'',err:''};
  private bytes=0;
  private pid:number|undefined;
  private native:{emitter:number,remaining:number}|undefined;
  private overflow=false;
  private ended=false;
  private records:{kind:'java'|'native',pid:number,time:string,signal?:number}[]=[];
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
    if(!this.overflow && this.carry.err)this.errorRow(this.carry.err);
    this.clear();
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
    if(this.ended)return;
    if(tag==='LazyshOwnedCase' && message===`start:${this.nonce}:pid:${emitter}`) {
      // A second process cannot silently rebind this case's original marker.
      this.pid??=emitter;return;
    }
    if(tag==='LazyshOwnedCase' && emitter===this.pid && message===`end:${this.nonce}:pid:${emitter}`){this.ended=true;this.native=undefined;return;}
    if(!this.pid || this.records.length>=8)return;
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
    return {scope:'owned-case-marker-window',correlated:this.pid!==undefined,ended:this.ended,overflow:this.overflow,records:this.records.map(record=>({...record})),stderr:{...this.stderr}};
  }
}
