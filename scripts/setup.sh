#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

for option in "$@"; do
  case "$option" in
    --check|--skip-auth) ;;
    *) echo "Option inconnue : $option"; exit 1 ;;
  esac
done

if [[ " $* " = *" --check "* ]]; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "Bun manque. Lancez bash scripts/setup.sh pour l'installation."
    exit 1
  fi
  exec bun run scripts/setup.ts --check
fi

if [ "${PUPITRE_INSTANCE:-}" = "stable" ]; then
  echo "Lancez le setup dans un terminal indépendant, pas depuis la stable en cours."
  exit 1
fi

if [ -e "$HOME/.local/opt/pupitre/current" ]; then
  echo "Pupitre est déjà installé. Diagnostic : bun run doctor. Mise à jour explicite : bun run promote."
  exit 1
fi

case "$(uname -s)" in
  Darwin)
    if [ "$(sw_vers -productVersion | cut -d. -f1)" -lt 13 ]; then
      echo "macOS 13 ou supérieur est requis."
      exit 1
    fi
    if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
      echo "Terminal fonctionne sous Rosetta. Relancez : arch -arm64 /bin/bash scripts/setup.sh"
      exit 1
    fi
    if ! xcode-select -p >/dev/null 2>&1; then
      xcode-select --install
      echo "Validez l'installation des outils Apple, puis relancez ce même setup."
      exit 1
    fi
    ;;
  Linux)
    if ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists webkit2gtk-4.1 gtk+-3.0 librsvg-2.0; then
      echo "Dépendances système manquantes. Sur Debian/Ubuntu :"
      echo "sudo apt install build-essential curl pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev libayatana-appindicator3-dev patchelf unzip"
      echo "Relancez ensuite ce setup. Autres distributions : https://v2.tauri.app/start/prerequisites/"
      exit 1
    fi
    ;;
  *) echo "Pupitre prend en charge Linux et macOS."; exit 1 ;;
esac

setup_tmp=$(mktemp -d)
trap 'rm -rf "$setup_tmp"' EXIT
if ! command -v bun >/dev/null 2>&1; then
  curl --fail --silent --show-error --location https://bun.sh/install -o "$setup_tmp/bun.sh"
  bash "$setup_tmp/bun.sh"
fi
if ! command -v cargo >/dev/null 2>&1; then
  curl --fail --silent --show-error --location https://sh.rustup.rs -o "$setup_tmp/rust.sh"
  sh "$setup_tmp/rust.sh" -y --profile minimal
fi
bun install --frozen-lockfile
bun run scripts/setup.ts "$@"
