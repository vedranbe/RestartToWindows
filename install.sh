#!/bin/bash

EXTENSION_UUID="RestartToWindows@vedranbe.github.com"

# Check if zip file exists
if [ ! -f "${EXTENSION_UUID}.zip" ]; then
    echo "Error: Extension zip file not found!"
    echo "Please run './build.sh' first to create the extension package."
    exit 1
fi

echo "Installing extension..."
gnome-extensions install --force "${EXTENSION_UUID}.zip"

# Wait a moment for the installation to complete
sleep 2

# Verify installation directory
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/${EXTENSION_UUID}"
if [ ! -d "$EXTENSION_DIR" ]; then
    echo "Error: Extension directory not found after installation!"
    exit 1
fi

echo "Extension installed successfully at: $EXTENSION_DIR"

# Get current extensions and add new one
CURRENT_EXTENSIONS=$(dconf read /org/gnome/shell/enabled-extensions)
if [ -z "$CURRENT_EXTENSIONS" ] || [ "$CURRENT_EXTENSIONS" = "@as []" ]; then
    # No extensions currently enabled
    dconf write /org/gnome/shell/enabled-extensions "['$EXTENSION_UUID']"
else
    # Remove brackets and append new extension
    CURRENT_EXTENSIONS=${CURRENT_EXTENSIONS:1:-1}  # Remove [ and ]
    if [[ ! $CURRENT_EXTENSIONS =~ $EXTENSION_UUID ]]; then
        if [ -n "$CURRENT_EXTENSIONS" ]; then
            dconf write /org/gnome/shell/enabled-extensions "[$CURRENT_EXTENSIONS, '$EXTENSION_UUID']"
        else
            dconf write /org/gnome/shell/enabled-extensions "['$EXTENSION_UUID']"
        fi
    fi
fi

if [ "$XDG_SESSION_TYPE" = "x11" ]; then
    echo "Restarting GNOME Shell (X11)..."

    # Restart GNOME Shell
    dbus-send --session --type=method_call \
              --dest=org.gnome.Shell /org/gnome/Shell \
              org.gnome.Shell.Eval string:'global.reexec_self();'

    sleep 3
    echo "For the changes to take effect, you need to either:"
    echo "1. Log out and log back in"
    echo "2. Press Alt+F2, type 'r' and press Enter (if enabled)"
else
    echo "Running under Wayland session"
    echo "For the changes to take effect, you need to either:"
    echo "1. Log out and log back in"
    echo "2. Press Alt+F2, type 'r' and press Enter (if enabled)"
fi

echo "Installation complete!"
