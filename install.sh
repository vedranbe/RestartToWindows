#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail

UUID="RestartToWindows@vedranbe.github.com"
PKG="${UUID}.zip"
EXTENSION_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() {
    printf '\033[1;31m==> %s\033[0m\n' "$*" >&2
    exit 1
}

[[ -f "$PKG" ]] || die "Please run ./build.sh first, ${PKG} is missing."

info "Installing ${UUID}"
gnome-extensions install --force "$PKG"

[[ -d "$EXTENSION_DIR" ]] || die "Expected the extension in ${EXTENSION_DIR}, but it is not there."

info "Enabling the extension"
if ! gnome-extensions enable "$UUID" 2> /dev/null; then
    # gnome-extensions enable needs a running session bus, fall back to dconf.
    current=$(gsettings get org.gnome.shell enabled-extensions)
    if [[ "$current" == "@as []" ]]; then
        gsettings set org.gnome.shell enabled-extensions "['${UUID}']"
    elif [[ "$current" != *"'$UUID'"* ]]; then
        gsettings set org.gnome.shell enabled-extensions "${current%]}], '${UUID}']"
    fi
fi

info "Installed into ${EXTENSION_DIR}"

# A restarted shell is required because the extension adds an item to the
# quick settings menu, and GNOME 50 dropped X11 support, so an in place
# shell reload is not an option any more.
echo
echo "Log out and log back in (or restart) to start using the extension."
echo
echo "To also make it restart into Windows without asking for your password,"
echo "run this once:"
echo
echo "    sudo ${EXTENSION_DIR}/setup-passwordless.sh"
echo
