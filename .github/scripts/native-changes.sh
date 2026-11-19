#!/bin/sh
# Select the checks.yml native job groups that a pull request's changed paths can affect.
# Prints one GitHub step output per line; CONTRIBUTING.md has the resulting job table.
# Pushes, manual runs, an empty or unreadable range, workflow, script, manifest and lockfile
# changes, and any unrecognised path select every job and the full matrix. When a path's
# consumers are uncertain it must select more jobs, never fewer.
# Exception: a pull request never selects the jobs that are not required to merge (companion
# candidates, macOS and Windows desktop, iOS simulator, Mosh, Herdr navigation, auxiliary
# Android, ntfy, terminal core on macOS). They run on pushes to main, where main-verdict.yml reports their verdict.
# The terminal performance gate (terminal_perf) is report-only too, but a pull request that selects the terminal runtime area runs it.
set -u

areas=' '
add() {
  for area; do
    case "$areas" in *" $area "*) ;; *) areas="$areas$area " ;; esac
  done
}
has() { case "$areas" in *" all "* | *" $1 "*) return 0 ;; esac; return 1; }
any() {
  for area; do has "$area" && return 0; done
  return 1
}

# Paths below packages/ are classified by package name and first directory, so a nested
# "ios" or "android" directory never matches a platform rule by accident.
package() {
  name=${1#packages/}; rest=${name#*/}; name=${name%%/*}; top=${rest%%/*}
  case "$name/$top" in
    # The app's native-terminal bridge compiles the runtime, ghostty-vt and the vendored libghostty-vt (native-terminal-bridge).
    herdr-upstream/crates | herdr-upstream/vendor) add herdr terminal_runtime terminal_bridge ;; # the terminal runtime builds on its vendored ghostty-vt binding, for Android too.
    herdr-upstream/*) add herdr terminal_runtime ;;
    herdr-guard/*) add herdr ;;
    terminal-runtime/*) add terminal_runtime terminal_bridge ;; # tested inside herdr-native: it provisions the admitted Zig and libghostty-vt.
    terminal-renderer-wgpu/*) add terminal_runtime ;;
    */ios) add ios ;;
    */android | */android-*) add android ;;
    common/*) add client agent herdr ;; # herdr-native compiles copied common sources.
    account-usage/* | ai-usagebar-vendor/* | companion-release/*) add client agent ;;
    notification-client/*) add agent push relay ;; # native-linux-runtimes runs the real Apprise API relay case.
    push-registration/*) add client android ios push ;;
    mosh-transport/*) add client ios mosh ;;
    credential-vault/* | display-idle/* | apple-speech/* | apple-status/*) add client ios ;;
    et-transport/* | parakeet-runtime/* | portable-pty-vendor/* | deep-link-vendor/*) add client ;;
    *) add all ;;
  esac
}

classify() {
  case "$1" in
    .changeset/*/*) add all ;;
    docs/* | .changeset/*.md | .github/ISSUE_TEMPLATE/* | .github/pull_request_template.md | \
      .github/release_pull_request_template.md | .github/TEMPLATES.md) add docs ;;
    packages/*/*) package "$1" ;;
    .github/ios-workspace-metadata.jq | tests/ios-*) add ios ;;
    apps/client/src-tauri/gen/android/*) add android ;;
    apps/client/src-tauri/apple/*) add ios ;;
    apps/client/package.json | apps/client/moon.yml | apps/client/src-tauri/Cargo.toml | \
      apps/client/src-tauri/build.rs | apps/client/src-tauri/tauri.conf.json | \
      apps/client/src-tauri/icons/* | apps/client/src-tauri/capabilities/* | \
      apps/client/src-tauri/src/apple_*) add client ios ;;
    # The terminal runtime replays this file in herdr-native; the client e2e suite reads it too.
    apps/client/e2e/fixtures/mosh-resize-frames.json | apps/client/e2e/fixtures/platform-keys/*) add client terminal_runtime ;;
    apps/client/* | apps/share-service/*) add client ;;
    apps/agent/*) add agent ;;
    apps/notification-service/*) add agent push relay ;;
    tests/herdr-source.test.ts) add herdr ;;
    tests/android-herdr-navigation.test.ts | tests/support/androidHerdr.ts) add android herdr ;;
    tests/android-ntfy.test.ts | tests/android-push-artifact.test.ts | tests/support/androidNtfy.ts) add android push ;;
    # native-linux also runs the namespaced SSH host case.
    tests/android-ssh-host.test.ts | tests/support/androidSsh.ts | tests/support/sshFixture.ts) add client android ;;
    tests/android-*.test.ts | tests/support/android*.ts) add android ;;
    # native-desktop runs release consistency, the Windows installer cases and the installed GUI.
    tests/release-consistency.test.ts | tests/release-artifacts.test.ts | \
      tests/windows-installed-gui.test.ts | tests/support/windowsGui.ts) add client ;;
    # Checked only by the always-running client and agent jobs, or by fdroid.yml. main-verdict.yml
    # runs on pushes to main alone, and tests/main-verdict.test.ts is part of test:ci. conventional-commits.yml is its own
    # workflow and tests/regression-check.test.ts runs in test:hooks.
    apps/transcription-service/* | .githooks/* | fdroid/* | tests/fdroid-recipe.test.ts | \
      tests/pre-commit.test.ts | tests/commit-msg.test.ts | tests/regression-check.test.ts | tests/native-changes.test.ts | \
      tests/pinned-download.test.ts | tests/moon-graph.test.ts | tests/support/gitFixture.ts | .jscpd.json | lint-staged.config.mjs | \
      tests/waydroid-lane.test.ts | \
      .github/workflows/main-verdict.yml | .github/workflows/conventional-commits.yml | tests/main-verdict.test.ts) add none ;;
    */*) add all ;;
    *.md) add docs ;;
    *) add all ;;
  esac
}

if [ "${EVENT-}" = schedule ]; then
  add nightly # only the device suite: main's push run is the parity evidence for everything else.
elif [ "${EVENT-}" != pull_request ] || [ -z "${BASE-}" ] || [ -z "${HEAD-}" ]; then
  add all
elif ! start=$(git merge-base "$BASE" "$HEAD" 2>/dev/null) ||
  ! files=$(git diff --name-only --no-renames "$start" "$HEAD" 2>/dev/null) || [ -z "$files" ]; then
  add all
else
  while IFS= read -r path; do classify "$path"; done <<EOF
$files
EOF
fi

flag() { if "$@"; then echo true; else echo false; fi; }
linux=$(flag any client agent herdr)
linux_runtimes=$(flag any client herdr relay)
android_runtime=$(flag any client android agent herdr)
android_herdr=$(flag any herdr android agent)
# The Appium suite drives the packaged app against owned SSH and stock Herdr hosts with the real companion.
android_appium=$(flag any client android agent herdr nightly)
# Quarantined (@flaky) specs run in their own non-gating job, never on a pull request, and only when one exists.
quarantine=false
if [ "${EVENT-}" != pull_request ] && [ "$android_appium" = true ] && grep -rqs --include='*.e2e.ts' '@flaky' apps/client/mobile-e2e/specs; then quarantine=true; fi
# herdr-native produces the same-run binaries these consumers verify, so it runs for any of them.
herdr=$(flag any herdr terminal_runtime)
case "$linux$linux_runtimes$android_runtime$android_herdr$android_appium" in *true*) herdr=true ;; esac
if has push; then variants='["fdroid","google"]'; else variants='["google"]'; fi

# Outputs of jobs that are not required to merge and that no pull request selects: pushes keep them.
main_only=' companion desktop android_mosh android_herdr android_auxiliary android_ntfy ios terminal_macos '

native=false
for output in \
  "companion=$(flag has agent)" \
  "herdr=$herdr" \
  "terminal_runtime=$(flag any terminal_runtime)" \
  "terminal_bridge=$(flag any client terminal_bridge)" \
  "linux=$linux" \
  "linux_runtimes=$linux_runtimes" \
  "desktop=$(flag any client agent)" \
  "android=$(flag any client android)" \
  "android_runtime=$android_runtime" \
  "android_mosh=$(flag has mosh)" \
  "android_herdr=$android_herdr" \
  "android_appium=$android_appium" \
  "android_appium_quarantine=$quarantine" \
  "android_auxiliary=$(flag any android agent push)" \
  "android_ntfy=$(flag any android push)" \
  "ios=$(flag has ios)" \
  "terminal_perf=$(flag has terminal_runtime)" \
  "terminal_macos=$(flag has terminal_runtime)"; do
  # The fast gate still runs for a pull request that selected only main-only jobs.
  case "$output" in *=true) native=true ;; esac
  name=${output%%=*}
  if [ "${EVENT-}" = pull_request ]; then case "$main_only" in *" $name "*) output="$name=false" ;; esac; fi
  echo "$output"
done
echo "ntfy_variants=$variants"
echo "native=$native"
if [ "$areas" = ' docs ' ]; then echo docs_only=true; else echo docs_only=false; fi
