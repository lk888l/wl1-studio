#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "bundle:linux must run on a Linux build host." >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Refusing to create desktop packages as root." >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_root="$(cd -- "${script_dir}/.." && pwd -P)"
builder_root="$(getent passwd "$(id -u)" | cut -d: -f6)"
if [[ -z "${builder_root}" || "${builder_root}" == "/" ]]; then
  echo "Unable to resolve a safe builder home prefix for Rust path remapping." >&2
  exit 1
fi

remap_flags="--remap-path-prefix=${project_root}=/workspace --remap-path-prefix=${builder_root}=/build-user"
if [[ -n "${RUSTFLAGS:-}" ]]; then
  export RUSTFLAGS="${RUSTFLAGS} ${remap_flags}"
else
  export RUSTFLAGS="${remap_flags}"
fi

cd -- "${project_root}"
"${script_dir}/prepare-appimage-tools.sh"

npm run tauri build -- --bundles deb,appimage

bundle_dir="${project_root}/src-tauri/target/release/bundle"
(
  cd -- "${bundle_dir}"
  sha256sum deb/*.deb appimage/*.AppImage > SHA256SUMS
)

echo "Linux packages and SHA256SUMS are ready in ${bundle_dir}."
