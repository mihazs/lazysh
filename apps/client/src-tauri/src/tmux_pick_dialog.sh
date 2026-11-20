#!/bin/bash
# Test-only stand-in for an agent that has a list dialog open (tmux_pick_fixture.rs). It draws the recorded screen it is given
# (the approval prompt Codex 0.167.0 drew in a real tmux pane), moves the `›` with Up and Down, and logs every key and the row
# Enter takes. No provider, network or account is used.
screen=$1 log=$2 copies=${3:-1} at=1
note() { printf '%s\n' "$1" >> "$log"; }
draw() {
  printf '\033[2J\033[H'
  for _ in $(seq "$copies"); do
    while IFS= read -r line; do
      if [[ $line =~ ^(›|\ )\ ([0-9])\.\ (.*)$ ]]; then
        mark=' '; [[ ${BASH_REMATCH[2]} == "$at" ]] && mark='›'
        printf '%s %s. %s\r\n' "$mark" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
      else
        printf '%s\r\n' "$line"
      fi
    done < "$screen"
  done
}
stty raw -echo
draw
note READY
while IFS= read -rsn1 -d '' key; do
  case $key in
    $'\r' | $'\n') note "CHOSE $at"; printf '\033[2J\033[H• You chose option %s\r\n' "$at"; sleep 60; exit ;;
    $'\e')
      next=
      IFS= read -rsn1 -d '' -t 0.3 next
      if [[ -z $next ]]; then note ESC; continue; fi
      IFS= read -rsn1 -d '' -t 0.3 arrow
      case $arrow in
        A) ((at > 1)) && at=$((at - 1)); note "UP $at"; draw ;;
        B) ((at < 3)) && at=$((at + 1)); note "DOWN $at"; draw ;;
      esac ;;
  esac
done
