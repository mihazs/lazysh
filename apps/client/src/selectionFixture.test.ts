// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Terminal} from '@xterm/xterm';
import {selectTerminalRange,terminalWordAt} from './terminalTouchSelection';

/** The fixture the Rust core replays (`packages/terminal-runtime/tests/selection.rs`): bytes, questions, and the answers of the xterm.js 5.5.0 code lazysh uses today. */
// jsdom rewrites import.meta.url, so the path is relative to the package (vitest runs from apps/client).
const path=resolve(process.cwd(),'../../packages/terminal-runtime/fixtures/selection.json');
type Pair=[number,number];
type Case={id:string;cols:number;rows:number;scrollback:number;write:string;
  selections:{start:Pair;end:Pair;text:string}[];words:{at:Pair;range:Pair[]}[];all:string;screen:string;
  searches:{query:string;direction:1|-1;from:number|null;hit:{row:number;column:number;length:number}|null}[]};

/** `TerminalPane.search`, from a given row: the same loop over rows, wrapping, case-folded `indexOf`. */
function search(terminal:Terminal,query:string,direction:1|-1,from:number|null) {
  const buffer=terminal.buffer.active;
  if(!query)return null;
  const start=from===null||from<0?(direction>0?-1:buffer.length):from;
  for(let offset=1;offset<=buffer.length;offset++) {
    const row=(start+offset*direction+buffer.length*2)%buffer.length;
    const text=buffer.getLine(row)?.translateToString(true)??'';
    const column=text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    if(column>=0)return {row,column,length:text.length};
  }
  return null;
}

it('records what the xterm backend selects, copies and finds, for the cases the native core must match (UPDATE_SELECTION=1 rewrites them)',async()=>{
  const data=JSON.parse(readFileSync(path,'utf8')) as {cases:Case[]};
  const update=!!process.env.UPDATE_SELECTION;
  for(const c of data.cases) {
    const terminal=new Terminal({cols:c.cols,rows:c.rows,scrollback:c.scrollback,allowProposedApi:false});
    // Selection lives in the DOM-bound part of xterm, so the terminal is opened (jsdom, DOM renderer).
    window.matchMedia??=(media:string)=>({matches:false,media,onchange:null,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){},dispatchEvent:()=>false}) as MediaQueryList;
    terminal.open(document.body.appendChild(document.createElement('div')));
    await new Promise<void>(resolve=>terminal.write(c.write,resolve));
    const why=(what:string)=>`${c.id}: ${what}`;
    for(const s of c.selections) {
      selectTerminalRange(terminal,{start:{x:s.start[0],y:s.start[1]},end:{x:s.end[0],y:s.end[1]}});
      if(update)s.text=terminal.getSelection();
      expect(terminal.getSelection(),why(`select ${s.start}-${s.end}`)).toBe(s.text);
    }
    for(const w of c.words) {
      const {start,end}=terminalWordAt(terminal,{x:w.at[0],y:w.at[1]});
      if(update)w.range=[[start.x,start.y],[end.x,end.y]];
      expect([[start.x,start.y],[end.x,end.y]],why(`word at ${w.at}`)).toEqual(w.range);
    }
    terminal.selectAll();
    if(update)c.all=terminal.getSelection();
    expect(terminal.getSelection(),why('select all')).toBe(c.all);
    terminal.select(0,terminal.buffer.active.viewportY,terminal.rows*terminal.cols);
    if(update)c.screen=terminal.getSelection();
    expect(terminal.getSelection(),why('copy screen')).toBe(c.screen);
    for(const q of c.searches) {
      if(update)q.hit=search(terminal,q.query,q.direction,q.from);
      expect(search(terminal,q.query,q.direction,q.from),why(`search ${JSON.stringify(q.query)} ${q.direction} from ${q.from}`)).toEqual(q.hit);
    }
  }
  if(update)writeFileSync(path,JSON.stringify(data,null,1)+'\n');
});
