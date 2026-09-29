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
- GNOME Shell 46 – 50
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

Two separate steps need privileges, and only one of them really does.

**Writing the UEFI `BootNext` variable** needs root. By default the extension
runs `pkexec efibootmgr -n <entry>`, which asks for your password every time.
That is never necessary, because setting `BootNext` is a very narrow operation:
the extension ships a setup that installs exactly two files.

| File | Purpose |
| --- | --- |
| `/usr/libexec/restart-to-windows` | A root-owned helper that sets `BootNext` to an existing boot entry, or deletes it again. |
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

**Rebooting** needs no privileges at all, but it does need the right API. A
direct `org.freedesktop.login1.Manager.Reboot()` is a trap: while a desktop
session is running, `gnome-session` always holds a strong block inhibitor on
`shutdown`, and logind reacts to a strong blocker by adding
`POLKIT_ALWAYS_QUERY` to its check of
`org.freedesktop.login1.reboot-ignore-inhibit`, which is
`allow_active: auth_admin_keep`. So a direct `Reboot()` reliably pops a
password dialog, even though `org.freedesktop.login1.reboot` itself is
`allow_active: yes`. You can see it happening:

```bash
systemd-inhibit --list | grep shutdown
# gnome-session-s  vedran  gnome-session  shutdown  user session inhibited  block

gdbus call --system --dest org.freedesktop.login1 \
    --object-path /org/freedesktop/login1 \
    --method org.freedesktop.login1.Manager.CanReboot
# ('challenge',)
```

The extension therefore reboots through `org.gnome.SessionManager.Reboot()`,
which is exactly what GNOME's own "Restart…" menu item does. `gnome-session`
drops its own inhibitor first, so no password is needed.

gnome-session always puts up its own **"Restart"** confirmation, with a
countdown. That is unavoidable, and it has one sharp edge: **it auto-confirms
when the countdown reaches zero**, which reboots the machine. From GNOME's
`js/ui/endSessionDialog.js`:

```js
_startTimer() {
    …
    this._secondsLeft = this._totalSecondsToStayOpen - secondsElapsed;
    if (this._secondsLeft > 0) { …; return GLib.SOURCE_CONTINUE; }
    this._confirm(button.signal)          // ← acts on its own
}
```

So GNOME's dialog on its own is not a safe confirmation for an irreversible
action: press Cancel a moment too late, or miss it, and the machine goes anyway.

The extension therefore keeps a plain confirmation of its own in front of it:

1. **"Restart to Windows"** — Cancel / Restart, no countdown. Nothing is armed
   yet at this point: no boot entry set, no reboot requested, no timer. Cancel
   here is completely inert.
2. **GNOME's "Restart"** — only after you pressed Restart. Its countdown may
   now act on its own, because you already said yes. Cancel still works, and
   cancels.

That is two windows rather than one, which is the price of never rebooting
somebody's machine by surprise. See "One window instead" below for the
alternatives.

Cancelling at step 2 genuinely cancels: the extension does nothing and takes the
pending boot entry back off again. An earlier version treated gnome-session's
`Operation was cancelled` as a failure and fell through to logind, so pressing
Cancel still rebooted the machine. Cancellation is a decision, not an error, and
is now handled as one.

### One window instead

If you would rather have a single window, there are two ways, both with a cost:

- **Authorise `org.freedesktop.login1.reboot-ignore-inhibit`** for the active
  session in the polkit rule. The extension could then reboot through logind
  directly and GNOME's dialog would never appear, so the extension's own
  confirmation would be the only one. The cost is real though: the active user
  could then reboot while ignoring other applications' "do not shut down"
  requests, which GNOME deliberately honours.
- **Auto-confirm gnome-session's dialog** from the extension as soon as it
  appears. The cost here is that it depends on the shell's internal
  `org.gnome.SessionManager.EndSessionDialog` object, which is exported
  without usable introspection, so it could break silently in a future GNOME.

### Not leaving a stray BootNext behind

`BootNext` is a one-shot that the firmware only forgets after an actual boot. If
the reboot is cancelled after `BootNext` was set, the next unrelated reboot
would silently go to Windows. The extension guards against that: five minutes
after asking for a reboot it checks whether the machine is still up, and if it
is, it puts `BootNext` back the way it found it. A stale one can also be removed
by hand at any time:

```bash
pkexec /usr/libexec/restart-to-windows none
efibootmgr -v | grep BootNext    # no line means it is gone
```

### Why not something simpler

`systemd-logind` also has a `SetRebootToBootLoaderEntry()`, but it is useless
here: systemd validates the entry name with `efi_loader_entry_name_valid()`,
which only accepts alphanumerics and `+-_.@`, so `"Windows Boot Manager"` is
rejected outright. It also only works with boot loaders that advertise the
`entry-oneshot` feature, i.e. systemd-boot. Authorising one narrow, root-owned
helper through polkit works with every UEFI boot loader.

The helper cannot do anything except point `BootNext` at a boot entry that
already exists on the machine. It is installed root-owned and mode `0755`, the
polkit rule matches its absolute path only, and the script refuses anything
that is not a four digit hex entry id.

## Usage

1. Open the quick settings menu (the system/power area in the top bar).
2. Choose **"Restart to Windows…"**.
3. Confirm with **Restart**, or **Cancel** (or <kbd>Esc</kbd>) to do nothing at
   all.
4. GNOME shows its own **Restart** countdown. Let it run out, or press
   **Cancel** there, which also takes the pending Windows boot entry back off.

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
