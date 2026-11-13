// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {writeFileSync} from 'node:fs';
import {findPaths,findUrls} from '../terminalLinks';
import {fixtureFile,fixtureTerminal,type FixtureCase} from './fixtureAdapter';

/** The fixture the Rust core replays (`packages/terminal-runtime/tests/links.rs`): bytes, and what `findUrls` and `findPaths` find on every row of the buffer xterm.js 5.5.0 builds from them. */
type Pair=[number,number];
/** A link once, with every row it is reported on (a wrapped URL is found on each of its rows); cells are 0-based and inclusive, so the core and this file speak the same units. */
type Link={text:string;start:Pair;end:Pair;path?:string;line:number|null;column:number|null;rows:number[]};
/** A list that is empty is left out of the file, which keeps the cases short and distinct. */
type Case=FixtureCase&{urls?:Link[];paths?:Link[]};
const cell=(point:{x:number;y:number}):Pair=>[point.x-1,point.y-1];

/** Folds per-row results into links in reading order, each with its rows. */
function fold(perRow:Omit<Link,'rows'>[][]):Link[] {
  const links=new Map<string,Link>();
  perRow.forEach((found,row)=>found.forEach(link=>{
    const key=JSON.stringify(link);
    links.set(key,{...link,rows:[...links.get(key)?.rows??[],row]});
  }));
  return [...links.values()].sort((a,b)=>a.start[1]-b.start[1]||a.start[0]-b.start[0]||a.rows[0]-b.rows[0]);
}

it('records the URLs and host paths the xterm backend finds on every row, for the cases the native core must match (UPDATE_LINKS=1 rewrites them)',async()=>{
  const {path,cases}=fixtureFile<Case>('links');
  for(const c of cases) {
    const buffer=(await fixtureTerminal(c)).buffer.active,lines=Array.from({length:buffer.length},(_,i)=>i+1);
    const urls=fold(lines.map(line=>findUrls(buffer,c.cols,line).map(link=>({text:link.text,start:cell(link.range.start),end:cell(link.range.end),line:null,column:null}))));
    const paths=fold(lines.map(line=>findPaths(buffer,c.cols,line).map(link=>({text:link.text,path:link.path,start:cell(link.range.start),end:cell(link.range.end),line:link.line??null,column:link.column??null}))));
    if(process.env.UPDATE_LINKS) {c.urls=urls;c.paths=paths;}
    expect(urls,`${c.id}: urls`).toEqual(c.urls??[]);
    expect(paths,`${c.id}: paths`).toEqual(c.paths??[]);
  }
  if(process.env.UPDATE_LINKS) {
    const list=(name:string,links:Link[]|undefined)=>links?.length?[`"${name}":[\n${links.map(link=>JSON.stringify(link)).join(',\n')}\n]`]:[];
    writeFileSync(path,`{"cases":[\n${cases.map(({urls,paths,...rest})=>`{${[JSON.stringify(rest).slice(1,-1),...list('urls',urls),...list('paths',paths)].join(',\n')}}`).join(',\n')}\n]}\n`);
  }
});
