// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {groupTurns,parseTranscript} from './ChatPanel';

const page={schemaVersion:2,agent:'claude',view:'active_branch',nextOffset:123,hasMore:false,truncated:false,branchId:'root',messages:[
  {id:'prompt',rev:0,role:'user',source:'transcript',parts:[{type:'text',text:'Fix it'}]},
  {id:'answer',parentId:'prompt',rev:42,role:'assistant',source:'transcript',parts:[
    {type:'tool',name:'Bash',summary:'Bash',status:'ok',input:'{"command":"true"}',result:'done',call:{kind:'execute',command:'true',exitCode:0}},
    {type:'tool',name:'Edit',summary:'Edit',status:'ok',input:'{}',result:'done',call:{kind:'edit',path:'file.rs',added:1,removed:1,hunks:['@@ -1 +1 @@\n-old\n+new'],created:false}},
    {type:'tool',name:'TodoWrite',summary:'TodoWrite',status:'ok',input:'{}',result:'done',call:{kind:'plan',items:[{text:'Fix it',state:'done'}]}},
    {type:'tool',name:'AskUserQuestion',summary:'AskUserQuestion',status:'ok',input:'{}',result:'yes',call:{kind:'question',questions:[{text:'Proceed?',multiple:false,options:[{label:'Yes'}]}]}},
    {type:'tool',name:'Read',summary:'Read',status:'ok',input:'{}',result:'source',call:{kind:'read',path:'file.rs'}},
    {type:'tool',name:'WebSearch',summary:'WebSearch',status:'ok',input:'{}',result:'found',call:{kind:'search',query:'term'}},
    {type:'tool',name:'WebFetch',summary:'WebFetch',status:'ok',input:'{}',result:'body',call:{kind:'fetch',url:'https://example.test/'}},
    {type:'tool',name:'Agent',summary:'Agent',status:'ok',input:'{}',result:'done',call:{kind:'task',agent:'worker',agentId:'child',ongoing:false}},
    {type:'tool',name:'custom',summary:'custom',status:'denied',input:'{}',result:'reason',call:{kind:'other'}},
    {type:'text',text:'Unmatched call: {}'},
  ]},
]};

it('adapts companion schema 2 tools and preserves plan and question receipts',()=>{
  const parsed=parseTranscript(page);const blocks=parsed.messages[1].blocks;
  expect(blocks[0].agentTool?.call?.kind).toBe('execute');expect(blocks[1].agentTool?.call?.kind).toBe('edit');
  expect(blocks[2].card).toEqual({kind:'plan',entries:[{text:'Fix it',status:'completed'}],explanation:undefined});
  expect(blocks[3].card?.kind).toBe('question');expect(blocks[8].agentTool?.status).toBe('denied');
  expect(blocks[9].text).toBe('Unmatched call: {}');
});

it('keeps partial unmatched calls in activity instead of presenting them as an answer',()=>{
  const parsed=parseTranscript({...page,messages:[page.messages[0],{id:'pending',rev:10,role:'assistant',source:'transcript',partial:true,parts:[{type:'text',text:'Bash: pending'}]}]});
  expect(parsed.messages[1].partial).toBe(true);
  expect(groupTurns(parsed.messages)[0].answer).toBeUndefined();
  expect(groupTurns(parsed.messages)[0].activity[0].id).toBe('pending');
});

it('rejects unproven revisions, malformed tool kinds and schema 1 card injection',()=>{
  for(const value of [
    {...page,messages:[{...page.messages[0],rev:-1}]},
    {...page,agent:'opencode'},
    {...page,messages:[page.messages[0],page.messages[0]]},
    {...page,messages:[{...page.messages[1],parts:[{type:'tool',name:'X',summary:'X',status:'ok',call:{kind:'unknown'}}]}]},
    {schemaVersion:1,agent:'claude',messages:[{id:'x',role:'assistant',blocks:[{type:'text',text:'x',agentTool:{}}]}],nextOffset:0,hasMore:false},
  ]) expect(()=>parseTranscript(value)).toThrow();
});

it('validates a bounded historical event envelope separately from messages',()=>{
  const history={version:1,events:['started','completed','completed','interrupted'],truncated:false};
  const v3={...page,schemaVersion:3,agent:'codex',historicalActivity:history};
  expect(parseTranscript(v3).historicalActivity).toEqual(history);
  for(const invalid of [{...history,events:['future']},{...history,events:Array(51).fill('completed')},{...history,version:2}])
    expect(()=>parseTranscript({...v3,historicalActivity:invalid})).toThrow();
  expect(()=>parseTranscript({...page,historicalActivity:history})).toThrow();
});
