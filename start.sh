#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p -- "$app_dir/var"
exec python3 "$app_dir/server/gamerank_server.py" \
  --host "${GAMERANK_HOST:-0.0.0.0}" \
  --port "${GAMERANK_PORT:-8080}" \
  --db "${GAMERANK_DB:-$app_dir/var/boards.db}" \
  --static "$app_dir"
