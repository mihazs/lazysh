import {expect,it} from 'vitest';
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
