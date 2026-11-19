import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Terminal} from '@xterm/xterm';
import {XtermTerminalAdapter} from '../xtermTerminalAdapter';

/** A recorded case of a cross-engine fixture (`packages/terminal-runtime/fixtures`): a terminal size and the bytes to feed it. */
export type FixtureCase={id:string;cols:number;rows:number;scrollback:number;write:string};

/** One fixture file, which the Rust core replays too. jsdom rewrites import.meta.url, so the path is relative to the package (vitest runs from apps/client). */
export function fixtureFile<C extends FixtureCase>(name:string) {
  const path=resolve(process.cwd(),`../../packages/terminal-runtime/fixtures/${name}.json`);
  const data=JSON.parse(readFileSync(path,'utf8')) as {cases:C[]};
  return {path,cases:data.cases,save:()=>writeFileSync(path,JSON.stringify(data,null,1)+'\n')};
}

/** The xterm.js 5.5.0 terminal a fixture case describes, with its bytes applied. `open` mounts it (selection needs the DOM part of xterm, here jsdom's). */
export async function fixtureTerminal(c:FixtureCase,open=false) {
  const terminal=new Terminal({cols:c.cols,rows:c.rows,scrollback:c.scrollback,allowProposedApi:false});
  if(open) {
    window.matchMedia??=(media:string)=>({matches:false,media,onchange:null,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){},dispatchEvent:()=>false}) as MediaQueryList;
    terminal.open(document.body.appendChild(document.createElement('div')));
  }
  await new Promise<void>(resolve=>terminal.write(c.write,resolve));
  return terminal;
}

/** What a fixture case looks like through the xterm backend's adapter, the way the app reads it. */
export const fixtureAdapter=async(c:FixtureCase,open=false)=>new XtermTerminalAdapter(await fixtureTerminal(c,open));
