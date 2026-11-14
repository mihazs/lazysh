// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Terminal} from '@xterm/xterm';
import {XtermTerminalAdapter} from '../xtermTerminalAdapter';

/** The fixture the Rust core replays (`packages/terminal-runtime/tests/read_rows.rs`): bytes plus the rows xterm.js 5.5.0 reads. */
// jsdom rewrites import.meta.url, so the path is relative to the package (vitest runs from apps/client).
const path=resolve(process.cwd(),'../../packages/terminal-runtime/fixtures/read-rows.json');
type Query={first:number;count:number;columns?:[number,number];rows:string[]};
type Case={id:string;cols:number;rows:number;scrollback:number;write:string;queries:Query[]};

/** What `XtermTerminalAdapter.readRows` returns for a query. */
const read=(adapter:XtermTerminalAdapter,{first,count,columns}:Query)=>adapter.readRows(first,count,columns&&{start:columns[0],end:columns[1]});

it('records what the xterm backend reads, row by row, for the cases the native core must match (UPDATE_READ_ROWS=1 rewrites them)',async()=>{
  const data=JSON.parse(readFileSync(path,'utf8')) as {cases:Case[]};
  for(const c of data.cases) {
    const terminal=new Terminal({cols:c.cols,rows:c.rows,scrollback:c.scrollback,allowProposedApi:false});
    await new Promise<void>(resolve=>terminal.write(c.write,resolve));
    const adapter=new XtermTerminalAdapter(terminal);
    for(const query of c.queries) {
      if(process.env.UPDATE_READ_ROWS)query.rows=read(adapter,query);
      expect(read(adapter,query),`${c.id} rows ${query.first}+${query.count} columns ${query.columns}`).toEqual(query.rows);
    }
  }
  if(process.env.UPDATE_READ_ROWS)writeFileSync(path,JSON.stringify(data,null,1)+'\n');
});
