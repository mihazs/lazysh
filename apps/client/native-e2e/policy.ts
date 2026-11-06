import {posix as path} from 'node:path';

export function assertDirectDriverEnvironment(env:NodeJS.ProcessEnv) {
  if(Object.keys(env).some(key=>/^(?:(?:https?|all)_proxy|node_use_env_proxy)$/i.test(key)&&env[key]))throw new Error('Native GUI requires a direct loopback WebDriver client without proxy environment');
}

export function guiEnvironment(directory:string,bus:string,display?:number):NodeJS.ProcessEnv {
  if(!path.isAbsolute(directory) || !/^unix:path=\/[A-Za-z0-9_./-]+$/.test(bus) || bus!==`unix:path=${path.join(directory,'runtime/bus')}`
    || (display!==undefined && (!Number.isInteger(display) || display<1000 || display>9999)))throw new Error('Invalid owned GUI environment');
  return {
    PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',SHELL:'/bin/sh',GDK_BACKEND:'x11',
    HOME:path.join(directory,'home'),XDG_CONFIG_HOME:path.join(directory,'config'),XDG_CONFIG_DIRS:path.join(directory,'config'),
    XDG_DATA_HOME:path.join(directory,'data'),XDG_DATA_DIRS:path.join(directory,'data'),XDG_CACHE_HOME:path.join(directory,'cache'),
    XDG_RUNTIME_DIR:path.join(directory,'runtime'),TMPDIR:path.join(directory,'runtime'),
    GSETTINGS_SCHEMA_DIR:'/usr/share/glib-2.0/schemas',GSETTINGS_BACKEND:'memory',
    DBUS_SESSION_BUS_ADDRESS:bus,DBUS_SYSTEM_BUS_ADDRESS:bus,
    TAURI_WEBVIEW_AUTOMATION:'true',XAUTHORITY:path.join(directory,'authority'),
    ...(display===undefined?{}:{DISPLAY:`:${display}`}),
  };
}

export function listenerInode(table:string,port:number):string|undefined {
  if(!Number.isInteger(port)||port<1||port>65535||table.length>256*1024)throw new Error('Invalid owned GUI socket inventory');
  const expected=port.toString(16).padStart(4,'0').toUpperCase();
  const rows=table.split('\n').slice(1).map(line=>line.trim().split(/\s+/))
    .filter(fields=>fields[1]===`0100007F:${expected}` && fields[3]==='0A');
  if(rows.length>1)throw new Error('Ambiguous owned GUI listener');
  const value=rows[0]?.[9];
  return value && /^[1-9][0-9]*$/.test(value)?value:undefined;
}

export function namespaceArguments(program:string,args:string[],directory:string,home:string,socket:string,files:string[]):string[] {
  if([program,directory,home,socket,...files].some(value=>!path.isAbsolute(value)||value.includes('\0'))
    || !/^\/tmp\/\.X11-unix\/X[1-9][0-9]{3}$/.test(socket))throw new Error('Invalid owned GUI namespace paths');
  return ['--unshare-user','--unshare-pid','--die-with-parent','--new-session','--ro-bind','/','/',
    '--proc','/proc','--dev','/dev','--tmpfs',home,'--tmpfs','/run','--tmpfs','/tmp',
    '--dir','/tmp/.X11-unix','--bind',directory,directory,'--ro-bind',socket,socket,
    ...files.flatMap(file=>['--dir',path.dirname(file),'--ro-bind',file,file]),'--chdir',directory,'--',program,...args];
}
