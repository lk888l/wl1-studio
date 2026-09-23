#!/bin/sh
# Called only by the explicit in-app action through pkexec. $1 is compiled-in
# rule text, never an IPC-supplied path or command. Do not run during packaging.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
test "$(id -u)" = 0 || { echo 'Administrator authorization is required.' >&2; exit 1; }
command -v udevadm >/dev/null || { echo 'This system does not provide udevadm.' >&2; exit 1; }
case "${2:-stlink}" in
    stlink) family=stlink; target=/etc/udev/rules.d/70-wl1-stlink.rules ;;
    sticks3) family=sticks3; target=/etc/udev/rules.d/70-wl1-sticks3.rules ;;
    *) echo 'Unsupported USB device family.' >&2; exit 1 ;;
esac
apply_rules() {
    udevadm control --reload-rules
    if test "$family" = sticks3; then
        # The user may install the rule after the DAP was already enumerated.
        # Reapply it only to this VID:PID, then wait for its uaccess ACL.
        udevadm trigger --action=add --settle --subsystem-match=usb \
            --attr-match=idVendor=303a --attr-match=idProduct=4004
    fi
}
mkdir -p /etc/udev/rules.d
if test -e "$target" || test -L "$target"; then
    if test ! -L "$target" && test -f "$target" && printf '%s' "$1" | cmp -s - "$target"; then
        apply_rules
        exit 0
    fi
    echo "Existing $target differs. Refusing to overwrite it; ask your administrator to review it." >&2
    exit 1
fi
staging=$(mktemp /etc/udev/rules.d/.wl1-stlink.XXXXXX)
trap 'rm -f -- "$staging"' EXIT HUP INT TERM
printf '%s' "$1" > "$staging"
chown root:root "$staging"
chmod 0644 "$staging"
# Link rather than overwrite: another setup cannot replace a pre-existing rule.
ln "$staging" "$target"
apply_rules
# The ST-Link rule follows the original replug workflow.
