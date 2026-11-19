// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {fixtureAdapter,fixtureFile,type FixtureCase} from './fixtureAdapter';

/** The fixture the Rust core replays (`packages/terminal-runtime/tests/selection.rs`): bytes, questions, and the answers of the xterm.js 5.5.0 code lazysh uses today. */
type Pair=[number,number];
type Case=FixtureCase&{
  selections:{start:Pair;end:Pair;text:string}[];words:{at:Pair;range:Pair[]}[];all:string;screen:string;
  searches:{query:string;direction:1|-1;from:number|null;hit:{row:number;column:number;length:number}|null}[]};

it('records what the xterm backend selects, copies and finds, for the cases the native core must match (UPDATE_SELECTION=1 rewrites them)',async()=>{
  const fixture=fixtureFile<Case>('selection');
  const update=!!process.env.UPDATE_SELECTION;
  for(const c of fixture.cases) {
    // Selection lives in the DOM-bound part of xterm, so the terminal is opened.
    const adapter=await fixtureAdapter(c,true);
    const why=(what:string)=>`${c.id}: ${what}`;
    for(const s of c.selections) {
      adapter.select({start:{x:s.start[0],y:s.start[1]},end:{x:s.end[0],y:s.end[1]}});
      if(update)s.text=adapter.selectedText();
      expect(adapter.selectedText(),why(`select ${s.start}-${s.end}`)).toBe(s.text);
    }
    for(const w of c.words) {
      const {start,end}=adapter.selectWordAt({x:w.at[0],y:w.at[1]});
      if(update)w.range=[[start.x,start.y],[end.x,end.y]];
      expect([[start.x,start.y],[end.x,end.y]],why(`word at ${w.at}`)).toEqual(w.range);
    }
    adapter.selectAll();
    if(update)c.all=adapter.selectedText();
    expect(adapter.selectedText(),why('select all')).toBe(c.all);
    const {top,rows}=adapter.viewport();
    adapter.select({start:{x:0,y:top},end:{x:c.cols-1,y:top+rows-1}});
    if(update)c.screen=adapter.selectedText();
    expect(adapter.selectedText(),why('copy screen')).toBe(c.screen);
    for(const q of c.searches) {
      const hit=()=>adapter.search(q.query,q.direction,q.from??undefined)??null;
      if(update)q.hit=hit();
      expect(hit(),why(`search ${JSON.stringify(q.query)} ${q.direction} from ${q.from}`)).toEqual(q.hit);
    }
  }
  if(update)fixture.save();
});
