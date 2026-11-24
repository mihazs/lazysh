#!/bin/sh
# Runs the README capture spec (apps/client/mobile-e2e/capture/readme-media.e2e.ts) against the Waydroid guest with no private data on screen.
# The owned SSH host logs in as the current account, so the account would show in the host list and the prompt. This runs the whole suite in a
# bubblewrap view where /etc/passwd names that uid "demo" (home /home/demo, no real name; the owned hosts open in their own scratch directory), and seeds /tmp/demo (removed afterwards)
# with harmless files that the spec copies to the hosts. Nothing else about the machine changes.
# Runbook: docs/how-to/capture-readme-media.md.
#
# Usage: readme-capture-run.sh <x86_64 debug apk> [spec]     (hold the Waydroid lane lock first; see the runbook)
# Environment: ANDROID_HOME, JAVA_HOME, ANDROID_SERIAL (default 192.168.240.112:5555), README_RAW_DIR (default a new directory under $TMPDIR),
# README_MEDIA_OUT (default docs/assets/readme), README_CROP_TOP and README_CROP_BOTTOM (default 75 and 127: the status and navigation bars of a 1080x2400 guest).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
apk=${1:?usage: readme-capture-run.sh <x86_64 debug apk> [spec]}
spec=${2:-mobile-e2e/capture/readme-media.e2e.ts}
: "${ANDROID_HOME:?set ANDROID_HOME}" "${JAVA_HOME:?set JAVA_HOME}"
command -v bwrap >/dev/null || { echo 'readme-capture-run: bwrap is not installed' >&2; exit 3; }
work=$(mktemp -d); home=/tmp/demo; export README_DEMO_HOME=$home; trap 'rm -rf "$work" "$home"' EXIT
uid=$(id -u); gid=$(id -g)
# Every other account stays as it is; the current one becomes demo.
awk -F: -v uid="$uid" -v OFS=: '$3 == uid { print "demo", "x", $3, $4, "", "/home/demo", "/bin/sh"; next } { print }' /etc/passwd > "$work/passwd"
# A pty is owned by the group "tty", which is unmapped in this view; mapping it to our own group lets sshd allocate one (what the fixtures do with privateTtyGroup).
awk -F: -v gid="$gid" -v OFS=: '$1 == "tty" { $3 = gid } { print }' /etc/group > "$work/group"
grep -q '^demo:' "$work/passwd" || { echo "readme-capture-run: no passwd entry for uid $uid" >&2; exit 3; }
export README_ZOOM_SCRIPT=$here/readmeZoom.ts ANDROID_SERIAL=${ANDROID_SERIAL:-192.168.240.112:5555} LAZYSH_E2E_APK=$apk
export README_RAW_DIR=${README_RAW_DIR:-$work/raw} README_MEDIA_OUT=${README_MEDIA_OUT:-$here/../../../docs/assets/readme}
export README_CROP_TOP=${README_CROP_TOP:-75} README_CROP_BOTTOM=${README_CROP_BOTTOM:-127} README_CAPTURE_SCRIPT=$here/readme-capture.sh
export LAZYSH_TEST_AGENT_BIN=${LAZYSH_TEST_AGENT_BIN-$(command -v lazysh-agent || true)}
export LAZYSH_E2E_HOSTS=${LAZYSH_E2E_HOSTS:-tmux,sftp} LAZYSH_TEST_TMUX=${LAZYSH_TEST_TMUX:-$(command -v tmux)}
mkdir -p "$README_RAW_DIR" "$README_MEDIA_OUT"
# What the Files view and the terminal can show: harmless names and text, nothing from this machine.
rm -rf "$home"; mkdir -p "$home/projects/api-server" "$home/projects/mobile-app" "$home/projects/infra" "$home/backups"
printf '# Notes\n\n- rotate the staging certificates\n- review the agent PR before lunch\n' > "$home/notes.md"
printf '#!/bin/sh\necho "deploying build 1042 to staging"\n' > "$home/deploy.sh"; chmod +x "$home/deploy.sh"
cat > "$home/build.sh" <<'DEMO'
#!/bin/sh
printf '\033[1;36m==> building api-server 0.8.2\033[0m\n'
for step in 'Resolving dependencies' 'Compiling tokio v1.41' 'Compiling hyper v1.5' 'Compiling api-server v0.8.2' 'Running 128 tests'; do
  printf '\033[32m  ok\033[0m %s\n' "$step"; sleep 0.5
done
printf '\033[1;32mFinished\033[0m release in 41.3s\n'
DEMO
chmod +x "$home/build.sh"
cp "$here/readme-demo/transcript.jsonl" "$home/session.jsonl"
printf 'cargo build --release\n   Compiling api-server v0.8.2\n    Finished release in 41.3s\n' > "$home/build.log"
cd "$here/.." && bwrap --dev-bind / / --ro-bind "$work/passwd" /etc/passwd --ro-bind "$work/group" /etc/group env USER=demo LOGNAME=demo bun run mobile-e2e -- --spec "$spec"
