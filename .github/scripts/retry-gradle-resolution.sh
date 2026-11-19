#!/bin/sh
# Usage: retry-gradle-resolution.sh <command...>
# Run <command>, a build that runs Gradle, and run it again when Gradle could not fetch a
# dependency: a registry throttle or 5xx, a dropped connection, a POM that arrived truncated, or a
# lookup that came back "Could not find|resolve group:artifact". At most LAZYSH_RETRY_ATTEMPTS runs
# in all (default 3), waiting LAZYSH_RETRY_DELAY seconds before the second (default 20) and three
# times that before the third. Any other failure, such as a compile, test or lint error, returns
# its own exit status at once, and every attempt's output stays in the log. Nothing is cached or
# refreshed here, so a retry downloads and verifies dependencies exactly as the first run did.
set -u
attempts=${LAZYSH_RETRY_ATTEMPTS:-3} delay=${LAZYSH_RETRY_DELAY:-20}
work=$(mktemp -d) || exit
trap 'rm -rf "$work"' EXIT
transient='Could not (find|resolve) [A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:|Could not parse POM|status code (429|502|503|504)|Too Many Requests|Bad Gateway|Service Unavailable|Gateway Time-?out|Read timed out|Connection (reset|timed out)|Premature end of Content-Length|Remote host terminated the handshake'
attempt=1
while :; do
  { "$@" 2>&1; echo $? > "$work/status"; } | tee "$work/log"
  status=$(cat "$work/status")
  [ "$status" -ne 0 ] || exit 0
  reason=$(grep -Em1 "$transient" "$work/log") || exit "$status"
  reason=$(printf '%.200s' "$reason" | sed 's/^[[:space:]>-]*//')
  if [ "$attempt" -ge "$attempts" ]; then
    printf '::error::Gradle dependency resolution still failing after %s attempts (%s)\n' "$attempt" "$reason"
    exit "$status"
  fi
  printf '::warning::Gradle dependency resolution failed on attempt %s of %s (%s); retrying in %s seconds\n' "$attempt" "$attempts" "$reason" "$delay"
  sleep "$delay"
  attempt=$((attempt + 1)) delay=$((delay * 3))
done
