#!/usr/bin/env bash
# Every scenario the CI job (and any host with sway, grim, Xvfb and a Vulkan driver) runs: the probe's own assertions under a headless
# compositor, read back as pixels. Needs the probe built (`cargo build --locked`). A software Vulkan driver (lavapipe) serves `vulkan`.
# usage: [POC_APP=/path/to/lazysh] ci.sh OUTDIR   (screenshots and report.json of each scenario land in OUTDIR/<scenario>); exit 1 when any scenario failed
# With POC_APP (a debug build of the app with the `native-terminal` feature) the scenarios run against the real app's window and surface host
# instead of the probe: placement at scale 1 and 2 on Wayland, and the refusal on X11.
set -u
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: ci.sh OUTDIR}
failed=()

# run SCENARIO MODE ORDER [VAR=value...]: Wayland scenarios run in a headless sway, X11 on a plain Xvfb (no compositor, as on any X server).
run() {
  name=$1 mode=$2 order=$3; shift 3
  echo "=== $name"
  if [ "$mode" = x11 ]; then wrapper=(dbus-run-session --); else wrapper=("$here/headless-sway.sh"); fi
  env SWAY_LOG="$out/$name.sway.log" "$@" "${wrapper[@]}" "$here/check.py" "$mode" "$order" "$out/$name" ${POC_APP:+--app "$POC_APP"} || failed+=("$name")
}

mkdir -p "$out"
if [ -n "${POC_APP:-}" ]; then
  run app-wayland-scale1 wayland below POC_SCALE=1
  run app-wayland-scale2 wayland below POC_SCALE=2
  run app-x11 x11 below POC_XSERVER=xvfb # the app must refuse: a child window would cover the page
else
  run wayland-shm-scale1 wayland below POC_SCALE=1
  run wayland-vulkan-scale1 wayland below POC_SCALE=1 POC_RENDER=vulkan
  run wayland-shm-scale2 wayland below POC_SCALE=2
  run wayland-vulkan-scale2 wayland below POC_SCALE=2 POC_RENDER=vulkan
  run wayland-above wayland above # the order that must not be used: proves the overlap check can fail
  run x11 x11 below POC_XSERVER=xvfb # an X11 child window covers the DOM: the overlap check asserts that, so xterm.js stays on X11
fi

[ ${#failed[@]} -eq 0 ] || { echo "FAILED scenarios: ${failed[*]}" >&2; exit 1; }
echo "all scenarios passed"
