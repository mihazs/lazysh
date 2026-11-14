#!/bin/bash
# Test-only stand-in for an agent TUI (tmux_agent_session_fixture.rs). It draws a prompt and a permission-mode line in
# the pane it runs in, reads raw keys, appends Claude Code format records to a transcript and logs every submitted
# prompt, answered question, interrupt and mode change to a second file. No provider, network or account is used.
# With a fifth argument it also acts as a hook-reporting agent: it runs the companion's `ingest --reported-history` hook
# the way Claude Code's hooks do, shows each prompt in its pane, logs every key it reads to `$log.keys`, and a `hold ...`
# prompt keeps its turn running until `$log.release` exists.
transcript=$1 log=$2 companion=$3 state=$4 report=$5
modes=('manual mode on' 'accept edits on' 'plan mode on')
mode=0 buf='' asking=0 pasting=0 count=0 parent=null due=0 sub_due=0 flow_due=0 held=0
session=${transcript%.jsonl}
escape() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\t'/\\t}; printf '%s' "$s"; }
note() { printf '%s\n' "$1" >> "$log"; }
# One transcript record: the chain of parentUuid is what makes the reader follow a branch.
record() {
  count=$((count + 1))
  printf '{"parentUuid":%s,"isSidechain":false,"cwd":"/work/fixture","sessionId":"5f0c1d2e-0000-4000-8000-0000000000aa","version":"2.1.317","type":"%s","uuid":"r%s","timestamp":"2026-11-04T10:%02d:%02d.000Z","message":%s}\n' \
    "$parent" "$1" "$count" "$((count / 60))" "$((count % 60))" "$2" >> "$transcript"
  parent="\"r$count\""
}
user() { record user "{\"role\":\"user\",\"content\":\"$(escape "$1")\"}"; }
text() { record assistant "{\"id\":\"msg_$count\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"fixture-model\",\"content\":[{\"type\":\"text\",\"text\":\"$(escape "$1")\"}]}"; }
ask() {
  record assistant '{"id":"msg_ask","type":"message","role":"assistant","model":"fixture-model","content":[{"type":"tool_use","id":"toolu_ask","name":"AskUserQuestion","input":{"questions":[{"question":"Which layout?","header":"Layout","multiSelect":false,"options":[{"label":"Flat","description":"One file."},{"label":"Nested","description":"One directory."}]}]}}]}'
}
answered() { record user "{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"toolu_ask\",\"type\":\"tool_result\",\"content\":\"User has answered your questions: \\\"Which layout?\\\"=\\\"$1\\\".\"}]}"; }
background() {
  record assistant '{"id":"msg_bg","type":"message","role":"assistant","model":"fixture-model","content":[{"type":"tool_use","id":"toolu_bg","name":"Bash","input":{"command":"sleep 60","description":"Wait","run_in_background":true}}]}'
  record user '{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_bg","content":[{"type":"text","text":"Command running in background with ID: bg1. Output is being written to: /tmp/bg1.output"}],"is_error":false}]}'
}
ended() { record user "{\"role\":\"user\",\"content\":\"$(escape $'<task-notification>\n<task-id>bg1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Background command "Wait" completed (exit code 0)</summary>\n</task-notification>')\"}"; }
# A background sub-agent: the call and its launch notice go in the conversation, the sub-agent's own records and its
# meta file (`toolUseId`, `finished`) next to the session, as Claude Code 2.1 writes them.
subagent() {
  record assistant '{"id":"msg_sub","type":"message","role":"assistant","model":"fixture-model","content":[{"type":"tool_use","id":"toolu_sub","name":"Agent","input":{"description":"Explore the layout","subagent_type":"Explore","run_in_background":true}}]}'
  record user '{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_sub","content":[{"type":"text","text":"Async agent launched successfully.\nagentId: sub1 (internal ID - do not mention to user)"}],"is_error":false}]}'
  mkdir -p "$session/subagents"
  printf '%s\n' '{"parentUuid":null,"isSidechain":true,"agentId":"sub1","type":"user","uuid":"c1","message":{"role":"user","content":"Explore the layout"}}' \
    '{"parentUuid":"c1","isSidechain":true,"agentId":"sub1","type":"assistant","uuid":"c2","message":{"role":"assistant","content":[{"type":"text","text":"Found two folders."}]}}' > "$session/subagents/agent-sub1.jsonl"
  printf '%s' '{"toolUseId":"toolu_sub","agentType":"Explore","finished":false}' > "$session/subagents/agent-sub1.meta.json"
}
subagent_ended() { printf '%s' '{"toolUseId":"toolu_sub","agentType":"Explore","finished":true}' > "$session/subagents/agent-sub1.meta.json"; }
# A dynamic workflow: its progress file and journal live next to the session, outside the conversation.
workflow() {
  record assistant '{"id":"msg_flow","type":"message","role":"assistant","model":"fixture-model","content":[{"type":"tool_use","id":"toolu_flow","name":"Workflow","input":{"script":"export const meta = { name: '"'"'review-flow'"'"' }"}}]}'
  record user "{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_flow\",\"content\":[{\"type\":\"text\",\"text\":\"Workflow started. Progress: $session/workflows/wf_fix1.json\"}],\"is_error\":false}]}"
  mkdir -p "$session/workflows" "$session/subagents/workflows/wf_fix1"
  printf '%s' '{"workflowName":"review-flow","status":"running","phases":[{"title":"Plan"}],"workflowProgress":[{"type":"workflow_agent","agentId":"wa1","label":"Planner","state":"progress","phaseTitle":"Plan","tokens":1200,"toolCalls":3}]}' > "$session/workflows/wf_fix1.json"
  printf '%s\n' '{"type":"launched"}' '{"type":"started","agentId":"wa1","label":"Planner","phase":"Plan"}' > "$session/subagents/workflows/wf_fix1/journal.jsonl"
}
workflow_ended() {
  printf '%s' '{"workflowName":"review-flow","status":"completed","phases":[{"title":"Plan"}],"workflowProgress":[{"type":"workflow_agent","agentId":"wa1","label":"Planner","state":"done","phaseTitle":"Plan","tokens":2400,"toolCalls":5}]}' > "$session/workflows/wf_fix1.json"
  printf '%s\n' '{"type":"result","agentId":"wa1"}' >> "$session/subagents/workflows/wf_fix1/journal.jsonl"
}
# The PermissionRequest hook Claude Code runs before a tool: it blocks until someone decides, and prints the decision.
permission() {
  local request='{"hook_event_name":"PermissionRequest","session_id":"5f0c1d2e-0000-4000-8000-0000000000aa","cwd":"/work/fixture","tool_name":"Bash","tool_input":{"command":"git push --force-with-lease"}}'
  LAZYSH_STATE_DIR=$state "$companion" approval-request --agent claude --timeout-seconds 60 <<<"$request"
}
# The hook Claude Code runs on a lifecycle event (`lazysh-agent claude-config --reported-history`): it names the session, its
# transcript and, through TMUX_PANE, this pane.
hook() {
  [[ -n $report ]] || return 0
  printf '{"hook_event_name":"%s","session_id":"5f0c1d2e-0000-4000-8000-0000000000aa","transcript_path":"%s","cwd":"/work/fixture"%s}' "$1" "$transcript" "$2" |
    LAZYSH_STATE_DIR=$state "$companion" ingest --agent claude --reported-history
}
# A TUI shows what was submitted; this one does so only when it reports, so the other cases keep their pane unchanged.
shown() { [[ -z $report ]] || printf '\r\n> %s\r\n' "${1//$'\n'/$'\r\n'}"; }
draw() { printf '\033[2J\033[H> \r\n\r\n  ⏸ %s · ? for shortcuts' "${modes[$mode]}"; }

stty raw -echo
printf '\033[?2004h'
draw
hook SessionStart ''
note READY
while true; do
  IFS= read -rsn1 -d '' -t 0.2 key
  status=$?
  if ((status > 128)); then
    # No key: the background command the agent started finishes on its own a moment later.
    now=$((${EPOCHREALTIME/./} / 1000))
    if ((due && now >= due)); then due=0; note BACKGROUND_ENDED; ended; fi
    if ((sub_due && now >= sub_due)); then sub_due=0; note SUBAGENT_ENDED; subagent_ended; fi
    if ((flow_due && now >= flow_due)); then flow_due=0; note WORKFLOW_ENDED; workflow_ended; fi
    if ((held)) && [[ -e $log.release ]]; then held=0; note HOLD_ENDED; text 'Finished the held work.'; hook Stop ''; fi
    continue
  fi
  ((status == 0)) || break
  [[ -z $report ]] || printf '%d\n' "'$key" >> "$log.keys"
  if [[ $key == $'\e' ]]; then
    next=
    IFS= read -rsn1 -d '' -t 0.3 next
    if [[ -z $next ]]; then note INTERRUPT; asking=0; text 'Interrupted by the user.'; continue; fi
    if [[ $next == '[' ]]; then
      csi=
      while IFS= read -rsn1 -d '' -t 0.3 c; do csi+=$c; [[ $c == [@-~] ]] && break; done
      case $csi in
        Z) mode=$(((mode + 1) % 3)); note "MODE ${modes[$mode]}"; draw ;;
        200~) pasting=1 ;;
        201~) pasting=0 ;;
      esac
    fi
    continue
  fi
  if ((pasting)); then buf+=${key//$'\r'/$'\n'}; continue; fi
  # Enter reaches a bash read as CR or LF depending on the tty settings in force, so either byte submits.
  if [[ $key == $'\r' || $key == $'\n' ]]; then
    note "SUBMIT $(escape "$buf")"
    user "$buf"
    shown "$buf"
    hook UserPromptSubmit ",\"prompt\":\"$(escape "$buf")\""
    case $buf in
      hold*) note HOLD; held=1 ;;
      ask*) asking=1; note ASKING; ask ;;
      permission*) note PERMISSION_ASKED
        case $(permission) in
          *'"behavior":"allow"'*) note 'PERMISSION allow'; text 'Ran the command.' ;;
          *) note 'PERMISSION deny'; text 'Not allowed.' ;;
        esac ;;
      subagent*) note SUBAGENT; subagent; sub_due=$((${EPOCHREALTIME/./} / 1000 + 1500)) ;;
      workflow*) note WORKFLOW; workflow; flow_due=$((${EPOCHREALTIME/./} / 1000 + 1500)) ;;
      background*) note BACKGROUND; background; due=$((${EPOCHREALTIME/./} / 1000 + 1000)) ;;
      *) text "Answered: ${buf:0:40}"; hook Stop '' ;;
    esac
    buf=
    continue
  fi
  if ((asking)) && [[ $key == [12] ]]; then
    note "ANSWER $key"; asking=0
    labels=(Flat Nested); answered "${labels[key - 1]}"; text "Chose ${labels[key - 1]}."
    continue
  fi
  buf+=$key
done
