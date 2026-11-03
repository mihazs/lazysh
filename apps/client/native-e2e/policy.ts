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

// Immutable, actually produced owned OpenCode captures; no CLI is executed by this lane.
export const openCodeNativeCapturePins=[
  {version:'1.19.5',sessionId:'ses_e6023d470ffesdNykvfQWhjWzF',databaseSha256:'2143e7e66e9e96ca35f00865b08518fd85e62b5c9a8ff663b5eeead03afff127',groundTruthSha256:'07129ad3b5dc9b321efe99aad9390981c0b26fc7333ccaf5dbfab16fa0faa581'},
  {version:'2.2.5',sessionId:'ses_e6023cde7ffejxVoGVBgWFN37Q',databaseSha256:'d1179953d4cb0e3755fde6a870d6af65e242cef9a135d1cbad7245c48b636836',groundTruthSha256:'64aab42aff9acfde6aea736212e3c0cef8638b2ffe860b46b451af707a2740c7'},
] as const;
type NativeRecord={path:string;sha256:string};
type NativeOpenCodeManifest={schemaVersion:1;source:string;clientSha256:string;companion:NativeRecord&{version:string};captures:{version:string;sessionId:string;database:NativeRecord;groundTruth:NativeRecord}[]};
export function nativeOpenCodeManifest(input:unknown,source:string,version:string):NativeOpenCodeManifest {
  const reject=()=>{throw new Error('Invalid owned OpenCode native manifest');};
  const shape=(value:unknown,keys:string[]):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
  const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const record=(value:unknown)=>shape(value,['path','sha256'])&&typeof value.path==='string'&&path.isAbsolute(value.path)&&path.normalize(value.path)===value.path&&value.path.length<=4096&&!/[\x00-\x1f\x7f]/.test(value.path)&&hash(value.sha256);
  try {
    if(!/^[a-f0-9]{40}$/.test(source)||!/^\d+\.\d+\.\d+$/.test(version)||!shape(input,['schemaVersion','source','clientSha256','companion','captures'])||input.schemaVersion!==1||input.source!==source||!hash(input.clientSha256))return reject();
    if(!shape(input.companion,['path','sha256','version'])||input.companion.version!==version||!record({path:input.companion.path,sha256:input.companion.sha256})||!Array.isArray(input.captures)||input.captures.length!==2)return reject();
    for(const [index,capture]of input.captures.entries()) {
      const expected=openCodeNativeCapturePins[index];
      if(!shape(capture,['version','sessionId','database','groundTruth'])||capture.version!==expected.version||capture.sessionId!==expected.sessionId||!record(capture.database)||!record(capture.groundTruth))return reject();
      if((capture.database as NativeRecord).sha256!==expected.databaseSha256||(capture.groundTruth as NativeRecord).sha256!==expected.groundTruthSha256)return reject();
    }
    return input as unknown as NativeOpenCodeManifest;
  }catch{return reject();}
}

// UI projection for the fixed-hash plain-paragraph captures only; raw companion checks stay exact.
export function nativeOpenCodeParagraphText(text:string):string {return text.endsWith('\n')?text.slice(0,-1):text;}
