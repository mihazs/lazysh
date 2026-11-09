import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sshCommand} from './sshFixture';

// One recorded source the native Chat cases open, and the exact rendered text
// each selector inside `.chat-panel` must show (an empty list means absent).
export type RecordedCheck={selector:string;texts:string[]};
export type RecordedCardSource={label:string;agent:'claude'|'codex'|'opencode';view:'conversation'|'records';path:string;sessionId?:string;checks:RecordedCheck[]};

/**
 * Page functions both native cases evaluate; the Android fixture carries these exact strings.
 * With `observe` false each returns whether the page matches; with `observe` true it returns
 * a bounded JSON report of what the Chat panel shows, for failure messages (fixture text only).
 */
export const recordedPage={
  // Each expected {role,text} message must be one article with that role and one exact paragraph.
  messages:`(expected,observe)=>{const panel=document.querySelector('.chat-panel'),cards=Array.from(panel?panel.querySelectorAll('.chat-conversation-messages .chat-message'):[]),
    seen=cards.map((card,i)=>({role:card.querySelector('h4')?.textContent??null,paragraphs:card.querySelectorAll('p').length,exact:!!expected[i]&&card.querySelector('p')?.textContent===expected[i].text}));
    if(!observe)return cards.length===expected.length&&seen.every((m,i)=>m.paragraphs===1&&m.role===expected[i].role&&m.exact);
    return JSON.stringify({panel:!!panel,hidden:!!panel&&panel.hidden,regions:panel?panel.querySelectorAll('.chat-conversation-messages').length:0,expected:expected.length,messages:seen.slice(0,8),
      selects:panel?Array.from(panel.querySelectorAll('select'),x=>x.value.slice(0,40)).slice(0,4):[],inputs:panel?Array.from(panel.querySelectorAll('input:not([type=checkbox])'),x=>x.value.slice(-80)).slice(0,4):[],
      alerts:panel?Array.from(panel.querySelectorAll('[role=alert]'),x=>x.textContent.slice(0,240)).slice(0,2):[],busy:!!panel&&Array.from(panel.querySelectorAll('button')).some(x=>x.disabled&&x.type==='submit')});}`,
  // Each check names a selector inside the Chat panel and the exact whitespace-collapsed text of
  // each match, in order; an empty list requires that nothing matches.
  cards:`(checks,observe)=>{const panel=document.querySelector('.chat-panel'),text=e=>e.textContent.replace(/\\s+/g,' ').trim(),
    actual=checks.map(c=>panel?Array.from(panel.querySelectorAll(c.selector),text):null);
    return observe?JSON.stringify(actual.map(v=>v&&v.slice(0,8).map(x=>x.slice(0,160)))):actual.every((v,i)=>JSON.stringify(v)===JSON.stringify(checks[i].texts));}`,
};
/** One page function applied to its JSON argument, as an expression. */
export const recordedPageCall=(name:keyof typeof recordedPage,argument:unknown,observe=false)=>`(${recordedPage[name]})(${JSON.stringify(argument)},${observe})`;

const english={working:'Agent is working',waiting:'Agent is waiting for your answer',idle:'Agent is idle',stopped:'Agent turn was stopped'} as const;
const terminal="Answer in the terminal: Chat cannot choose options in the agent's prompt.";
const activity=(state:keyof typeof english):RecordedCheck[]=>[{selector:`.chat-activity[data-activity="${state}"] > span:not(.chat-activity-dot)`,texts:[english[state]]}];
const plan=(third:string):RecordedCheck=>({selector:'.chat-plan-card li',texts:['DoneRecord the fixture shapes','In progressChoose a layout',third]});
const layout=(first:string):RecordedCheck[]=>[
  {selector:'.chat-question-card legend',texts:['Layout: Which fixture layout should the reader use?']},
  {selector:'.chat-question-card li',texts:[`${first}One records file per agent.`,'NestedOne directory per agent.']},
  {selector:'.chat-question-card input, .chat-question-card select, .chat-question-card textarea',texts:[]},
];
const answer=(answered:boolean):RecordedCheck[]=>[
  {selector:'.chat-question-card [role="note"]',texts:[`${answered?'An answer is recorded.':'No answer is recorded yet.'} ${terminal}`]},
  {selector:'.chat-question-card button',texts:answered?[]:['Open terminal']},
];
const proposed:RecordedCheck[]=[{selector:'.chat-proposed-plan-card h2',texts:['Fixture plan']},{selector:'.chat-proposed-plan-card ol li',texts:['Add nested fixtures.','Cover each reader.']}];
const roles=(...values:string[]):RecordedCheck=>({selector:'.chat-message h4',texts:values});

/**
 * Writes the interaction-card fixtures and their derived in-progress, waiting
 * and stopped variants under `directory` (read-only), and returns what Chat
 * must render for each when the source-built companion reads it over SSH.
 */
export async function prepareRecordedCards(root:string,directory:string) {
  const fixtures=join(root,'apps/agent/tests/fixtures/interaction-cards'),cards=join(directory,'cards');
  await mkdir(cards,{mode:0o700});
  const lines=async(name:string)=>(await readFile(join(fixtures,name),'utf8')).split('\n').filter(Boolean);
  const claude=await lines('claude.jsonl'),codex=await lines('codex.jsonl');
  const aborted=JSON.stringify({timestamp:'2026-11-04T10:00:05.000Z',type:'event_msg',ordinal:6,payload:{type:'turn_aborted',turn_id:'turn-fixture-1',reason:'interrupted'}});
  const write=async(name:string,records:string[])=>{const path=join(cards,name);await writeFile(path,records.join('\n')+'\n',{flag:'wx',mode:0o400});return path;};
  const opencode=join(cards,'opencode-v1.db');
  await sshCommand('create private recorded OpenCode card database','python3',['-c',`import sqlite3,json,sys
f=json.load(open(sys.argv[1])); c=sqlite3.connect(sys.argv[2]); s=f['sessionId']
c.executescript("CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,revert TEXT,time_updated INTEGER);CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT,time_created INTEGER);CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT);")
c.execute("INSERT INTO session VALUES(?,'fixture',NULL,1)",(s,))
for m in f['messages']: c.execute('INSERT INTO message VALUES(?,?,?,?)',(m['id'],s,json.dumps(m['data']),m['time_created']))
for p in f['parts']: c.execute('INSERT INTO part VALUES(?,?,?,?)',(p['id'],p['message_id'],s,json.dumps(p['data'])))
c.commit();c.close()`,join(fixtures,'opencode-v1.json'),opencode]);
  await chmod(opencode,0o400);
  const session=JSON.parse(await readFile(join(fixtures,'opencode-v1.json'),'utf8')).sessionId as string;
  const sources:RecordedCardSource[]=[
    {label:'Claude question waiting for its answer',agent:'claude',view:'conversation',path:await write('claude-waiting.jsonl',claude.slice(0,4)),checks:[
      ...activity('waiting'),plan('PendingWrite the reader tests'),...layout('Flat'),...answer(false),{selector:'.chat-proposed-plan-card',texts:[]}]},
    {label:'Claude answered question and proposed plan',agent:'claude',view:'conversation',path:await write('claude.jsonl',claude),checks:[
      ...activity('idle'),plan('PendingWrite the reader tests'),...layout('Flat'),...answer(true),...proposed]},
    {label:'Claude Markdown and thinking',agent:'claude',view:'conversation',path:await write('claude-markdown.jsonl',await lines('claude-markdown.jsonl')),checks:[
      ...activity('idle'),roles('user','assistant'),
      {selector:'.chat-message h2',texts:['Fixture summary']},{selector:'.chat-message p strong',texts:['nested']},
      {selector:'.chat-message p code',texts:['one directory']},{selector:'.chat-message pre code',texts:['ls fixtures/nested']},
      {selector:'.chat-message ul li',texts:['Readers stay isolated','Records stay byte-identical']},
      {selector:'.chat-message details summary',texts:['thinking']},{selector:'.chat-message details pre',texts:['Synthetic reasoning: compare the flat and nested layouts.']},
      {selector:'.chat-message details[open]',texts:[]}]},
    {label:'Codex turn in progress',agent:'codex',view:'conversation',path:await write('codex-working.jsonl',codex.slice(0,3)),checks:[...activity('working'),roles('user')]},
    {label:'Codex interrupted turn',agent:'codex',view:'conversation',path:await write('codex-stopped.jsonl',[...codex.slice(0,6),aborted]),checks:[...activity('stopped'),roles('user')]},
    {label:'Codex proposed plan',agent:'codex',view:'conversation',path:await write('codex.jsonl',codex),checks:[...activity('idle'),roles('user','assistant'),...proposed]},
    {label:'Codex recorded plan and question',agent:'codex',view:'records',path:join(cards,'codex.jsonl'),checks:[
      {selector:'.chat-activity',texts:[]},{selector:'.chat-plan-card > p',texts:['Fixture work in order.']},plan('PendingWrite the reader tests'),...layout('Flat (Recommended)'),...answer(true)]},
    {label:'OpenCode todos and multiple-choice question',agent:'opencode',view:'conversation',path:opencode,sessionId:session,checks:[
      ...activity('idle'),plan('CancelledDrop the legacy layout'),...layout('Flat'),{selector:'.chat-question-card fieldset > p',texts:['More than one option can be chosen.']},...answer(true)]},
  ];
  return sources;
}
