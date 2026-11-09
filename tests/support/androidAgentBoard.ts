import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * Owned Claude hook inputs for the Android companion case. The device types only
 * `sh board` and `sh approvals` in its terminal: each runs the client-installed
 * companion on the host exactly as a configured Claude hook does, with the event on
 * stdin and the tmux pane it would inherit. Nothing here writes companion state.
 */
const boardEvents=[
  ['%3',{hook_event_name:'UserPromptSubmit',session_id:'board-alpha',cwd:'/work/alpha',prompt:'PRIVATE-PROMPT'}],
  ['%3',{hook_event_name:'PreToolUse',session_id:'board-alpha',cwd:'/work/alpha',tool_name:'Bash',tool_input:{token:'SECRET-TOKEN'}}],
  ['%3',{hook_event_name:'Stop',session_id:'board-alpha',cwd:'/work/alpha'}],
  ['%4',{hook_event_name:'Notification',notification_type:'permission_prompt',session_id:'board-beta',cwd:'/work/beta'}],
  ['%5',{hook_event_name:'UserPromptSubmit',session_id:'board-delta',cwd:'/work/delta'}],
] as const;
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
