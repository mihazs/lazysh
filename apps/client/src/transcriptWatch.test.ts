import {expect,it} from 'vitest';
import {createWatchApplier,parseWatchFrame} from './transcriptWatch';
import {parseTranscript} from './ChatPanel';

type Message={id:string;role:string;blocks:unknown[]};
const parse=(page:unknown)=>parseTranscript(page) as unknown as {messages:Message[];queued?:{text:string}[]};
const message=(id:string)=>({id,role:'user',blocks:[{type:'text',text:id}]});
const frame=(extra:Record<string,unknown>)=>parseWatchFrame<Message>({type:'delta',gen:1,seq:2,upserts:[],drops:[],...extra},'claude',parse);

it('hands the queue of a snapshot and of a delta that changed it to the caller, and nothing for a delta that did not',()=>{
  const apply=createWatchApplier<Message>();
  const snapshot=parseWatchFrame<Message>({type:'snapshot',gen:1,seq:1,entries:[{id:'a',rev:1,message:message('a')}],queued:[{text:'one'}]},'claude',parse);
  expect(apply(snapshot)).toMatchObject({kind:'replace',queued:[{text:'one'}]});
  expect(apply(frame({seq:2,queued:[{text:'one'},{text:'two'}]}))).toMatchObject({kind:'patch',queued:[{text:'one'},{text:'two'}]});
  expect(apply(frame({seq:3}))).not.toHaveProperty('queued',expect.anything());
  expect(apply(frame({seq:4,queued:[]}))).toMatchObject({kind:'patch',queued:[]});
});

it('drops malformed queue entries instead of failing the stream',()=>{
  const op=createWatchApplier<Message>()(parseWatchFrame<Message>({type:'snapshot',gen:1,seq:1,entries:[],queued:[null,{text:5},{text:'ok'}]},'claude',parse));
  expect(op).toMatchObject({kind:'replace',queued:[{text:'ok'}]});
});
