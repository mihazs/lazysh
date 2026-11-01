import {connect,createServer,type Socket} from 'node:net';
import {acceptedConnectionOwner} from './socketOwner';
import {descendants,sameIdentity,type OwnedPid} from '../../../tests/support/ownedProcess';

/** Close an attributed SSH byte stream without touching its listener or UDP peer. */
export class OwnedSshRelay {
  private readonly pairs=new Map<Socket,Socket>();
  private accepted=0;
  private readonly server=createServer(peer=>{
    if(++this.accepted>16){peer.destroy();return;}
    const upstream=connect({host:'127.0.0.1',port:this.target});
    this.pairs.set(peer,upstream);
    const close=()=>{peer.destroy();upstream.destroy();this.pairs.delete(peer);};
    peer.once('error',close);upstream.once('error',close);
    peer.once('close',close);upstream.once('close',close);
    peer.pipe(upstream);upstream.pipe(peer);
  });
  private constructor(private readonly target:number) {}
  get port(){return (this.server.address() as {port:number}).port;}
  get active(){return this.pairs.size;}
  static async start(target:number) {
    const relay=new OwnedSshRelay(target);
    await new Promise<void>((yes,no)=>{relay.server.once('error',no);relay.server.listen(0,'127.0.0.1',yes);});
    return relay;
  }
  async closeOwned(owner:OwnedPid) {
    if(!await sameIdentity(owner))throw new Error('Owned SSH relay peer identity retired');
    const matches:Socket[]=[];
    for(const peer of this.pairs.keys()) {
      const attributed=await acceptedConnectionOwner(peer,async()=>[owner]);
      if(attributed?.identity.start===owner.start && attributed.identity.pid===owner.pid)matches.push(peer);
    }
    if(matches.length!==1 || !await sameIdentity(owner))throw new Error('Exactly one live owned SSH relay peer required');
    const peer=matches[0],upstream=this.pairs.get(peer);
    if(!upstream)throw new Error('Owned SSH relay pair retired');
    peer.destroy();upstream.destroy();this.pairs.delete(peer);
  }
  // Android PIDs are not host identities; attribute the opposite end to the owned sshd subtree.
  async closeOwnedServer(owner:OwnedPid) {
    if(!await sameIdentity(owner))throw new Error('Owned SSH server identity retired');
    if(this.pairs.size!==1)throw new Error('Exactly one live owned SSH server stream required');
    const members=()=>descendants(owner);
    const [peer,upstream]=[...this.pairs][0];
    if(upstream.destroyed || upstream.remoteAddress!=='127.0.0.1' || upstream.localAddress!=='127.0.0.1' || upstream.remotePort!==this.target)throw new Error('Owned SSH server stream retired');
    const attributed=await acceptedConnectionOwner(upstream,members);
    if(!attributed || !await sameIdentity(owner))throw new Error('Exactly one live owned SSH server stream required');
    const server=attributed.identity;
    const current=await acceptedConnectionOwner(upstream,members);
    if(current?.identity.pid!==server.pid || current.identity.start!==server.start || !await sameIdentity(server) || !await sameIdentity(owner)
      || this.pairs.size!==1 || this.pairs.get(peer)!==upstream || peer.destroyed || upstream.destroyed)throw new Error('Owned SSH server stream retired');
    peer.destroy();upstream.destroy();this.pairs.delete(peer);
  }
  async stop() {
    for(const [peer,upstream] of this.pairs){peer.destroy();upstream.destroy();}
    this.pairs.clear();
    if(this.server.listening)await new Promise<void>((yes,no)=>this.server.close(error=>error?no(error):yes()));
  }
}
