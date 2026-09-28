#!/bin/bash
# setup-passwordless.sh
#
# One time setup that lets the "Restart To Windows" extension reboot into
# Windows without ever asking for your password.
#
#   sudo ./setup-passwordless.sh              install
#   sudo ./setup-passwordless.sh --uninstall  undo
#
# It installs two files and changes nothing else:
#
#   /usr/libexec/restart-to-windows              root owned helper script
#   /usr/share/polkit-1/rules.d/49-restart-to-windows.rules   polkit rule
#
# The helper is only able to set the UEFI "BootNext" variable to a boot entry
# that already exists on the machine. Rebooting is done by systemd-logind,
# which already allows the active session to do that without a password.
#
# The extension keeps working without this setup, it will just fall back to
# "pkexec efibootmgr" and therefore ask for your password every time.
#
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail

HELPER_SRC='helper/restart-to-windows'
RULES_SRC='polkit/49-restart-to-windows.rules'
HELPER_DST='/usr/libexec/restart-to-windows'
RULES_DST='/usr/share/polkit-1/rules.d/49-restart-to-windows.rules'

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==> %s\033[0m\n' "$*" >&2; }
die() {
    printf '\033[1;31m==> %s\033[0m\n' "$*" >&2
    exit 1
}

uninstall() {
    rm -f -- "$HELPER_DST" "$RULES_DST"
    reload_polkit
    info 'Removed the helper and the polkit rule.'
    info 'The extension will ask for your password again.'
}

# polkitd reads its JavaScript rules at startup, so it has to be told to pick
# the new one up. It is a Type=notify-reload service, so a reload is enough and
# nothing has to be restarted.
reload_polkit() {
    if ! command -v systemctl > /dev/null; then
        return 0
    fi

    if systemctl show polkit.service -p CanReload --value 2> /dev/null | grep -qx yes; then
        systemctl reload polkit.service || warn 'Could not reload polkit.service.'
    elif systemctl restart polkit.service 2> /dev/null; then
        : # older polkitd, restarting is the only option
    else
        warn 'Could not reload polkit. The rule takes effect after a reboot.'
    fi
}

if [ "$(id -u)" -ne 0 ]; then
    die "Please run this as root: sudo $0 $*"
fi

if [ "${1:-}" = '--uninstall' ] || [ "${1:-}" = 'uninstall' ]; then
    uninstall
    exit 0
fi

for file in "$HELPER_SRC" "$RULES_SRC"; do
    [ -f "$script_dir/$file" ] || die "Cannot find $file next to this script."
done

# ---------------------------------------------------------------------------
# Sanity checks, so that a broken setup is reported now and not on the next
# restart of the machine.
# ---------------------------------------------------------------------------

if [ ! -d /sys/firmware/efi/efivars ]; then
    die 'This machine was not booted through UEFI, so there is no Windows Boot
    Manager to switch to. Dual booting Windows on a legacy BIOS system cannot
    be done by this extension.'
fi

efibootmgr_bin=$(command -v efibootmgr || true)
[ -n "$efibootmgr_bin" ] ||
    die 'efibootmgr is not installed. Install it and run this script again.'

if ! "$efibootmgr_bin" -v | grep -qi 'Windows Boot Manager'; then
    warn 'No "Windows Boot Manager" entry found in the UEFI boot entries.'
    warn 'The setup will finish, but the extension will not find a Windows'
    warn 'entry to boot into.'
fi

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

# The helper runs as root, so it must not be writable by anybody else.
# Existing directories are left alone rather than re-chmod'ed.
for dir in "$(dirname -- "$HELPER_DST")" "$(dirname -- "$RULES_DST")"; do
    [ -d "$dir" ] || install -d -m 0755 -o root -g root "$dir"
done

install -m 0755 -o root -g root "$script_dir/$HELPER_SRC" "$HELPER_DST"
install -m 0644 -o root -g root "$script_dir/$RULES_SRC" "$RULES_DST"

info "Installed $HELPER_DST"
info "Installed $RULES_DST"

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

perms=$(stat -c '%U %A' "$HELPER_DST" 2> /dev/null || echo 'unknown')
if [ "$perms" != 'root -rwxr-xr-x' ]; then
    die "Refusing to continue, $HELPER_DST is $perms but must be root -rwxr-xr-x."
fi
info "Permissions of $HELPER_DST: $perms"

reload_polkit
info 'Passwordless restarting is now enabled.'

cat <<EOF

  The next time you pick "Restart to Windows…" no password will be
  requested. polkitd has been reloaded, so there is nothing else to do.

  To undo this:

      sudo $0 --uninstall
EOF
