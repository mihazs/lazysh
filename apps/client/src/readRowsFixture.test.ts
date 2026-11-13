import {expect,it} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {Terminal} from '@xterm/xterm';

/** The fixture the Rust core replays (`packages/terminal-runtime/tests/read_rows.rs`): bytes plus the rows xterm.js 5.5.0 reads. */
const path=new URL('../../../packages/terminal-runtime/fixtures/read-rows.json',import.meta.url);
type Query={first:number;count:number;columns?:[number,number];rows:string[]};
type Case={id:string;cols:number;rows:number;scrollback:number;write:string;queries:Query[]};

/** What `XtermTerminalAdapter.readRows` returns for a query. */
function read(terminal:Terminal,{first,count,columns}:Query) {
  const buffer=terminal.buffer.active;
  return Array.from({length:count},(_,i)=>buffer.getLine(first+i)?.translateToString(true,columns?.[0],columns?.[1])?.trimEnd()??'');
}

it('records what the xterm backend reads, row by row, for the cases the native core must match (UPDATE_READ_ROWS=1 rewrites them)',async()=>{
  const data=JSON.parse(readFileSync(path,'utf8')) as {cases:Case[]};
  for(const c of data.cases) {
    const terminal=new Terminal({cols:c.cols,rows:c.rows,scrollback:c.scrollback,allowProposedApi:false});
    await new Promise<void>(resolve=>terminal.write(c.write,resolve));
    for(const query of c.queries) {
      if(process.env.UPDATE_READ_ROWS)query.rows=read(terminal,query);
      expect(read(terminal,query),`${c.id} rows ${query.first}+${query.count} columns ${query.columns}`).toEqual(query.rows);
    }
  }
  if(process.env.UPDATE_READ_ROWS)writeFileSync(path,JSON.stringify(data,null,1)+'\n');
});
