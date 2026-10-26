import {expect,it} from 'vitest';
import {recordedReceipt,validateRecordedPage} from './recordedFollow';
import {grokFollowPage,grokReceipt} from './test/recordedFollowData';

it('requires canonical bounded receipts and exact page cursors',()=>{
  expect(recordedReceipt(grokReceipt(0))).toMatchObject({offset:0,length:0});
  for (const token of [undefined,'',grokReceipt(1,0),grokReceipt(0,16777217),grokReceipt(0)+'\n',
    grokReceipt(0).replace(':0:',':00:'),grokReceipt(0).replace('g1','v1'),grokReceipt(0).replace('a','A')])
    expect(()=>recordedReceipt(token)).toThrow();
  for (const page of [{...grokFollowPage(),checkpoint:undefined},{...grokFollowPage(),agent:'claude'},
    {...grokFollowPage(),view:'active_branch'},{...grokFollowPage(),nextOffset:11}])
    expect(()=>validateRecordedPage(page,0)).toThrow();
});

it('allows EOF and unfinished tails while rejecting regression, silent rows and source/prefix changes',()=>{
  const old=grokReceipt(10,20);
  expect(()=>validateRecordedPage(grokFollowPage(10,20,''),10,old)).not.toThrow();
  expect(()=>validateRecordedPage(grokFollowPage(10,21,'','c'),10,old)).not.toThrow();
  expect(()=>validateRecordedPage(grokFollowPage(22,22,'appended','c'),10,old)).not.toThrow();
  for (const page of [grokFollowPage(9,20,''),grokFollowPage(10,20,'forbidden'),{...grokFollowPage(10,20,''),hasMore:true},
    grokFollowPage(10,19,''),grokFollowPage(10,20,'','c'),
    {...grokFollowPage(10,20,''),checkpoint:grokReceipt(10,20,'a','c')}])
    expect(()=>validateRecordedPage(page,10,old)).toThrow();
  expect(()=>validateRecordedPage(grokFollowPage(10,20,''),9,old)).toThrow();
});

it('requires canonical unique increasing physical IDs inside the current consumed byte range',()=>{
  const page=grokFollowPage(30,30,'new records','c');
  const row=(id:string)=>({...page.messages[0],id});
  expect(()=>validateRecordedPage({...page,messages:[row('grok-record-10'),row('grok-record-29')]},10,grokReceipt(10))).not.toThrow();
  for(const ids of [
    ['grok-record-0'],['grok-record-30'],['grok-record-010'],['grok-record-10\n'],
    ['grok-record-10','grok-record-10'],['grok-record-20','grok-record-10'],
    ['row-10'],['grok-record-1e1'],['grok-record-100000000'],
  ]) expect(()=>validateRecordedPage({...page,messages:ids.map(row)},10,grokReceipt(10))).toThrow();
});
