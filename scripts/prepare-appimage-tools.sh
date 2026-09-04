#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "AppImage tools can only be prepared on Linux." >&2
  exit 1
fi

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "Pinned AppImage tools are currently verified only for x86_64." >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_root="$(cd -- "${script_dir}/.." && pwd -P)"
tools_dir="${project_root}/src-tauri/target/.tauri"
staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/wl1-appimage-tools.XXXXXXXX")"
trap 'rm -rf -- "${staging_dir}"' EXIT

download_verified() {
  local name="$1"
  local url="$2"
  local expected_sha256="$3"
  local staged_file="${staging_dir}/${name}"
  local actual_sha256

  echo "Fetching pinned AppImage tool: ${name}"
  curl \
    --fail \
    --location \
    --connect-timeout 30 \
    --max-time 300 \
    --proto '=https' \
    --tlsv1.2 \
    --retry 3 \
    --retry-all-errors \
    --silent \
    --show-error \
    --output "${staged_file}" \
    "${url}"

  actual_sha256="$(sha256sum "${staged_file}" | cut -d' ' -f1)"
  if [[ "${actual_sha256}" != "${expected_sha256}" ]]; then
    echo "SHA-256 mismatch for ${name}." >&2
    echo "Expected: ${expected_sha256}" >&2
    echo "Actual:   ${actual_sha256}" >&2
    exit 1
  fi

  install -m 0750 "${staged_file}" "${tools_dir}/${name}"
}

mkdir -p -- "${tools_dir}"

# Tauri 2.11.4 otherwise resolves several mutable release aliases/branches.
# These hashes intentionally make any upstream content change fail closed.
download_verified \
  "AppRun-x86_64" \
  "https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64" \
  "f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f"
download_verified \
  "linuxdeploy-x86_64.AppImage" \
  "https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-x86_64.AppImage" \
  "e762bea85c8eb0d4b3508d46e5c1f037f717d0f9303ae3b4aafc8b04991fa1ef"
download_verified \
  "linuxdeploy-plugin-gtk.sh" \
  "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/b5eb8d05b4c0ed40107fe2158c5d8527f94568ef/linuxdeploy-plugin-gtk.sh" \
  "cb379f9b0733e9ad9f8bd78f8c2fa038aef2478523bb7d4c8e64ff6a1ea3501a"
download_verified \
  "linuxdeploy-plugin-gstreamer.sh" \
  "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/2a2e67491c32995a3f279ad0ecbe77abd512b42a/linuxdeploy-plugin-gstreamer.sh" \
  "c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94"
download_verified \
  "linuxdeploy-plugin-appimage.AppImage" \
  "https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage" \
  "0441769ab38009504d2678c38cd7e526955388dd30a215b4a20afaa5471652f2"

echo "Pinned AppImage tools are ready in ${tools_dir}."
