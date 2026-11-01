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
