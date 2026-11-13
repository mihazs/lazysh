#!/bin/bash
# Test-only stand-in for an agent TUI (tmux_agent_session_fixture.rs). It draws a prompt and a permission-mode line in
# the pane it runs in, reads raw keys, appends Claude Code format records to a transcript and logs every submitted
# prompt, answered question, interrupt and mode change to a second file. No provider, network or account is used.
transcript=$1 log=$2 companion=$3 state=$4
modes=('manual mode on' 'accept edits on' 'plan mode on')
mode=0 buf='' asking=0 pasting=0 count=0 parent=null due=0
escape() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\t'/\\t}; printf '%s' "$s"; }
note() { printf '%s\n' "$1" >> "$log"; }
# One transcript record: the chain of parentUuid is what makes the reader follow a branch.
record() {
  count=$((count + 1))
  printf '{"parentUuid":%s,"isSidechain":false,"cwd":"/work/fixture","sessionId":"5f0c1d2e-0000-4000-8000-0000000000aa","version":"2.1.317","type":"%s","uuid":"r%s","timestamp":"2026-11-04T10:00:%02d.000Z","message":%s}\n' \
    "$parent" "$1" "$count" "$count" "$2" >> "$transcript"
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
# The PermissionRequest hook Claude Code runs before a tool: it blocks until someone decides, and prints the decision.
permission() {
  local request='{"hook_event_name":"PermissionRequest","session_id":"5f0c1d2e-0000-4000-8000-0000000000aa","cwd":"/work/fixture","tool_name":"Bash","tool_input":{"command":"git push --force-with-lease"}}'
  LAZYSH_STATE_DIR=$state "$companion" approval-request --agent claude --timeout-seconds 60 <<<"$request"
}
draw() { printf '\033[2J\033[H> \r\n\r\n  ⏸ %s · ? for shortcuts' "${modes[$mode]}"; }

stty raw -echo
printf '\033[?2004h'
draw
note READY
while true; do
  IFS= read -rsn1 -d '' -t 0.2 key
  status=$?
  if ((status > 128)); then
    # No key: the background command the agent started finishes on its own a moment later.
    if ((due && ${EPOCHREALTIME/./} / 1000 >= due)); then due=0; note BACKGROUND_ENDED; ended; fi
    continue
  fi
  ((status == 0)) || break
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
    case $buf in
      ask*) asking=1; note ASKING; ask ;;
      permission*) note PERMISSION_ASKED
        case $(permission) in
          *'"behavior":"allow"'*) note 'PERMISSION allow'; text 'Ran the command.' ;;
          *) note 'PERMISSION deny'; text 'Not allowed.' ;;
        esac ;;
      background*) note BACKGROUND; background; due=$((${EPOCHREALTIME/./} / 1000 + 1000)) ;;
      *) text "Answered: ${buf:0:40}" ;;
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
