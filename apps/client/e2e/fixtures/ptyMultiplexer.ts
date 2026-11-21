import {expect,type Page} from '@playwright/test';
import {spawn,spawnSync,type ChildProcess,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';

declare global {interface Window {ptyClientInput:(data:string)=>Promise<void>}}

/** Whether util-linux `script` (the PTY every real multiplexer client here runs in) is on PATH. */
export const hasScript=spawnSync('script',['--version']).status===0;

export const shellQuote=(text:string)=>`'${text.replaceAll("'","'\\''")}'`;

/** The test process's environment without any multiplexer's own variables, so a client never reaches the developer's live server. */
export function ownedEnv(extra:Record<string,string>) {
  const env:Record<string,string|undefined>={...process.env,TERM:'xterm-256color'};
  for(const name of Object.keys(env))if(/^(HERDR|ZELLIJ|TMUX)/.test(name))delete env[name];
  return {...env,...extra};
}

/** Stops `child` and resolves once it has exited, so nothing it writes while shutting down lands in a directory already removed. */
export async function stop(child:ChildProcess) {
  if(child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.kill();
  await exited;
}

/** A private directory holding the pane program a multiplexer starts: `body` runs, then the pane sleeps. `release()` creates the file a body can wait for. */
export function ownedPane(prefix:string,body:(go:string)=>string) {
  const root=mkdtempSync(join(tmpdir(),prefix)),go=join(root,'go'),script=join(root,'pane.sh');
  writeFileSync(script,`#!/bin/sh\n${body(shellQuote(go))}\nexec sleep 600\n`,{mode:0o755});
  return {root,script,release:()=>writeFileSync(go,''),remove:()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})};
}

/** Runs `command` as a 80x24 terminal client in a PTY and shows its bytes in lazysh's terminal pane; bytes lazysh would type reach the client. */
export async function attachPtyClient(page:Page,command:string,env:Record<string,string|undefined>) {
  // `script -c` runs its command through $SHELL; the client's own shell setting must not replace the client.
  const client:ChildProcessWithoutNullStreams=spawn('script',['-qfec',`stty cols 80 rows 24; exec ${command}`,'/dev/null'],{env:{...env,SHELL:'/bin/sh'}});
  const decoder=new StringDecoder('utf8');
  await page.exposeFunction('ptyClientInput',(data:string)=>{client.stdin.write(data);});
  await page.evaluate(()=>{window.simpleShortcutInput=data=>void window.ptyClientInput(data);});
  client.stdout.on('data',(chunk:Buffer)=>{const text=decoder.write(chunk);if(text)void page.evaluate(text=>window.simpleShortcutOutput(text),text).catch(()=>{});});
  return {write:(data:string)=>{client.stdin.write(data);},stop:()=>stop(client)};
}

/** Drags the mouse across the one row showing `text`, as a terminal reports it (SGR) to a multiplexer that tracks the mouse. `endsInclusive`: whether the cell of the release belongs to the selection. */
export async function selectWithMouse(page:Page,client:{write:(data:string)=>void},text:string,endsInclusive:boolean) {
  const find=async()=>(await page.locator('.terminal-canvas:visible .xterm-rows > div').allTextContents()).flatMap((line,row)=>line.includes(text)?[{row,column:line.indexOf(text)}]:[]);
  // A multiplexer can still be laying out its frame (sidebars, borders) when the text first shows; use the cells once they stop moving.
  let matches=await find(),previous='';
  await expect.poll(async()=>{matches=await find();const same=JSON.stringify(matches)===previous;previous=JSON.stringify(matches);return same;},{intervals:[250]}).toBe(true);
  expect(matches,`exactly one rendered row shows ${text}`).toHaveLength(1);
  const {row,column}=matches[0]!,y=row+1,first=column+1,last=column+text.length;
  client.write(`\x1b[<0;${first};${y}M\x1b[<32;${last};${y}M\x1b[<0;${endsInclusive?last:last+1};${y}m`);
}

/** The consent prompt shows `text`, leaves the device clipboard alone until Allow, then Allow writes it. */
export async function allowRemoteCopy(page:Page,text:string) {
  const region=page.getByRole('region',{name:'Remote clipboard request',exact:true});
  await expect(region).toContainText(text);
  expect(await page.evaluate(()=>navigator.clipboard.readText())).not.toBe(text);
  await region.getByRole('button',{name:'Allow this copy',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(text);
}
