import {expect,it} from 'vitest';
import {parseTranscript,groupTurns} from './ChatPanel';

const page=(messages:unknown[],agent='claude',view='active_branch')=>({schemaVersion:1,agent,view,messages,nextOffset:1,hasMore:false});
const goal={id:'e1',role:'event',blocks:[],event:{kind:'goal',text:'Merge every ready PR'}};

it('accepts the event messages of a Claude conversation and starts a new turn at each',()=>{
  const parsed=parseTranscript(page([{id:'p',role:'user',blocks:[{type:'text',text:'Go'}]},goal,{id:'a',role:'assistant',blocks:[{type:'text',text:'Done'}]}]));
  expect(parsed.messages.map(message=>message.role)).toEqual(['user','event','assistant']);
  expect(groupTurns(parsed.messages).map(turn=>[!!turn.prompt,!!turn.event])).toEqual([[true,false],[false,true]]);
});

it.each([
  ['an unknown kind',{...goal,event:{kind:'shout',text:'x'}}],
  ['blocks next to the event',{...goal,blocks:[{type:'text',text:'x'}]}],
  ['no event',{id:'e1',role:'event',blocks:[]}],
  ['an event on a user message',{id:'u',role:'user',blocks:[],event:{kind:'goal',text:'x'}}],
  ['an oversized detail',{...goal,event:{kind:'goal',text:'x',detail:'y'.repeat(5000)}}],
])('refuses %s',(_,message)=>{
  expect(()=>parseTranscript(page([message]))).toThrow();
});

it('accepts event messages of a Codex conversation but not of other agents or the records view',()=>{
  expect(parseTranscript(page([goal],'codex')).messages).toHaveLength(1);
  expect(()=>parseTranscript(page([goal],'gemini'))).toThrow();
  expect(()=>parseTranscript(page([goal],'claude','records'))).toThrow();
});

// The companion writes this event for a Codex `compacted` record and an OpenCode compaction; the page must not be refused for it.
it.each(['codex','opencode'])('shows the compaction line the companion writes for %s',agent=>{
  const compacted={id:'c1',role:'event',blocks:[],event:{kind:'compacted',text:''}};
  const extra=agent==='opencode'?{branchId:'ses_1',truncated:false,nextOffset:0}:{};
  expect(parseTranscript({...page([compacted],agent),...extra}).messages.map(message=>message.role)).toEqual(['event']);
});
