import {appendFileSync} from 'node:fs'; const log=(...a:unknown[])=>appendFileSync('/home/mihazs/.cache/tmp/claude-1000/-home-mihazs-dev-lazysh/64caf04f-4e1a-4ff1-abc5-df5cb7e4346c/scratchpad/bisect.txt',a.join(' ')+'\n');
import {readFileSync} from 'node:fs';
import {it} from 'vitest';
import {parseTranscript} from './ChatPanel';
it('bisect',()=>{
  const page=JSON.parse(readFileSync('/home/mihazs/.cache/tmp/claude-1000/-home-mihazs-dev-lazysh/64caf04f-4e1a-4ff1-abc5-df5cb7e4346c/scratchpad/pages/codex-105-tail.json','utf8'));
  for(const m of page.messages){
    try{parseTranscript({...page,messages:[m],activity:undefined,queued:undefined,work:undefined,session:undefined});}
    catch(e){log('BAD',(e as {key?:string}).key,JSON.stringify(m).slice(0,300), Object.keys(m));break;}
  }
  log('keys',Object.keys(page), JSON.stringify(page.activity), JSON.stringify(page.work)?.slice(0,200), JSON.stringify(page.queued)?.slice(0,100), JSON.stringify(page.session)?.slice(0,200));
  for(const k of ['activity','queued','work','session']){
    try{parseTranscript({...page,messages:[],activity:k==='activity'?page.activity:undefined,queued:k==='queued'?page.queued:undefined,work:k==='work'?page.work:undefined,session:k==='session'?page.session:undefined});log('ok',k);}
    catch(e){log('FAIL',k,(e as {key?:string}).key);}
  }
});
