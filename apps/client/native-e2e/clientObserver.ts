import {channel,type Channel} from 'node:diagnostics_channel';
import {Socket} from 'node:net';

// NET diagnostic channels are experimental. The native controlled contract must
// establish runtime coverage; no channel events means inconclusive, not no traffic.
export class ClientTargetObserver {
  private readonly source?:Channel;
  private readonly pending=new Map<Socket,()=>void>();
  private active=true;
  published=0;
  targetConnections=0;
  incomplete=false;
  constructor(private readonly port:number,private readonly onTarget:()=>void) {
    if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid owned observer target');
    try {this.source=channel('net.client.socket');this.source.subscribe(this.observe);}catch {this.incomplete=true;}
  }
  private readonly observe=(message:unknown)=>{
    if(!this.active)return;
    // Diagnostic handlers must not throw into the network operation they observe.
    try {
      const socket=(message as {socket?:unknown}|null)?.socket;
      if(!(socket instanceof Socket)){this.incomplete=true;return;}
      this.published++;
      if(this.pending.has(socket))return;
      if(this.pending.size>=64){this.incomplete=true;return;}
      const release=()=>{socket.off('connect',connected);socket.off('close',release);this.pending.delete(socket);};
      const connected=()=>{
        try {
          if(socket.remoteAddress==='127.0.0.1'&&socket.remotePort===this.port) {
            this.targetConnections++;
            if(this.targetConnections===1)this.onTarget();
          }
        } catch {this.incomplete=true;} finally {release();}
      };
      this.pending.set(socket,release);socket.once('connect',connected);socket.once('close',release);
    } catch {this.incomplete=true;}
  };
  status() {return this.published>0&&!this.incomplete?'client-channel-observed':'inconclusive';}
  stop() {
    this.active=false;
    try {this.source?.unsubscribe(this.observe);}catch {this.incomplete=true;}
    for(const release of this.pending.values())release();
  }
}
