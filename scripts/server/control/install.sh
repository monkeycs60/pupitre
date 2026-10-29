#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Exécuter avec sudo.' >&2; exit 1; }
control_source=$(cd -- "$(dirname -- "$0")" && pwd)
control_host=${1:?Nom DNS Tailscale requis}
control_login=${2:?Identité Tailscale requise}
[[ $control_host =~ ^[a-z0-9.-]+\.ts\.net$ && $control_login =~ ^[a-zA-Z0-9._+@-]+$ ]] || exit 1
for account in pupitre-build pupitre-preview; do
  id "$account" >/dev/null 2>&1 || useradd --system --home-dir "/var/lib/$account" --shell /usr/sbin/nologin "$account"
done
install -d -m 755 /opt/pupitre-control /opt/pupitre/releases /var/lib/pupitre-build /etc/pupitre
install -d -m 700 /var/lib/pupitre-control
install -d -o pupitre-build -g pupitre-build -m 700 /var/cache/pupitre-build
install -d -o pupitre-preview -g pupitre-preview -m 700 /var/lib/pupitre-preview
for file in controller.py engine.py store.py host.py build.py data.py bootstrap.py offline-websocket.ts console.html; do
  install -o root -g root -m 644 "$control_source/$file" "/opt/pupitre-control/$file"
done
install -m 644 "$control_source/../pupitre.service" /opt/pupitre-control/pupitre-release.service
for unit in "$control_source"/*.service; do install -m 644 "$unit" /etc/systemd/system/; done
python3 - "$control_host" "$control_login" <<'PY'
import json, os, subprocess, sys
from pathlib import Path
path = Path('/etc/pupitre/control.json')
config = json.loads(path.read_text()) if path.exists() else {
    'host': sys.argv[1], 'login': sys.argv[2], 'confirmSeconds': 180, 'startupSeconds': 45}
config['serverAddresses'] = subprocess.check_output(['tailscale', 'ip'], text=True).split()
path.write_text(json.dumps(config, indent=2))
os.chmod(path, 0o600)
PY
sed -e 's@/run/pupitre-web@/run/pupitre-preview-web@g' \
    -e 's@127.0.0.1:4880@127.0.0.1:4884@g' -e 's@127.0.0.1:4820@127.0.0.1:4822@g' \
    -e 's@root /var/www/pupitre;@root /opt/pupitre/releases/preview/ui;@' \
    -e "s@'https://$control_host'@'https://$control_host:10000'@g" \
    /etc/pupitre/nginx.conf > /etc/pupitre/preview-nginx.conf
systemctl daemon-reload
systemctl enable --now pupitre-control.service pupitre-preview-web.service
tailscale serve --bg --yes --https=8443 unix:/run/pupitre-control/http.sock
tailscale serve --bg --yes --https=10000 http://127.0.0.1:4884
echo 'Secours installé. Initialiser une version de référence avant de changer le service Pupitre.'
