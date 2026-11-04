import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import Markdown from 'react-markdown';
import {chmod,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {executable} from '../../native-e2e/tools';
import {expect,it} from 'vitest';
import {disposableVaultArguments,secretServicePid,credentialItemPaths} from '../../native-e2e/fixture';
import {assertDirectDriverEnvironment,guiEnvironment,listenerInode,namespaceArguments} from '../../native-e2e/policy';

it('refuses a WebDriver client proxy instead of sending owned loopback traffic through it',()=>{
  expect(()=>assertDirectDriverEnvironment({})).not.toThrow();
  for(const key of ['HTTP_PROXY','https_proxy','ALL_PROXY','NODE_USE_ENV_PROXY'])expect(()=>assertDirectDriverEnvironment({[key]:'enabled'})).toThrow('direct loopback');
});

it('does not inherit user display, bus, loader or home state into the native GUI child',()=>{
  const env=guiEnvironment('/tmp/lazysh-native-gui-owned','unix:path=/tmp/lazysh-native-gui-owned/runtime/bus',1200);
  expect(env.DISPLAY).toBe(':1200');expect(env.HOME).toBe('/tmp/lazysh-native-gui-owned/home');
  expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(env.DBUS_SYSTEM_BUS_ADDRESS);
  for(const key of ['WAYLAND_DISPLAY','SSH_AUTH_SOCK','LD_PRELOAD','LD_LIBRARY_PATH','DBUS_STARTER_ADDRESS','XDG_CURRENT_DESKTOP'])expect(env).not.toHaveProperty(key);
  expect(()=>guiEnvironment('/tmp/owned','unix:path=/run/user/1000/bus',1200)).toThrow();
  expect(()=>guiEnvironment('relative','tcp:host=localhost',1200)).toThrow();
});
const row=(address:string,state:string,inode='441')=>`0: ${address} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode} 1 0`;
it('accepts only an exact IPv4-loopback listening inode and rejects wildcard, connected and ambiguous entries',()=>{
  expect(listenerInode(`header\n${row('0100007F:115C','0A')}`,4444)).toBe('441');
  for(const [address,state] of [['00000000:115C','0A'],['0100007F:115D','0A'],['0100007F:115C','01']])expect(listenerInode(`header\n${row(address,state)}`,4444)).toBeUndefined();
  expect(()=>listenerInode(`header\n${row('0100007F:115C','0A')}\n${row('0100007F:115C','0A','442')}`,4444)).toThrow('Ambiguous');
  expect(()=>listenerInode('x'.repeat(256*1024+1),4444)).toThrow();
});
it('requires a PID-namespace supervisor and hides host home/runtime/display sockets without a permissive fallback',()=>{
  const args=namespaceArguments('/tmp/driver',['--port','4444'],'/tmp/owned','/home/owned','/tmp/.X11-unix/X1200',['/tmp/driver','/home/owned/target/lazysh']);
  expect(args).toContain('--unshare-pid');expect(args).toContain('--die-with-parent');expect(args).toContain('--unshare-user');
  expect(args.join(' ')).toContain('--tmpfs /home/owned --tmpfs /run --tmpfs /tmp');
  expect(args.join(' ')).toContain('--ro-bind /tmp/.X11-unix/X1200 /tmp/.X11-unix/X1200');
  expect(args).not.toContain('--unshare-user-try');expect(args).not.toContain('--not-a-security-boundary');
  expect(()=>namespaceArguments('driver',[],'/tmp/owned','/home/owned','/tmp/.X11-unix/X1200',[])).toThrow();
});

it('keeps the disposable vault foreground, secrets-only and within the existing private GUI namespace',()=>{
  const directory='/tmp/lazysh-native-gui-vault';
  expect(disposableVaultArguments(directory)).toEqual(['--foreground','--unlock','--components=secrets',`--control-directory=${directory}/runtime`]);
  for(const bad of ['relative','/tmp/lazysh-native-gui-a/../other','/home/owned','/tmp/lazysh-native-gui-vault\n'])expect(()=>disposableVaultArguments(bad)).toThrow();
  const env=guiEnvironment(directory,`unix:path=${directory}/runtime/bus`);
  for(const key of ['GNOME_KEYRING_CONTROL','GPG_AGENT_INFO','SSH_AUTH_SOCK','DBUS_STARTER_ADDRESS'])expect(env).not.toHaveProperty(key);
  const image='/home/owned/tools/gnome-keyring-daemon';
  const args=namespaceArguments(image,disposableVaultArguments(directory),directory,'/home/owned','/tmp/.X11-unix/X1200',[image]);
  expect(args.join(' ')).toContain(`--ro-bind ${image} ${image}`);
  expect(args.indexOf(image)).toBeGreaterThan(args.indexOf('--tmpfs'));
  expect(args.join(' ')).toContain('--tmpfs /home/owned --tmpfs /run --tmpfs /tmp');
  expect(args).not.toContain('--start');expect(args).not.toContain('--daemonize');
});
it('admits only one bounded local PID from the private-bus owner reply',()=>{
  expect(secretServicePid('method return sender=org.freedesktop.DBus\n   uint32 741\n')).toBe(741);
  for(const bad of ['uint32 741','method return x\n uint32 0','method return x\n uint32 0741','method return x\n uint32 2147483648','method return x\n uint32 741\n uint32 742','error x\n uint32 741'])expect(()=>secretServicePid(bad)).toThrow();
});
it('observes credential identity/count through object-path metadata without accepting a secret payload',()=>{
  const header='method return sender=org.freedesktop.secrets\n';
  expect(credentialItemPaths(header+' array [ ]\n array [ ]')).toEqual([]);
  const item='/org/freedesktop/secrets/collection/login/1';
  expect(credentialItemPaths(header+` array [ object path "${item}" ]\n array [ ]`)).toEqual([item]);
  for(const body of [`array [ object path "${item}" object path "${item}" ] array []`,'array [ object path "/foreign" ] array []',`array [ object path "${item}/" ] array []`,`array [ object path "${item.replace('/login/','/login//')}" ] array []`,'array [] array [] string "private value"','array []','array [ array [','array [ ] ] array [ ]','] array [ ] array [','x'.repeat(4097)])expect(()=>credentialItemPaths(header+body)).toThrow();
});

it('requires an explicit protected prepared Secret Service image without executing it',async()=>{
  const directory=await mkdtemp('/tmp/lazysh-native-tool-policy-'),image=join(directory,'gnome-keyring-daemon');
  try {
    await expect(executable('','disposable Secret Service','gnome-keyring-daemon')).rejects.toThrow('absolute path');
    await writeFile(image,'owned admission bytes only',{mode:0o500});
    expect(await executable(image,'disposable Secret Service','gnome-keyring-daemon')).toBe(image);
    await chmod(image,0o777);
    await expect(executable(image,'disposable Secret Service','gnome-keyring-daemon')).rejects.toThrow('Untrusted');
    await chmod(image,0o500);
    await expect(executable(image,'disposable Secret Service','other-daemon')).rejects.toThrow('Untrusted');
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('rejects provided OpenCode manifests before target setup unless both actual captures and source bind exactly',async()=>{
  const {nativeOpenCodeManifest,openCodeNativeCapturePins}=await import('../../native-e2e/policy');
  const source='a'.repeat(40),version='1.10.0';
  const valid={schemaVersion:1,source,clientSha256:'b'.repeat(64),companion:{path:'/owned/companion',sha256:'c'.repeat(64),version},captures:openCodeNativeCapturePins.map(pin=>({version:pin.version,sessionId:String(pin.sessionId),database:{path:`/owned/${pin.version}/opencode.db`,sha256:String(pin.databaseSha256)},groundTruth:{path:`/owned/${pin.version}/conversation.json`,sha256:String(pin.groundTruthSha256)}}))};
  expect(nativeOpenCodeManifest(valid,source,version)).toBe(valid);
  const changed=()=>structuredClone(valid);
  const badSource=changed();badSource.source='d'.repeat(40);
  const badVersion=changed();badVersion.companion.version='1.9.10';
  const wrongHash=changed();wrongHash.captures[0].database.sha256='e'.repeat(64);
  const inventedTruth=changed();inventedTruth.captures[1].groundTruth.sha256='f'.repeat(64);
  const wrongSession=changed();wrongSession.captures[1].sessionId='ses_foreign';
  const relative=changed();relative.companion.path='relative';
  const normalized=changed();normalized.captures[0].database.path='/owned/../foreign/opencode.db';
  const control=changed();control.captures[0].groundTruth.path='/owned/\nprivate';
  for(const input of [undefined,null,'',{},badSource,badVersion,wrongHash,inventedTruth,wrongSession,relative,normalized,control,
    {...valid,extra:'private'},{...valid,captures:[valid.captures[0]]},{...valid,captures:[...valid.captures].reverse()},
    {...valid,clientSha256:'x'.repeat(65536)},Object.defineProperty({...valid},'captures',{enumerable:true,get(){throw Error('private');}})])
    expect(()=>nativeOpenCodeManifest(input,source,version)).toThrow('Invalid owned OpenCode native manifest');
  expect(()=>nativeOpenCodeManifest(valid,'',version)).toThrow();
});

it('compares fixed plain-paragraph OpenCode captures with rendered Markdown while retaining all interior text',async()=>{
  const {nativeOpenCodeParagraphText}=await import('../../native-e2e/policy');
  const paragraph=(raw:string)=>{
    const {JSDOM}=createRequire(import.meta.url)('jsdom');
    const document:Document=new JSDOM(renderToStaticMarkup(createElement(Markdown,null,raw))).window.document;
    expect(document.body.children).toHaveLength(1);expect(document.querySelectorAll('p')).toHaveLength(1);
    return document.querySelector('p')!.textContent;
  };
  for(const raw of ['Owned prompt.','Owned reply.','Owned line one\nOwned line two\n'])
    expect(paragraph(raw)).toBe(nativeOpenCodeParagraphText(raw));
  const original='Owned line one\nOwned line two\n',rendered=paragraph(original);
  expect(nativeOpenCodeParagraphText(original)).toBe('Owned line one\nOwned line two');
  for(const changed of [original.replace('one','other'),original+'\n',original.replace('\n',' '),original+' '])
    expect(nativeOpenCodeParagraphText(changed)).not.toBe(rendered);
});
