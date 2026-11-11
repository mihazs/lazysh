#!/bin/sh
# Usage: android-dismiss-error-dialogs.sh
# Dismiss a system "isn't responding" or "has stopped" dialog that is already on the owned
# emulator. A slow boot makes the system report "SystemUI failed to complete startup"; its
# dialog keeps window focus, so every later native case sees an unfocused app window (the
# recorded failures are "Native workspace not ready ... windowFocused=false" and a Settings
# enrollment that never advances). Taps "Wait" (else "Close app") until the dialog is gone.
# Only controls owned by the "android" package count; an app's own "Wait" button is never tapped.
# Best effort: it always exits 0 and prints one receipt line, so it never masks a test verdict.
# Selects the device through ANDROID_SERIAL like every other adb call of the job.
set -u
adb=${ADB:-adb}
attempts=${LAZYSH_DIALOG_ATTEMPTS:-5}
settle=${LAZYSH_DIALOG_SETTLE_SECONDS:-2}
dump=/data/local/tmp/lazysh-error-dialog.xml

# Prints the centre "x y" of the first system control with this resource id or label.
# $1 = resource id under android:id/, $2 = label, $3 = view hierarchy.
centre() {
  printf '%s' "$3" | grep -o '<node [^>]*package="android"[^>]*>' | grep -e "resource-id=\"android:id/$1\"" -e "text=\"$2\"" | head -n 1 |
    grep -o 'bounds="[^"]*"' | tr -c '0-9\n' ' ' | awk 'NF == 4 { printf "%d %d", ($1 + $3) / 2, ($2 + $4) / 2 }'
}

# The window that has focus when the script starts: a stuck dialog is named "Application Not Responding: <process>".
focus=$(timeout 30 "$adb" shell dumpsys window 2>/dev/null | grep -m 1 mCurrentFocus | sed 's/^ *//' | cut -c1-160)
echo "android error dialogs: ${focus:-focus unavailable}"

checks=0 unreadable=0 taps=0 last=
while [ "$checks" -le "$attempts" ]; do
  checks=$((checks + 1))
  hierarchy=
  # --windows adds every window, not only the active one; older builds reject it and get the plain dump.
  if timeout 30 "$adb" shell uiautomator dump --windows "$dump" >/dev/null 2>&1 || timeout 30 "$adb" shell uiautomator dump "$dump" >/dev/null 2>&1; then
    hierarchy=$(timeout 30 "$adb" exec-out cat "$dump" 2>/dev/null)
    timeout 30 "$adb" shell rm -f "$dump" >/dev/null 2>&1
  fi
  case $hierarchy in
    *'<hierarchy'*) ;;
    *) unreadable=$((unreadable + 1)); sleep "$settle"; continue ;;
  esac
  id=aerr_wait
  point=$(centre "$id" Wait "$hierarchy")
  if [ -z "$point" ]; then
    id=aerr_close
    point=$(centre "$id" 'Close app' "$hierarchy")
  fi
  if [ -z "$point" ]; then
    # Name any other text a system window shows, so a dialog with unknown controls is visible in the log.
    seen=$(printf '%s' "$hierarchy" | grep -o '<node [^>]*package="android"[^>]*>' | grep -o ' text="[^"][^"]*"' | head -n 4 | tr -d '\n')
    note=${seen:+; other system text:$seen}
    if [ "$taps" -eq 0 ]; then echo "android error dialogs: none present$note"
    else echo "android error dialogs: dismissed with $taps tap(s), last $last$note"; fi
    exit 0
  fi
  [ "$taps" -lt "$attempts" ] || break
  # shellcheck disable=SC2086 # "x y" is two arguments for input tap.
  timeout 30 "$adb" shell input tap $point >/dev/null 2>&1
  taps=$((taps + 1))
  last="$id at $point"
  sleep "$settle"
done
if [ "$unreadable" -eq "$checks" ]; then echo 'android error dialogs: view hierarchy unavailable'
else echo "android error dialogs: still present after $taps tap(s), last $last"; fi
exit 0
