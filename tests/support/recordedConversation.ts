import {lstat, mkdir, readFile, stat, writeFile, chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {sshCommand, type SshFixture} from './sshFixture';
import {prepareRecordedCards,recordedPage} from './recordedCards';

export async function recordedCompanionBytes(path:string|undefined) {
  if(!path || !path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path))throw new Error('Explicit current-source recorded companion required');
  const before=await lstat(path);
  if(!before.isFile() || before.isSymbolicLink() || before.uid!==process.getuid!() || (before.mode&0o022)!==0 || !(before.mode&0o100) || before.size<1 || before.size>256*1024*1024)throw new Error('Untrusted recorded companion source');
  const bytes=await readFile(path),after=await lstat(path);
  if(bytes.length!==before.size || before.dev!==after.dev || before.ino!==after.ino || before.mtimeMs!==after.mtimeMs || before.size!==after.size)throw new Error('Recorded companion source changed');
  return bytes;
}
type RecordedMessage={id:string;role:string;text:string};
/** The Codex records of a paginated session: its header, then one completed item per message. */
export const codexRecords=(threadId:string,messages:RecordedMessage[],header=true):Record<string,unknown>[]=>[
  ...(header?[{type:'session_meta',payload:{id:threadId,history_mode:'paginated'}},{type:'event_msg',payload:{type:'task_started',turn_id:'owned'}}]:[]),
  ...messages.map(message=>({type:'event_msg',payload:{type:'item_completed',thread_id:threadId,turn_id:'owned',item:{type:message.role==='user'?'UserMessage':'AgentMessage',id:message.id,content:[{type:message.role==='user'?'text':'Text',text:message.text}]}}}))];
/** One JSON line per record, numbered from `first` so appended lines continue a file's ordinals. */
export const codexLines=(records:Record<string,unknown>[],first=0)=>records.map((record,index)=>JSON.stringify({timestamp:'2026-01-02T03:04:05Z',ordinal:first+index,...record})).join('\n')+'\n';
export async function prepareRecordedConversation(fixture:SshFixture,root:string,companion:Buffer) {
  const specification=JSON.parse(await readFile(join(root,'apps/agent/tests/fixtures/recorded-conversations.json'),'utf8'));
  const messages=(kind:'codex'|'v1'|'v2'):RecordedMessage[]=>specification.messages.map((message:{id:string;role:string;text:string})=>({...message,text:`${specification.labels[kind]}: ${message.text}`}));
  const directory=join(fixture.directory,'recorded-conversations'),image=join(fixture.directory,'data/lazysh/companion/lazysh-agent');
  await mkdir(directory,{mode:0o700});await mkdir(join(fixture.directory,'data/lazysh/companion'),{recursive:true,mode:0o700});
  await writeFile(image,companion,{flag:'wx',mode:0o700});
  const version=JSON.parse(await readFile(join(root,'apps/client/package.json'),'utf8')).version as string;
  const check=await fixture.client(true,`'${image}' --version`);
  if((await check.finish('source-built recorded companion version',5000)).trim()!==`lazysh-agent ${version}`)throw new Error('Recorded companion version mismatch');
  const codex=join(directory,'recorded.jsonl');await writeFile(codex,codexLines(codexRecords(specification.codexThreadId,messages('codex'))),{flag:'wx',mode:0o400});
  const sources=[{agent:'codex',sessionId:specification.codexThreadId,path:codex,messages:messages('codex')}];
  for(const format of ['v1','v2'] as const) {
    const path=join(directory,`opencode-${format}.db`);await writeFile(path,'',{flag:'wx',mode:0o600});
    const input=join(directory,`seed-${format}.json`);await writeFile(input,JSON.stringify({schema:specification.opencodeSchemas[format],messages:messages(format),sessionId:specification.opencodeSessions[format],v2:format==='v2'}),{flag:'wx',mode:0o600});
    await sshCommand('create private synthetic recorded database','python3',['-c',`import sqlite3,json,sys
s=json.load(open(sys.argv[1])); c=sqlite3.connect(sys.argv[2]); c.executescript(s['schema']); sid=s['sessionId']; c.execute('UPDATE '+('session_v2' if s['v2'] else 'session')+' SET id=?',(sid,))
for i,m in enumerate(s['messages']):
 if s['v2']:
  c.execute('INSERT INTO session_message VALUES(?,?,?,?,?,?)',(m['id'],sid,m['role'],i,json.dumps({'text':m['text']}),i));c.execute('INSERT INTO session_part VALUES(?,?,?,?)',(m['id'],sid,i,json.dumps({'type':'text','text':m['text']})))
 else:
  c.execute('INSERT INTO message VALUES(?,?,?,?)',(m['id'],sid,json.dumps({'role':m['role']}),i));c.execute('INSERT INTO part VALUES(?,?,?,?)',('part_'+str(i),m['id'],sid,json.dumps({'type':'text','text':m['text']})))
c.commit();c.close()`,input,path]);
    await chmod(path,0o400);sources.push({agent:'opencode',sessionId:specification.opencodeSessions[format],path,messages:messages(format)});
  }
  const cards=await prepareRecordedCards(root,directory);
  const hash=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
  const before=await Promise.all([...new Set([...sources,...cards].map(source=>source.path))].map(async path=>({path,sha256:await hash(path),info:await stat(path)})));
  for(const source of sources) {
    const control=await fixture.client(true,`'${image}' transcript --agent ${source.agent} --path '${source.path}' --session-id '${source.sessionId}' --view conversation --offset 0 --limit 50`);
    const page=JSON.parse(await control.finish('synthetic recorded companion preflight',5000));
    const actual=page.messages?.map((message:{role:string;blocks:{type:string;text:string}[]})=>({role:message.role,blocks:message.blocks}));
    const expected=source.messages.map((message:{role:string;text:string})=>({role:message.role,blocks:[{type:'text',text:message.text}]}));
    if(page.schemaVersion!==1 || page.agent!==source.agent || page.view!=='active_branch' || page.branchId!==source.sessionId || !isDeepStrictEqual(actual,expected))throw new Error('Synthetic recorded preflight mismatch');
  }
  return {metadata:{provenance:'synthetic',sources:sources.map(source=>({...source,messages:source.messages.map(({role,text}:{role:string;text:string})=>({role,text}))})),cards,page:recordedPage},verify:async()=>{
    for(const item of before) {const after=await stat(item.path);if(await hash(item.path)!==item.sha256 || after.dev!==item.info.dev || after.ino!==item.info.ino || after.size!==item.info.size || after.mtimeMs!==item.info.mtimeMs || after.mode!==item.info.mode || after.nlink!==1)throw new Error('Synthetic recorded corpus changed');}
    if(await hash(image)!==createHash('sha256').update(companion).digest('hex'))throw new Error('Recorded companion image changed');
  }};
}
