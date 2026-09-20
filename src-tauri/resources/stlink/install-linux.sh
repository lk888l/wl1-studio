#!/bin/sh
# Called only by the explicit in-app action through pkexec. $1 is compiled-in
# rule text, never an IPC-supplied path or command. Do not run during packaging.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
test "$(id -u)" = 0 || { echo 'Administrator authorization is required.' >&2; exit 1; }
command -v udevadm >/dev/null || { echo 'This system does not provide udevadm.' >&2; exit 1; }
target=/etc/udev/rules.d/70-wl1-stlink.rules
mkdir -p /etc/udev/rules.d
if test -e "$target" || test -L "$target"; then
    if test ! -L "$target" && test -f "$target" && printf '%s' "$1" | cmp -s - "$target"; then
        udevadm control --reload-rules
        exit 0
    fi
    echo 'Existing /etc/udev/rules.d/70-wl1-stlink.rules differs. Refusing to overwrite it; ask your administrator to review it.' >&2
    exit 1
fi
staging=$(mktemp /etc/udev/rules.d/.wl1-stlink.XXXXXX)
trap 'rm -f -- "$staging"' EXIT HUP INT TERM
printf '%s' "$1" > "$staging"
chown root:root "$staging"
chmod 0644 "$staging"
# Link rather than overwrite: another setup cannot replace a pre-existing rule.
ln "$staging" "$target"
udevadm control --reload-rules
# Replugging the probe applies the rule. Do not trigger unrelated USB devices.
