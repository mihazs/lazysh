#!/bin/sh
# Print native=false only for a pull request whose every changed path is documentation.
# Pushes, manual runs, unreadable ranges and any other path print native=true.
set -u
if [ "${EVENT-}" != pull_request ] || [ -z "${BASE-}" ] || [ -z "${HEAD-}" ]; then
  echo native=true; exit 0
fi
start=$(git merge-base "$BASE" "$HEAD" 2>/dev/null) || { echo native=true; exit 0; }
files=$(git diff --name-only "$start" "$HEAD" 2>/dev/null) || { echo native=true; exit 0; }
[ -n "$files" ] || { echo native=true; exit 0; }
docs='^(docs/.*|[^/]+\.md|\.changeset/[^/]+\.md|\.github/ISSUE_TEMPLATE/.*|\.github/(pull_request_template|release_pull_request_template|TEMPLATES)\.md)$'
if printf '%s\n' "$files" | grep -Evq "$docs"; then echo native=true; else echo native=false; fi
