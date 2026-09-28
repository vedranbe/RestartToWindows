#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail

EXTENSION_NAME="RestartToWindows@vedranbe.github.com"
SRC_DIR="src"
DIST_DIR="dist"

# ---------------------------------------------------------------------------
# Translations
# ---------------------------------------------------------------------------

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() {
    printf '\033[1;31m==> %s\033[0m\n' "$*" >&2
    exit 1
}

command -v msgfmt > /dev/null || die 'msgfmt is required (install the gettext package).'

info 'Compiling translations'
(
    cd po
    shopt -s nullglob
    for pofile in *.po; do
        [[ -s "$pofile" ]] || continue

        lang="${pofile%.po}"
        target_dir="../${SRC_DIR}/locale/${lang}/LC_MESSAGES"
        mkdir -p "$target_dir"
        msgfmt "$pofile" -o "${target_dir}/${EXTENSION_NAME}.mo"
        printf '    %s\n' "$lang"
    done
)

# ---------------------------------------------------------------------------
# Assemble the extension
# ---------------------------------------------------------------------------

info 'Assembling the extension'
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

cp -r "$SRC_DIR"/. "$DIST_DIR"/
cp metadata.json "$DIST_DIR"/

if [[ -d "${SRC_DIR}/schemas" ]]; then
    cp -r "${SRC_DIR}/schemas" "$DIST_DIR"/
    glib-compile-schemas "$DIST_DIR"/schemas/
fi

# Shipped so that the passwordless setup can be run straight from the
# installed extension, without needing a checkout of the repository.
mkdir -p "$DIST_DIR"/{helper,polkit}
cp helper/restart-to-windows "$DIST_DIR"/helper/
cp polkit/49-restart-to-windows.rules "$DIST_DIR"/polkit/
cp setup-passwordless.sh "$DIST_DIR"/
chmod +x "$DIST_DIR"/setup-passwordless.sh "$DIST_DIR"/helper/restart-to-windows

# ---------------------------------------------------------------------------
# Zip
# ---------------------------------------------------------------------------

info 'Creating the zip'
rm -f "${EXTENSION_NAME}.zip"
(cd "$DIST_DIR" && zip -qr "../${EXTENSION_NAME}.zip" . -x '.*')

info "Done: ${EXTENSION_NAME}.zip and ${DIST_DIR}/"
echo
echo "To enable restarting without a password prompt, run this once:"
echo
echo "    sudo ~/.local/share/gnome-shell/extensions/${EXTENSION_NAME}/setup-passwordless.sh"
echo
