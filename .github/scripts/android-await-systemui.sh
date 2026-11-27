#!/bin/sh
# Usage: android-await-systemui.sh
# Bounded readiness gate for the owned emulator, run once before any native case starts.
# A slow boot can leave SystemUI hung in its startup: the system logs an am_anr event ("Process ...
# failed to complete startup") and later puts a "System UI isn't responding" dialog in front of the
# app, so every native case fails with windowFocused=false (#379). `sys.boot_completed` cannot see it.
# Waits for SystemUI to run and log no startup ANR through a quiet window (LAZYSH_SYSTEMUI_POLLS polls, 2 s apart);
# otherwise reboots the guest (the emulator process and its AVD stay) and observes again, at most
# LAZYSH_SYSTEMUI_REBOOTS times. Exits 1 only when SystemUI is still unsettled after the last reboot
# or a reboot does not come back, so the job fails in minutes with the named cause instead of after
# the first case times out. It never touches a test, an assertion or a deadline.
# Selects the device through ANDROID_SERIAL like every other adb call of the job.
set -u
adb=${ADB:-adb}
reboots=${LAZYSH_SYSTEMUI_REBOOTS:-2}
polls=${LAZYSH_SYSTEMUI_POLLS:-10}
poll=${LAZYSH_SYSTEMUI_POLL_SECONDS:-2}
boot_polls=${LAZYSH_SYSTEMUI_BOOT_POLLS:-150}

query() { timeout 30 "$adb" "$@" 2>/dev/null | tr -d '\r'; }
# Differs between two boots of one guest (the kernel's boot id, else the zygote start time).
boot_identity() { query shell 'cat /proc/sys/kernel/random/boot_id; getprop ro.boottime.zygote'; }

# Prints why SystemUI is not settled; prints nothing when it is.
unsettled() {
  n=0
  while :; do
    anr=$(query logcat -b events -d -s am_anr | grep -m 1 com.android.systemui | cut -c1-300)
    [ -z "$anr" ] || { printf 'startup ANR event: %s' "$anr"; return; }
    [ "$n" -lt "$polls" ] || break
    n=$((n + 1))
    sleep "$poll"
  done
  [ -n "$(query shell pidof com.android.systemui)" ] || printf 'no SystemUI process'
}

# Reboots the guest and waits for a new boot, not the old guest's stale sys.boot_completed.
reboot_guest() {
  before=$(boot_identity)
  [ -n "$before" ] || { echo 'android systemui gate: cannot read the guest boot identity, so a reboot could not be verified; no native case was started'; exit 1; }
  query reboot >/dev/null
  n=0
  while [ "$n" -lt "$boot_polls" ]; do
    n=$((n + 1))
    sleep "$poll"
    now=$(boot_identity)
    if [ -n "$now" ] && [ "$now" != "$before" ] && [ "$(query shell getprop sys.boot_completed)" = 1 ]; then return 0; fi
  done
  return 1
}

done_reboots=0
while :; do
  reason=$(unsettled)
  if [ -z "$reason" ]; then echo "android systemui gate: settled after $done_reboots reboot(s)"; exit 0; fi
  echo "android systemui gate: unsettled: $reason"
  if [ "$done_reboots" -ge "$reboots" ]; then
    echo "android systemui gate: still unsettled after $done_reboots reboot(s); no native case was started"
    exit 1
  fi
  done_reboots=$((done_reboots + 1))
  echo "android systemui gate: rebooting the guest ($done_reboots of $reboots)"
  reboot_guest || { echo 'android systemui gate: the guest did not come back from the reboot; no native case was started'; exit 1; }
done
