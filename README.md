# RestartToWindows

A GNOME Shell extension that adds a **"Restart to Windows…"** entry to the
system menu in the quick settings, and reboots the machine straight into
Windows.

## Features

- One click (plus a confirmation dialog with a countdown) to reboot into
  Windows
- Talks to the UEFI boot entries directly, so it works with the stock
  Microsoft Boot Manager, no extra bootloader needed
- **No password prompt** once the optional setup below has been run
- Translated into 13 languages

## Requirements

- Linux with a UEFI firmware (this is what makes `BootNext` possible)
- A dual-boot setup with Windows installed under the Microsoft Boot Manager
- GNOME Shell 46 – 51
- `efibootmgr` (from the distribution's repositories, e.g.
  `sudo dnf install efibootmgr`)

Legacy BIOS systems cannot boot into another OS from Linux; this extension
cannot work there and says so instead of failing silently.

## Installation

```bash
git clone https://github.com/vedranbe/RestartToWindows
cd RestartToWindows
./build.sh      # compiles the translations and builds the zip
./install.sh    # installs and enables it
```

Then **log out and log back in**. A restart of GNOME Shell is required because
the extension adds an item to the quick settings menu, and GNOME 50 removed
X11 support, so an in-place shell reload (`Alt+F2`, `r`) is not available
any more.

## Restarting without a password

By default the extension runs `pkexec efibootmgr -n <entry>`, which asks for
your password every time. That is never really necessary: writing the UEFI
`BootNext` variable is the only privileged step, and rebooting afterwards goes
through systemd-logind, which already allows the active session to reboot
without authenticating.

So the extension ships a small setup that installs exactly two files:

| File | Purpose |
| --- | --- |
| `/usr/libexec/restart-to-windows` | A root-owned helper whose only job is to set `BootNext` to an existing boot entry. |
| `/usr/share/polkit-1/rules.d/49-restart-to-windows.rules` | A polkit rule that lets the *active local session* run that one helper, and nothing else, without a password prompt. |

Run it once:

```bash
sudo ~/.local/share/gnome-shell/extensions/RestartToWindows@vedranbe.github.com/setup-passwordless.sh
```

Or from a checkout of the repository:

```bash
sudo ./setup-passwordless.sh
```

The script reloads `polkitd` for you (it is a `Type=notify-reload` service, so
the new rule takes effect right away — no logout needed) and refuses to finish
if the helper did not end up root-owned and mode `0755`.

To undo:

```bash
sudo ./setup-passwordless.sh --uninstall
```

### Why this and not something simpler

`systemd-logind` does have a `SetRebootToBootLoaderEntry()` method, but it is
useless here: systemd validates the entry name with `efi_loader_entry_name_valid()`,
which only accepts alphanumerics and `+-_.@`, so `"Windows Boot Manager"` is
rejected outright. It also only works with boot loaders that advertise the
`entry-oneshot` feature, i.e. systemd-boot. Authorising one narrow, root-owned
helper through polkit works with every UEFI boot loader.

The helper cannot do anything except point `BootNext` at a boot entry that
already exists on the machine. It is installed root-owned and mode `0755`, the
polkit rule matches its absolute path only, and the script refuses anything
that is not a four digit hex entry id. Rebooting is still left to logind.

## Usage

1. Open the quick settings menu (the system/power area in the top bar).
2. Choose **"Restart to Windows…"**.
3. Wait for the countdown, or press **Restart** to go immediately, or
   **Cancel** (or <kbd>Esc</kbd>) to stay in Linux.

## Development

```bash
./build.sh            # po -> mo, assemble dist/, create the zip
./install.sh          # install and enable
./tests/smoke-test.js # parse + discovery + D-Bus tests, no GNOME Shell needed
```

The smoke test reads the machine's real UEFI boot entries and calls the real
systemd-logind (with `CanReboot`, never `Reboot`), so it verifies the
privileged parts without rebooting anything. It needs `efibootmgr` and a UEFI
machine.

Translations live in `po/`, compiled `.mo` files are generated into
`src/locale/` by `build.sh` and are not checked in. After changing a string in
`src/extension.js`, add it to the `po/*.po` files, for example:

```bash
msginit --no-translator -i po/de.po -l de    # only for a new language
msgmerge -U po/de.po po/template.pot
```

### Checking the log

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep RestartToWindows
```

## License

GPL-3.0-or-later. The metadata and the source headers say so; the README of
earlier revisions claimed MIT, which was wrong.
