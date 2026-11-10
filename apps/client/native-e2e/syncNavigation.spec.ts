import {execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {ownedSshGui,workspaceAction} from './sshUi';
import {setNavigationChord} from './navigationUi';

const fixture=ownedSshGui();
it.skipIf(process.env.LAZYSH_SYNC_TLS_ACCEPTANCE!=='1')('restores uploaded navigation shortcuts through verified HTTPS and the native GUI',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lazysh-sync-tls-'));
  let server:ReturnType<typeof createServer>|undefined;
  try {
    const root=join(directory,'root.pem'),key=join(directory,'key.pem'),cert=join(directory,'cert.pem'),request=join(directory,'request.pem');
    execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'root-key.pem'),'-out',root,'-days','1','-subj','/CN=lazysh test root'],{stdio:'ignore'});
    execFileSync('/usr/bin/openssl',['req','-newkey','rsa:2048','-nodes','-keyout',key,'-out',request,'-subj','/CN=127.0.0.1'],{stdio:'ignore'});
    const ext=join(directory,'ext');await import('node:fs/promises').then(fs=>fs.writeFile(ext,'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n'));
    execFileSync('/usr/bin/openssl',['x509','-req','-in',request,'-CA',root,'-CAkey',join(directory,'root-key.pem'),'-CAcreateserial','-out',cert,'-days','1','-extfile',ext],{stdio:'ignore'});
    const mismatch=join(directory,'mismatch.pem'),untrusted=join(directory,'untrusted.pem'),untrustedKey=join(directory,'untrusted-key.pem');
    await import('node:fs/promises').then(fs=>fs.writeFile(ext,'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n'));
    execFileSync('/usr/bin/openssl',['x509','-req','-in',request,'-CA',root,'-CAkey',join(directory,'root-key.pem'),'-CAcreateserial','-out',mismatch,'-days','1','-extfile',ext],{stdio:'ignore'});
    execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',untrustedKey,'-out',untrusted,'-days','1','-subj','/CN=untrusted test','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
    const validContext={key:await readFile(key),cert:await readFile(cert)};
    const objects=new Map<string,{body:Buffer;etag:string}>();
    let requests=0,tlsErrors=0;
    server=createServer(validContext,(req,res)=>{
      requests++;res.setHeader('Connection','close');
      if(req.headers.authorization!=='Basic '+Buffer.from('owned:owned').toString('base64')||!/^\/dav\/[a-z0-9.-]+$/.test(req.url??'')){res.writeHead(403).end();return;}
      const path=req.url!,current=objects.get(path);
      if(req.method==='GET'){if(!current)res.writeHead(404).end();else res.writeHead(200,{ETag:current.etag}).end(current.body);return;}
      if(req.method!=='PUT'||(current?req.headers['if-match']!==current.etag:req.headers['if-none-match']!=='*')){res.writeHead(412).end();return;}
      const chunks:Buffer[]=[];let length=0;
      req.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>8*1024*1024)req.destroy();else chunks.push(chunk);});
      req.on('end',()=>{const etag=`"${objects.size+1}-${Date.now()}"`;objects.set(path,{body:Buffer.concat(chunks),etag});res.writeHead(201,{ETag:etag}).end();});
    });
    server.on('tlsClientError',()=>{tlsErrors++;});
    await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',resolve);});
    const port=(server.address() as {port:number}).port;
    const gui=fixture.gui=await NativeGui.startWithSyncTestCa(await readFile(root,'utf8')),browser=gui.browser!;
    await (await browser.$('button[aria-label="Connect to Primary GUI host"]')).waitForDisplayed({timeout:30_000});
    await gui.secondary(['--dir',gui.directory]);
    await (await browser.$('.terminal-canvas .xterm-screen')).waitForDisplayed({timeout:20_000});
    gui.stage='set uploaded navigation chord';await setNavigationChord(gui,'C-M-W');
    await workspaceAction(gui,'Open encrypted sync');
    let sync=await browser.$('section[aria-label="Encrypted sync"]');await sync.waitForDisplayed();
    await browser.waitUntil(async()=>await (await sync.$('input[type="url"]')).isEnabled(),{timeout:20_000});
    await (await sync.$('input[type="url"]')).setValue(`https://127.0.0.1:${port}/dav/`);
    await (await (await sync.$('label=WebDAV username')).$('input')).setValue('owned');
    await (await (await sync.$('label=WebDAV password')).$('input')).setValue('owned');
    await (await (await sync.$('label=Enable settings sync')).$('input')).click();
    await (await sync.$('button=Configure sync')).click();
    await (await sync.$('button=Upload settings')).waitForDisplayed({timeout:20_000});
    gui.stage='upload encrypted settings';await (await sync.$('button=Upload settings')).click();
    await browser.waitUntil(async()=>(await sync.getText()).includes('Encrypted settings uploaded.'),{timeout:30_000});
    expect(objects.size).toBe(2);
    gui.stage='reject untrusted and wrong-host certificates';
    for(const context of [{key:await readFile(untrustedKey),cert:await readFile(untrusted)},{key:validContext.key,cert:await readFile(mismatch)}]) {
      server.setSecureContext(context);const before=requests,errors=tlsErrors;
      await (await sync.$('button=Preview remote settings')).click();
      await browser.waitUntil(()=>tlsErrors>errors,{timeout:30_000});
      await (await sync.$('[role="alert"]')).waitForDisplayed({timeout:30_000});
      expect(await (await sync.$('[role="alert"]')).getText()).toContain('Cannot fetch encrypted sync data');
      expect(requests).toBe(before);
    }
    server.setSecureContext(validContext);
    gui.stage='change local navigation chord';await (await browser.$('button[aria-label="Close Encrypted sync"]')).click();
    await (await browser.$('[role="dialog"][aria-label="Encrypted sync"]')).waitForDisplayed({reverse:true});
    await setNavigationChord(gui,'C-M-E');
    await workspaceAction(gui,'Open encrypted sync');
    sync=await browser.$('section[aria-label="Encrypted sync"]');await sync.waitForDisplayed();
    gui.stage='preview and apply encrypted settings';await (await sync.$('button=Preview remote settings')).click();
    await (await sync.$('button=Apply reviewed changes')).waitForDisplayed({timeout:30_000});
    await (await sync.$('button=Apply reviewed changes')).click();
    await browser.waitUntil(async()=>(await sync.getText()).includes('Imported'),{timeout:30_000});
    await (await browser.$('button[aria-label="Close Encrypted sync"]')).click();
    await (await browser.$('[role="dialog"][aria-label="Encrypted sync"]')).waitForDisplayed({reverse:true});
    const connections=await browser.$('button[data-workspace-mode="connections"]');await connections.click();
    expect(await connections.getAttribute('aria-current')).toBe('page');
    await browser.action('key').down('\uE009').down('\uE00A').down('e').up('e').up('\uE00A').up('\uE009').perform();
    expect(await connections.getAttribute('aria-current')).toBe('page');
    await browser.action('key').down('\uE009').down('\uE00A').down('w').up('w').up('\uE00A').up('\uE009').perform();
    await browser.waitUntil(async()=>await (await browser.$('button[data-workspace-mode="workspaces"]')).getAttribute('aria-current')==='page',{timeout:5000});
  } catch(error) {
    console.error(`Owned sync GUI failure stage: ${fixture.gui?.stage??'startup'}`);throw error;
  } finally {
    await fixture.gui?.stop();fixture.gui=undefined;
    if(server)await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
    await rm(directory,{recursive:true,force:true});
  }
});
