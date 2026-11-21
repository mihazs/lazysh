// @vitest-environment jsdom
import {expect,it} from 'vitest';
import type {XtermTerminalAdapter} from '../xtermTerminalAdapter';
import {fixtureAdapter,fixtureFile,type FixtureCase} from './fixtureAdapter';

/** The fixture the Rust core replays (`packages/terminal-runtime/tests/read_rows.rs`): bytes plus the rows xterm.js 5.5.0 reads. */
type Query={first:number;count:number;columns?:[number,number];rows:string[]};
type Case=FixtureCase&{queries:Query[]};

/** What `XtermTerminalAdapter.readRows` returns for a query. */
const read=(adapter:XtermTerminalAdapter,{first,count,columns}:Query)=>adapter.readRows(first,count,columns&&{start:columns[0],end:columns[1]});

it('records what the xterm backend reads, row by row, for the cases the native core must match (UPDATE_READ_ROWS=1 rewrites them)',async()=>{
  const fixture=fixtureFile<Case>('read-rows');
  for(const c of fixture.cases) {
    const adapter=await fixtureAdapter(c);
    for(const query of c.queries) {
      if(process.env.UPDATE_READ_ROWS)query.rows=read(adapter,query);
      expect(read(adapter,query),`${c.id} rows ${query.first}+${query.count} columns ${query.columns}`).toEqual(query.rows);
    }
  }
  if(process.env.UPDATE_READ_ROWS)fixture.save();
});
