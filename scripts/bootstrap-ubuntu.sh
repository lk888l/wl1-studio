#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(uname -s)" != "Linux" ]] || ! command -v apt-get >/dev/null 2>&1; then
  echo "This bootstrap script supports Ubuntu/Debian hosts only." >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run this script as your normal desktop user; it will invoke sudo only for package setup." >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install --yes --no-install-recommends build-essential curl file libayatana-appindicator3-dev librsvg2-dev libssl-dev libwebkit2gtk-4.1-dev libxdo-dev libdbus-1-dev bluez patchelf wget

current_user="$(id -un)"
if [[ "${1:-}" == "--with-dialout" ]]; then
  if ! id -nG "${current_user}" | tr ' ' '\n' | grep -Fxq dialout; then
    sudo usermod -aG dialout "${current_user}"
    echo "Added ${current_user} to dialout. Log out of the desktop session and log back in before using serial devices."
  fi
fi

echo "Ubuntu system dependencies are ready."
echo "Next: install Node.js 24 LTS and rustup if they are not already available, then run npm ci."
