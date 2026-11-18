#!/usr/bin/env bash
# launchd entry point for the observation-window evaluator.
# Sources credentials from 600-permission files; never prints them.
# Forwards "$@" so a documented re-evaluation can pass --note-file.
set -uo pipefail
for file in "$HOME/.config/bandroom/credentials.env" "$HOME/.config/bandroom/credentials-prod.env"; do
  if [[ -r "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
done
exec /usr/bin/env python3 -I "$HOME/.bandroom-acoustic/observation_window_eval.py" "$@"
