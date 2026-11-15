#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  exec sudo bash "$0" "$@"
fi

command -v python3 >/dev/null
command -v systemctl >/dev/null
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else "Python 3.10 or newer is required")'

source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
install_root=/opt/gamerank
install -d -m 0755 "$install_root" "$install_root/data" "$install_root/server"

if [[ "$source_root" != "$(cd -- "$install_root" && pwd)" ]]; then
  for file in index.html styles.css app.js start.sh; do
    install -m 0644 "$source_root/$file" "$install_root/$file"
  done
  install -m 0644 "$source_root/data/games.js" "$install_root/data/games.js"
  install -m 0644 "$source_root/server/gamerank_server.py" "$install_root/server/gamerank_server.py"
fi

if ! id gamerank >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --shell /usr/sbin/nologin gamerank
fi
install -d -o gamerank -g gamerank -m 0750 /var/lib/gamerank
install -m 0644 "$source_root/deploy/gamerank.service" /etc/systemd/system/gamerank.service
systemctl daemon-reload
systemctl enable gamerank
systemctl restart gamerank
systemctl --no-pager --full status gamerank
printf '\nGameRank is running. Open http://YOUR_SERVER_IP:8080/ in each browser.\n'
