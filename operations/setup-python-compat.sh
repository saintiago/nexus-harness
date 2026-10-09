#!/bin/sh
# Opt-in host setup; not run by Nexus or profile installation.
set -eu

if command -v python >/dev/null 2>&1; then
  printf 'python is already available; leaving it unchanged.\n'
  exit 0
fi

if ! nexus_python3=$(command -v python3); then
  printf 'python3 must be installed before setting up python compatibility.\n' >&2
  exit 1
fi

nexus_user_bin="${HOME:?}/.local/bin"
case ":${PATH:-}:" in
  *":$nexus_user_bin:"*) ;;
  *)
    printf '%s must be on the Nexus worker PATH before running this script.\n' "$nexus_user_bin" >&2
    exit 1
    ;;
esac

if [ -e "$nexus_user_bin/python" ] || [ -L "$nexus_user_bin/python" ]; then
  printf 'Refusing to replace existing %s/python.\n' "$nexus_user_bin" >&2
  exit 1
fi

mkdir -p "$nexus_user_bin"
ln -s "$nexus_python3" "$nexus_user_bin/python"
printf 'Created %s/python -> %s\n' "$nexus_user_bin" "$nexus_python3"
