#!/usr/bin/env bash
set -uo pipefail

failures=0
warnings=0
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
project_root="$(cd -- "${script_dir}/.." && pwd -P)"

if ! cd -- "${project_root}"; then
  printf 'FAIL  Unable to enter project root: %s\n' "${project_root}" >&2
  exit 1
fi


ok() {
  printf 'OK    %s\n' "$1"
}

warn() {
  printf 'WARN  %s\n' "$1" >&2
  warnings=$((warnings + 1))
}

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  failures=$((failures + 1))
}

if [[ "$(uname -s)" == "Linux" ]]; then
  ok "Linux kernel $(uname -r)"
else
  fail "This diagnostic targets Linux."
fi

if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  ok "${PRETTY_NAME:-Unknown Linux distribution}"
fi

for command_name in node npm rustc cargo pkg-config curl sha256sum; do
  if command -v "${command_name}" >/dev/null 2>&1; then
    if version_output="$("${command_name}" --version 2>&1)"; then
      ok "${command_name}: ${version_output%%$'\n'*}"
    else
      fail "${command_name} is installed but unusable: ${version_output%%$'\n'*}"
    fi
  else
    fail "Missing command: ${command_name}"
  fi
done

for module_name in webkit2gtk-4.1 gtk+-3.0 librsvg-2.0 dbus-1; do
  if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists "${module_name}"; then
    ok "pkg-config module: ${module_name} $(pkg-config --modversion "${module_name}")"
  else
    fail "Missing development module: ${module_name}"
  fi
done

if command -v patchelf >/dev/null 2>&1; then
  ok "patchelf: $(patchelf --version)"
else
  warn "patchelf is absent; install it before producing AppImage artifacts."
fi

current_user="$(id -un)"
if id -nG "${current_user}" | tr ' ' '\n' | grep -Fxq dialout; then
  ok "${current_user} belongs to dialout"
else
  warn "${current_user} is not in dialout; USB serial ports may return PermissionDenied."
fi

shopt -s nullglob
serial_nodes=(/dev/ttyACM* /dev/ttyUSB* /dev/serial/by-id/*)
shopt -u nullglob
if (( ${#serial_nodes[@]} > 0 )); then
  ok "Detected serial nodes: ${serial_nodes[*]}"
else
  warn "No ttyACM/ttyUSB/by-id serial node is currently connected."
fi

release_binary="${project_root}/src-tauri/target/release/wl1-studio"
if [[ -x "${release_binary}" ]] && command -v ldd >/dev/null 2>&1; then
  if ldd "${release_binary}" | grep -q 'not found'; then
    fail "The release binary has unresolved shared-library dependencies."
  else
    ok "Release binary shared libraries are resolved."
  fi
fi

printf '\nSummary: %d failure(s), %d warning(s).\n' "${failures}" "${warnings}"
exit "${failures}"
