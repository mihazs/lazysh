#!/usr/bin/env bash
# Runs a command inside a private D-Bus session and a headless sway (wlroots, pixman renderer, no GPU, no seat), the compositor a CI
# runner can start; check.py reads its pixels back with grim (wlr-screencopy). Needs sway, grim and dbus-run-session.
# usage: [POC_WIDTH=1280 POC_HEIGHT=800 POC_SCALE=1] headless-sway.sh <command...>   POC_WIDTH/HEIGHT are logical pixels.
set -u
# The Wayland socket path must stay under 108 bytes, so the runtime directory is short and private.
own=
[ -n "${POC_RUNTIME_DIR:-}" ] || own=$(mktemp -d /tmp/lazysh-surface-poc.XXXXXX)
export XDG_RUNTIME_DIR="${POC_RUNTIME_DIR:-$own}"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
export POC_CAPTURE=grim GTK_USE_PORTAL=0 GIO_USE_PORTALS=0 NO_AT_BRIDGE=1
export WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1
scale="${POC_SCALE:-1}"
# One output of the requested size in device pixels, and floating windows: a window that asks for a size (check.py's resize
# step) gets it, where a tiled window would always fill the output.
cat >"$XDG_RUNTIME_DIR/sway.conf" <<CONF
output HEADLESS-1 resolution $(( ${POC_WIDTH:-1280} * scale ))x$(( ${POC_HEIGHT:-800} * scale )) scale $scale
xwayland disable
default_border none
default_floating_border none
floating_modifier none
for_window [app_id=".*"] floating enable
CONF
dbus-run-session -- bash -c '
  sway -c "$XDG_RUNTIME_DIR/sway.conf" >"${SWAY_LOG:-/dev/null}" 2>&1 &
  sway=$!
  # sway picks the first free wayland-N socket itself; a missing one is reported by the command that needs it.
  for _ in $(seq 50); do
    POC_SOCKET=$(cd "$XDG_RUNTIME_DIR" && ls -d wayland-[0-9] 2>/dev/null | head -n 1)
    [ -n "$POC_SOCKET" ] && break; sleep 0.2
  done
  export POC_SOCKET
  "$@"; rc=$?
  kill $sway 2>/dev/null; wait $sway 2>/dev/null
  exit $rc
' bash "$@"
rc=$?
[ -z "$own" ] || rm -rf "$own"
exit $rc
