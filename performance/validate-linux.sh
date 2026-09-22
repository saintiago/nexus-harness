#!/usr/bin/env bash
# Run from the repository root. Inventory before the WSL invocation exits.
set -uo pipefail
date -u --iso-8601=seconds
git rev-parse HEAD
uname -a
node --version
npm --version
git --version
snapshot() {
  ps -eo pid,ppid,lstart,comm,args > "performance/harn-48-linux-processes-$1.txt"
  find /tmp -maxdepth 1 -type d \( -name 'nexus-harness-*' -o -name 'nexus-live-check-*' \) |
    sort > "performance/harn-48-linux-directories-$1.txt"
}
snapshot before
/usr/bin/time -p npm run validate -- -- --reporter=verbose
result=$?
snapshot after
echo "Validation exit: $result"
echo "New fixture directories:"
comm -13 performance/harn-48-linux-directories-before.txt performance/harn-48-linux-directories-after.txt
echo "Remaining Node/Git processes (no rows means none):"
ps -C node -C git -o pid,ppid,lstart,args || true
exit "$result"
