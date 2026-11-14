import {readdirSync,readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {parseTranscript} from './ChatPanel';
it('real pages parse',()=>{
  const dir='/home/mihazs/.cache/tmp/claude-1000/-home-mihazs-dev-lazysh/64caf04f-4e1a-4ff1-abc5-df5cb7e4346c/scratchpad/pages';
  const failures:Record<string,string[]>={};
  let total=0;
  for(const name of readdirSync(dir)){
    total++;
    try{parseTranscript(JSON.parse(readFileSync(dir+'/'+name,'utf8')));}
    catch(e){const key=String((e as {key?:string}).key??(e as Error).message);(failures[key]??=[]).push(name);}
  }
  console.log('TOTAL',total,JSON.stringify(Object.fromEntries(Object.entries(failures).map(([k,v])=>[k,[v.length,v.slice(0,3)]]))));
  expect(Object.keys(failures)).toEqual([]);
});
