#!/usr/bin/env bash
# Run from the repository root, after this checkout's drive is mounted. Inventory
# before the WSL invocation exits.
set -uo pipefail
date -u --iso-8601=seconds
git rev-parse HEAD
uname -a
node --version
npm --version
git --version
snapshot() {
  ps -eo pid,ppid,lstart,comm,args > "performance/harn-49-linux-processes-$1.txt"
  find /tmp -maxdepth 1 -type d \( -name 'nexus-harness-*' -o -name 'nexus-live-check-*' \) |
    sort > "performance/harn-49-linux-directories-$1.txt"
}
snapshot before
# No result may be reused, and clearing the cache here also checks that removing a
# cache another platform wrote is safe.
/usr/bin/time -p npm run validate:fresh
result=$?
snapshot after
echo "Validation exit: $result"
echo "New fixture directories:"
comm -13 performance/harn-49-linux-directories-before.txt performance/harn-49-linux-directories-after.txt
echo "Remaining Node/Git processes (no rows means none):"
ps -C node -C git -o pid,ppid,lstart,args || true
exit "$result"
