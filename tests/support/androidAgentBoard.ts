import {chmod,copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * Owned Claude hook inputs for the Android companion case. The device types only
 * `sh board` and `sh approvals` in its terminal: each runs the client-installed
 * companion on the host exactly as a configured Claude hook does, with the event on
 * stdin and the tmux pane it would inherit. The one thing `board` writes to the companion's
 * store itself is the age of `board-aged`: after the real hook reported it, its row is dated
 * eight days back, past the seven-day retention, as if the report had been made then.
 * `approvals` also starts two waiting hooks in a pane of a private Zellij server and a private stock Herdr
 * server (own HOME and sockets, never the live ones), so the device lists the exact pane each multiplexer names.
 */
const boardEvents=[
  ['%3',{hook_event_name:'UserPromptSubmit',session_id:'board-alpha',cwd:'/work/alpha',prompt:'PRIVATE-PROMPT'}],
  ['%3',{hook_event_name:'PreToolUse',session_id:'board-alpha',cwd:'/work/alpha',tool_name:'Bash',tool_input:{token:'SECRET-TOKEN'}}],
  ['%3',{hook_event_name:'Stop',session_id:'board-alpha',cwd:'/work/alpha'}],
  ['%4',{hook_event_name:'Notification',notification_type:'permission_prompt',session_id:'board-beta',cwd:'/work/beta'}],
  ['%5',{hook_event_name:'UserPromptSubmit',session_id:'board-delta',cwd:'/work/delta'}],
  ['%6',{hook_event_name:'Stop',session_id:'board-aged',cwd:'/work/aged'}],
] as const;
// The companion keeps one SQLite row per session (`sessions.updated_at`, seconds since the epoch) and drops rows older than seven days when it reads them.
const ageReport=`python3 -I -c 'import sqlite3,sys,time;c=sqlite3.connect(sys.argv[1]);n=c.execute("UPDATE sessions SET updated_at=? WHERE session_id=?",(time.time()-8*86400,"board-aged")).rowcount;c.commit();sys.exit(n!=1)' "$LAZYSH_STATE_DIR/events.sqlite3"`;
// Pane, cwd, command and the decision the device sends back (null: the host ends the hook). A null pane is a real multiplexer pane.
const approvals={
  allow:['%7','/work/gamma','git push --dry-run','allow'],
  deny:['%8','/work/zeta','git push --force','deny'],
  zellij:[null,'/work/eta','git push --dry-run origin','allow'],
  herdr:[null,'/work/theta','git push --force-with-lease','deny'],
  host:['%9','/work/epsilon','git tag --list',null],
} as const;
type Approval=keyof typeof approvals;
export const zellijSession='lazysh-approvals';
/** The pinned Zellij and the same-run stock Herdr the waiting hooks run in. */
export interface PaneMultiplexers {zellij:string;herdr:string}
export function agentBoardMultiplexers():PaneMultiplexers {
  const {LAZYSH_TEST_ZELLIJ:zellij,LAZYSH_TEST_HERDR_STOCK:herdr}=process.env;
  if(!zellij?.startsWith('/') || !herdr?.startsWith('/'))throw new Error('Explicit pinned Zellij and stock Herdr binaries required');
  return {zellij,herdr};
}

const companion='"$d/data/lazysh/companion/lazysh-agent"';

// Runs on the host: a private Zellij server and stock Herdr server (binaries, config and sockets under the fixture's own
// directory), each starting `pane-<name>.sh` in a pane of its own so that pane's environment names it.
const multiplexerPrelude=[
  'd=$(cd "$(dirname "$0")" && pwd)',
  'PATH="$d/mux-bin:$PATH"; ZELLIJ_CONFIG_DIR="$d/mux/zellij"; HERDR_CONFIG_PATH="$d/mux/herdr.toml"; export PATH ZELLIJ_CONFIG_DIR HERDR_CONFIG_PATH',
  'wait_for() { i=0; until "$@" >/dev/null 2>&1; do i=$((i+1)); test $i -lt 100 || exit 1; sleep 0.2; done; }',
  `zellij attach --create-background ${zellijSession} >/dev/null 2>&1 || exit 1`,
  `wait_for zellij --session ${zellijSession} action list-tabs`,
  `zellij --session ${zellijSession} run --name zellij -- sh "$d/pane-zellij.sh" >/dev/null || exit 1`,
  'nohup herdr server >/dev/null 2>&1 &',
  'wait_for herdr api snapshot',
  `pane=$(herdr workspace create --label herdr --cwd "$d" | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')`,
  'test -n "$pane" || exit 1',
  'herdr pane run "$pane" "exec sh $d/pane-herdr.sh" >/dev/null || exit 1',
];
const approval=(name:string)=>`${companion} approval-request --agent claude --timeout-seconds 240 < "$d/approval-${name}.json" > "$d/decision-${name}.json"`;

/** Writes `board`; with `multiplexers` also `approvals`, whose waiting hooks run in real Zellij and Herdr panes. */
export async function prepareAgentBoardHooks(directory:string,multiplexers?:PaneMultiplexers) {
  const write=(name:string,value:string)=>writeFile(join(directory,name),value,{mode:0o600,flag:'wx'});
  const board:string[]=['d=$(dirname "$0")'];
  for(const [index,[pane,event]] of boardEvents.entries()) {
    await write(`board-${index+1}.json`,JSON.stringify(event));
    board.push(`TMUX_PANE='${pane}' ${companion} ingest --agent claude < "$d/board-${index+1}.json" || exit 1`);
  }
  // Last, so only the companion's read of the store can drop it: nothing ingests after it.
  board.push(`(umask 077; ${ageReport}) || exit 1`);
  await write('board',board.join('\n')+'\n');
  if(multiplexers)await prepareApprovals(directory,multiplexers,write);
}

async function prepareApprovals(directory:string,multiplexers:PaneMultiplexers,write:(name:string,value:string)=>Promise<void>) {
  const waiting=[...multiplexerPrelude],bin=join(directory,'mux-bin'),zellij=join(directory,'mux','zellij');
  await mkdir(join(zellij,'layouts'),{recursive:true,mode:0o700});await mkdir(bin,{mode:0o700});
  for(const [name,source] of Object.entries(multiplexers)) {await copyFile(source,join(bin,name));await chmod(join(bin,name),0o700);}
  // Without a config Zellij 0.45.1 opens its first-run wizard; a plain layout avoids its bar plugins. Herdr never fetches a newer catalog.
  await write('mux/zellij/layouts/plain.kdl','layout { pane; }\n');
  await write('mux/zellij/config.kdl','show_release_notes false\nshow_startup_tips false\ndefault_layout "plain"\n');
  await write('mux/herdr.toml','[update]\nversion_check = false\nmanifest_check = false\n');
  for(const [name,[pane,cwd,command]] of Object.entries(approvals)) {
    await write(`approval-${name}.json`,JSON.stringify({hook_event_name:'PermissionRequest',session_id:`approval-${name}`,cwd,tool_name:'Bash',tool_input:{command}}));
    if(pane===null)await write(`pane-${name}.sh`,`d=$(dirname "$0")\nexec ${approval(name)}\n`);
    else waiting.push(`TMUX_PANE='${pane}' ${approval(name)} &`);
  }
  // Claude ends its hook when the prompt is answered at the host. Do that only after the device answered the
  // other four, so the device has seen this request listed first; then the private servers are stopped.
  const answered=Object.entries(approvals).filter(([,[,,,decision]])=>decision!==null).map(([name])=>`! test -s "$d/decision-${name}.json"`).join(' || ');
  waiting.push('host=$!',`(i=0; while { ${answered}; } && test $i -lt 240; do sleep 1; i=$((i+1)); done; kill "$host"; zellij kill-session ${zellijSession}; herdr server stop) >/dev/null 2>&1 &`);
  await write('approvals',waiting.join('\n')+'\n');
}

/** What each waiting hook printed to Claude after the device or the host answered it. */
export async function agentBoardDecisions(directory:string) {
  const decisions:Partial<Record<Approval,unknown>>={};
  for(const name of Object.keys(approvals) as Approval[]) {
    const output=await readFile(join(directory,`decision-${name}.json`),'utf8');
    decisions[name]=output===''?null:JSON.parse(output)?.hookSpecificOutput?.decision?.behavior;
  }
  const expected=Object.fromEntries(Object.entries(approvals).map(([name,[,,,decision]])=>[name,decision]));
  if(JSON.stringify(decisions)!==JSON.stringify(expected))throw new Error(`Waiting hooks did not receive the device decisions: ${JSON.stringify(decisions)}`);
}
