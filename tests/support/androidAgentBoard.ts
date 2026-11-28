import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * Owned Claude hook inputs for the Android companion case. The device types only
 * `sh board` and `sh approvals` in its terminal: each runs the client-installed
 * companion on the host exactly as a configured Claude hook does, with the event on
 * stdin and the tmux pane it would inherit. The one thing `board` writes to the companion's
 * store itself is the age of `board-aged`: after the real hook reported it, its row is dated
 * eight days back, past the seven-day retention, as if the report had been made then.
 */
const boardEvents=[
  ['%3',{hook_event_name:'UserPromptSubmit',session_id:'board-alpha',cwd:'/work/alpha',response:'PRIVATE-PROMPT'}],
  ['%3',{hook_event_name:'PreToolUse',session_id:'board-alpha',cwd:'/work/alpha',tool_name:'Bash',tool_input:{token:'SECRET-TOKEN'}}],
  ['%3',{hook_event_name:'Stop',session_id:'board-alpha',cwd:'/work/alpha'}],
  ['%4',{hook_event_name:'Notification',notification_type:'permission_prompt',session_id:'board-beta',cwd:'/work/beta'}],
  ['%5',{hook_event_name:'UserPromptSubmit',session_id:'board-delta',cwd:'/work/delta'}],
  ['%6',{hook_event_name:'Stop',session_id:'board-aged',cwd:'/work/aged'}],
] as const;
// The companion keeps one SQLite row per session (`sessions.updated_at`, seconds since the epoch) and drops rows older than seven days when it reads them.
const ageReport=`python3 -I -c 'import sqlite3,sys,time;c=sqlite3.connect(sys.argv[1]);n=c.execute("UPDATE sessions SET updated_at=? WHERE session_id=?",(time.time()-8*86400,"board-aged")).rowcount;c.commit();sys.exit(n!=1)' "$LAZYSH_STATE_DIR/events.sqlite3"`;
const approvals={
  allow:['%7','/work/gamma','git push --dry-run'],
  deny:['%8','/work/zeta','git push --force'],
  host:['%9','/work/epsilon','git tag --list'],
} as const;
type Approval=keyof typeof approvals;

const companion='"$d/data/lazysh/companion/lazysh-agent"';

export async function prepareAgentBoardHooks(directory:string) {
  const write=(name:string,value:string)=>writeFile(join(directory,name),value,{mode:0o600,flag:'wx'});
  const board:string[]=['d=$(dirname "$0")'],waiting:string[]=['d=$(dirname "$0")'];
  for(const [index,[pane,event]] of boardEvents.entries()) {
    await write(`board-${index+1}.json`,JSON.stringify(event));
    board.push(`TMUX_PANE='${pane}' ${companion} ingest --agent claude < "$d/board-${index+1}.json" || exit 1`);
  }
  // Last, so only the companion's read of the store can drop it: nothing ingests after it.
  board.push(`(umask 077; ${ageReport}) || exit 1`);
  for(const [name,[pane,cwd,command]] of Object.entries(approvals)) {
    await write(`approval-${name}.json`,JSON.stringify({hook_event_name:'PermissionRequest',session_id:`approval-${name}`,cwd,tool_name:'Bash',tool_input:{command}}));
    waiting.push(`TMUX_PANE='${pane}' ${companion} approval-request --agent claude --timeout-seconds 240 < "$d/approval-${name}.json" > "$d/decision-${name}.json" &`);
  }
  // Claude ends its hook when the prompt is answered at the host. Do that only after the
  // device answered the other two, so the device has seen this request listed first.
  waiting.push('host=$!','(i=0; while { ! test -s "$d/decision-allow.json" || ! test -s "$d/decision-deny.json"; } && test $i -lt 240; do sleep 1; i=$((i+1)); done; kill "$host") &');
  await write('board',board.join('\n')+'\n');
  await write('approvals',waiting.join('\n')+'\n');
}

/** What each waiting hook printed to Claude after the device or the host answered it. */
export async function agentBoardDecisions(directory:string) {
  const decisions:Partial<Record<Approval,unknown>>={};
  for(const name of Object.keys(approvals) as Approval[]) {
    const output=await readFile(join(directory,`decision-${name}.json`),'utf8');
    decisions[name]=output===''?null:JSON.parse(output)?.hookSpecificOutput?.decision?.behavior;
  }
  if(JSON.stringify(decisions)!==JSON.stringify({allow:'allow',deny:'deny',host:null}))throw new Error(`Waiting hooks did not receive the device decisions: ${JSON.stringify(decisions)}`);
}
