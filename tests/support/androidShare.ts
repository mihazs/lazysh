import {createServer as createTlsServer,request as tlsRequest,type Server} from 'node:https';
import {request as httpRequest} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {OwnedProcess} from './ownedProcess';
import {availablePort,sshCommand} from './sshFixture';

const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
type Counters={upload:number;history:number;download:number;delete:number};
function count(requests:Counters,target:string) {
  if(target==='POST /v1/shares')requests.upload++;
  else if(target==='GET /v1/shares')requests.history++;
  else if(target.startsWith('GET /s/'))requests.download++;
  else if(target.startsWith('DELETE /v1/shares/'))requests.delete++;
}
/** A request the host itself makes to ask the service something; the app's own traffic is what the counters measure. */
const probe={'x-owned-probe':'1'};

/**
 * The repository's own share service binary (#1738), served over TLS with a throwaway certificate
 * the way a reverse proxy would front it. The Android case configures it in the Share dialog; the
 * host only reads the service's state with the management token and never drives the UI.
 */
export class ShareService {
  readonly seen=new Set<string>();
  private constructor(readonly origin:string,readonly port:number,readonly token:string,readonly certificate:string,
    private readonly directory:string,private readonly backend:number,private readonly daemon:OwnedProcess,private readonly front:Server,
    private readonly requests:Counters) {}

  /** Builds `lazysh-share` from this checkout (or uses LAZYSH_TEST_SHARE_BIN), then starts it behind the TLS front. */
  static async start(root=resolve(import.meta.dir,'../..')) {
    let binary=process.env.LAZYSH_TEST_SHARE_BIN;
    if(!binary) {
      await new OwnedProcess('cargo',['build','--locked','-p','lazysh-share'],root).finish('build the real share service',900_000);
      binary=join(process.env.CARGO_TARGET_DIR??join(root,'target'),'debug/lazysh-share');
    }
    const directory=await mkdtemp(join(tmpdir(),'lazysh-share-'));
    let daemon:OwnedProcess|undefined,front:Server|undefined;
    try {
      // A throwaway root and a leaf it signs: the app trusts only the root, and the front presents only the leaf.
      const openssl=(stage:string,args:string[])=>sshCommand(stage,'openssl',args,directory);
      const curve=['-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes'];
      await openssl('throwaway share root',['req','-x509',...curve,'-keyout','root.key','-out','root.pem','-days','2','-subj','/CN=lazysh test share root',
        '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign']);
      await openssl('throwaway share leaf request',['req',...curve,'-keyout','key.pem','-out','leaf.csr','-subj','/CN=localhost']);
      await writeFile(join(directory,'leaf.ext'),'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n');
      await openssl('throwaway share leaf',['x509','-req','-in','leaf.csr','-CA','root.pem','-CAkey','root.key','-CAcreateserial','-out','cert.pem','-days','2','-extfile','leaf.ext']);
      const [key,leaf,certificate]=await Promise.all([readFile(join(directory,'key.pem')),readFile(join(directory,'cert.pem')),readFile(join(directory,'root.pem'),'utf8')]);
      const token=randomBytes(32).toString('hex');
      await writeFile(join(directory,'token'),token+'\n',{mode:0o600});
      const port=await availablePort();
      const origin=`https://127.0.0.1:${port}`;
      daemon=new OwnedProcess(binary,['serve','--token-file',join(directory,'token'),'--data-dir',join(directory,'data'),'--public-origin',origin,'--listen','127.0.0.1:0']);
      const backend=await new Promise<number>((done,fail)=>{
        const timer=setTimeout(()=>fail(new Error('The real share service did not announce its listener')),20_000);
        const check=()=>{
          const port_=/^LISTENING 127\.0\.0\.1:([0-9]+)$/m.exec(daemon!.stdout)?.[1];
          if(port_){clearTimeout(timer);done(Number(port_));}
          else if(daemon!.child.exitCode!==null){clearTimeout(timer);fail(new Error('The real share service exited before it listened'));}
          else setTimeout(check,50);
        };
        check();
      });
      const requests:Counters={upload:0,history:0,download:0,delete:0};
      front=createTlsServer({key,cert:leaf},(incoming,response)=>{
        if(!incoming.headers['x-owned-probe'])count(requests,`${incoming.method} ${(incoming.url??'').split('?')[0]}`);
        const upstream=httpRequest({host:'127.0.0.1',port:backend,method:incoming.method,path:incoming.url,headers:incoming.headers},reply=>{
          response.writeHead(reply.statusCode??502,reply.headers);reply.pipe(response);
        });
        upstream.on('error',()=>{response.writeHead(502);response.end();});
        incoming.pipe(upstream);
      });
      const bound=front;
      await new Promise<void>((done,fail)=>{bound.once('error',fail);bound.listen(port,'127.0.0.1',done);});
      return new ShareService(origin,port,token,certificate,directory,backend,daemon,front,requests);
    } catch(error) {
      front?.close();await daemon?.stop().catch(()=>{});await rm(directory,{recursive:true,force:true});throw error;
    }
  }

  private async direct(path:string,authorized=true) {
    return fetch(`http://127.0.0.1:${this.backend}${path}`,{headers:authorized?{authorization:`Bearer ${this.token}`}:{}});
  }

  /** The service's own state: every listed share with the hash of its stored bytes, and what a deleted one now answers. */
  async facts() {
    const listing=await (await this.direct('/v1/shares?limit=100')).json() as {shares:{id:string;name:string;mime:string;size:number;createdAt:number;expiresAt:number;url:string}[]};
    const shares=[];
    for(const share of listing.shares) {
      this.seen.add(share.id);
      const stored=new Uint8Array(await (await this.direct(`/s/${share.id}`,false)).arrayBuffer());
      shares.push({name:share.name,mime:share.mime,size:share.size,sha256:sha256(stored),ttl:share.expiresAt-share.createdAt,url:share.url});
    }
    const listed=new Set(listing.shares.map(share=>share.id));
    const gone=[];
    for(const id of this.seen)if(!listed.has(id))gone.push((await this.direct(`/s/${id}`,false)).status);
    return {shares,gone,requests:{...this.requests}};
  }

  /** Opens a link the way its recipient would: a TLS request to exactly the URL the app copied. */
  async open(url:unknown) {
    const prefix=`${this.origin}/s/`;
    if(typeof url!=='string' || !url.startsWith(prefix) || !/^[0-9a-f]{64}$/.test(url.slice(prefix.length)))throw new Error('url');
    return new Promise<{status:number;size:number;sha256:string;type:string}>((done,fail)=>{
      const call=tlsRequest(url,{ca:this.certificate,headers:probe},reply=>{
        const chunks:Buffer[]=[];
        reply.on('data',chunk=>chunks.push(chunk));
        reply.on('end',()=>{const bytes=Buffer.concat(chunks);done({status:reply.statusCode??0,size:bytes.length,sha256:sha256(bytes),type:String(reply.headers['content-type']??'')});});
      });
      call.on('error',fail);call.end();
    });
  }

  async stop() {
    this.front.closeAllConnections();
    await new Promise<void>(done=>this.front.close(()=>done()));
    await this.daemon.stop();
    await rm(this.directory,{recursive:true,force:true});
  }
}
