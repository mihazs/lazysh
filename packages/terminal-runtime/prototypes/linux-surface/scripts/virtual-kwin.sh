#!/usr/bin/env bash
# Runs a command inside a private D-Bus session and a headless KWin (Wayland socket `kwin-poc`), so the probe can be captured
# without a desktop session. Needs kwin_wayland, dbus-run-session and python3 with PyGObject.
# usage: [POC_WIDTH=1280 POC_HEIGHT=800] virtual-kwin.sh <command...>
set -u
# The Wayland socket path must stay under 108 bytes, so the runtime directory is short and private.
export XDG_RUNTIME_DIR="${POC_RUNTIME_DIR:-/run/user/$(id -u)/lazysh-surface-poc}"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
# KWin only lets the screenshot interface answer a client it has authorized; this variable is its switch for tests.
export KWIN_SCREENSHOT_NO_PERMISSION_CHECKS=1 QT_QPA_PLATFORM=offscreen GTK_USE_PORTAL=0 GIO_USE_PORTALS=0 NO_AT_BRIDGE=1
exec dbus-run-session -- bash -c '
  kwin_wayland --virtual --socket kwin-poc --width "${POC_WIDTH:-1280}" --height "${POC_HEIGHT:-800}" --no-lockscreen >"${KWIN_LOG:-/dev/null}" 2>&1 &
  kwin=$!
  for _ in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/kwin-poc" ] && break; sleep 0.2; done
  sleep 1.5
  "$@"; rc=$?
  kill $kwin 2>/dev/null; wait $kwin 2>/dev/null
  exit $rc
' bash "$@"
