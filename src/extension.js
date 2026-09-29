/* extension.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {
    Extension,
    gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import {RebootCancelledError} from './cancel.js';
import {
    AuthenticationCancelledError,
    EFIBootManager,
} from './efibootmgr.js';
import {Reboot} from './reboot.js';
import {Log} from './utils.js';

/* How often to retry attaching the menu item while the panel is not up yet. */
const ATTACH_RETRIES = 50;

/**
 * Backstop for a cancelled restart.
 *
 * The confirmation is GNOME's own "Restart" dialog, and cancelling it comes back
 * to us so the BootNext can be taken off again straight away. If the shell dies
 * before that, or the undo itself fails, the machine is still up this long after
 * we asked for a reboot, which means nothing happened, so clean up here. If the
 * reboot really happens this timer simply dies with the shell.
 */
const BOOTNEXT_WATCHDOG_SECONDS = 5 * 60;

export default class RestartToWindowsExtension extends Extension {
    /** @type {import('../ui/popupMenu.js').PopupMenu|null} */
    _menu = null;
    /** @type {import('../ui/popupMenu.js').PopupBaseMenuItem|null} */
    _menuItem = null;
    /** @type {ModalDialog.ModalDialog|null} */
    _dialog = null;
    _attachSourceId = 0;
    _attachRetries = ATTACH_RETRIES;
    _bootNextWatchdogId = 0;
    _passwordlessHintShown = false;
    /** Set synchronously, so a double click cannot start two restarts. */
    _restarting = false;
    /** @type {string|null} the BootNext that was set before we touched it */
    _previousBootNext = null;

    /* ------------------------------------------------------------------ */
    /* Extension life cycle                                                */
    /* ------------------------------------------------------------------ */

    enable() {
        this._attach();
    }

    disable() {
        this._removeAttachTimeout();
        this._removeBootNextWatchdog();
        this._destroyDialog();
        this._menuItem?.destroy();
        this._menuItem = null;
        this._menu = null;
        this._restarting = false;
    }

    /* ------------------------------------------------------------------ */
    /* Menu item                                                           */
    /* ------------------------------------------------------------------ */

    _attach() {
        const quickSettings = Main.panel?.statusArea?.quickSettings;
        if (!quickSettings && this._attachRetries-- > 0) {
            // The panel is not built yet, try again once the main loop is idle.
            this._removeAttachTimeout();
            this._attachSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._attachSourceId = 0;
                this._attach();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        this._attachRetries = ATTACH_RETRIES;

        if (!quickSettings) {
            Log('gave up waiting for the quick settings');
            return;
        }

        const menu = this._findSystemMenu(quickSettings);
        if (menu === null) {
            Log('could not find the system menu in the quick settings');
            return;
        }

        this._menu = menu;
        this._menuItem = new PopupMenu.PopupMenuItem(_('Restart to Windows…'));
        this._menuItem.connect('activate', () => this._onMenuItemActivated());

        // Put it next to "Restart…" and "Power Off…", i.e. right before the
        // separator that GNOME puts above "Log Out…".
        const items = menu._getMenuItems?.() ?? [];
        const separatorIndex =
            items.findIndex(item => item instanceof PopupMenu.PopupSeparatorMenuItem);
        if (separatorIndex >= 0)
            menu.addMenuItem(this._menuItem, separatorIndex);
        else
            menu.addMenuItem(this._menuItem);

        Log('menu item added to the system menu');
    }

    /**
     * The system indicator's first quick settings item owns the menu that
     * holds Suspend / Restart… / Power Off….
     */
    _findSystemMenu(quickSettings) {
        const items = quickSettings._system?.quickSettingsItems ?? [];
        for (const item of items) {
            if (item?.menu)
                return item.menu;
        }

        return null;
    }

    _removeAttachTimeout() {
        if (this._attachSourceId) {
            GLib.Source.remove(this._attachSourceId);
            this._attachSourceId = 0;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Confirmation                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Nothing at all is armed yet at this point: no BootNext, no reboot
     * request, no timer. Cancelling here is therefore completely inert.
     *
     * This dialog is deliberately a plain question with no countdown. A
     * countdown that acts on its own is exactly the hazard this replaces: GNOME's
     * own restart dialog auto-confirms when its timer runs out, which is why an
     * earlier version of this extension could reboot the machine even after
     * Cancel had been pressed.
     */
    _onMenuItemActivated() {
        if (this._restarting || this._dialog !== null)
            return;
        this._restarting = true;

        Main.panel?.closeQuickSettings();

        const dialog = new ModalDialog.ModalDialog();
        dialog.setButtons([
            {
                label: _('Cancel'),
                action: () => this._destroyDialog(),
                key: Clutter.KEY_Escape,
            },
            {
                label: _('Restart'),
                action: () => {
                    this._destroyDialog();
                    this._restart();
                },
            },
        ]);

        const title = new St.Label({
            text: _('Restart to Windows'),
            style_class: 'message-dialog-title',
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        const description = new St.Label({
            text: _('The computer will restart into Windows.'),
            style_class: 'message-dialog-description',
        });
        description.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        description.clutter_text.line_wrap = true;

        const content = new St.BoxLayout({
            style_class: 'message-dialog-content',
            // St dropped the `vertical` property in GNOME 51.
            orientation: Clutter.Orientation.VERTICAL,
        });
        content.add_child(title);
        content.add_child(description);
        dialog.contentLayout.add_child(content);

        this._dialog = dialog;
        dialog.connect('closed', () => {
            this._dialog = null;
            // Cancelled before anything was armed.
            this._restarting = false;
        });
        dialog.open();
    }

    _destroyDialog() {
        const dialog = this._dialog;
        this._dialog = null;
        dialog?.close();
    }

    /* ------------------------------------------------------------------ */
    /* Restarting                                                          */
    /* ------------------------------------------------------------------ */

    async _restart() {
        try {
            if (!EFIBootManager.isAvailable()) {
                Main.notifyError(
                    _('Restart to Windows'),
                    _('efibootmgr is required by this extension. Please install it and try again.'));
                return;
            }

            const entry = await EFIBootManager.findWindowsBootManager();
            if (entry === null) {
                Main.notifyError(
                    _('Restart to Windows'),
                    _('Could not find the Windows Boot Manager entry in the UEFI boot entries. Is this a dual-boot system?'));
                return;
            }

            if (EFIBootManager.findHelper() === null)
                this._showPasswordlessHint();

            // Remember what was there so a cancelled restart can put it back.
            this._previousBootNext = await EFIBootManager.readBootNext();

            const result = await EFIBootManager.setNextBoot(entry);
            Log(`next boot set to ${entry.id} (${entry.label}) via ${result.method}`);

            this._armBootNextWatchdog(this._previousBootNext);

            // Puts up GNOME's own "Restart" confirmation, which carries a
            // countdown and will reboot by itself when that runs out. Resolves
            // once the user answered it, throws RebootCancelledError on Cancel.
            await Reboot.now();
        } catch (error) {
            this._restarting = false;

            if (error instanceof RebootCancelledError ||
                error instanceof AuthenticationCancelledError) {
                Log('the restart was cancelled, undoing the pending boot entry');
                this._undoBootNext(this._previousBootNext);
                return;
            }

            logError(error, 'RestartToWindows: failed to restart to Windows');
            Main.notifyError(
                _('Restart to Windows'),
                `${_('Failed to restart to Windows.')} ${error.message}`);
        }
    }

    /**
     * Put our BootNext back the way we found it.
     *
     * BootNext is a one-shot that the firmware only forgets after an actual
     * boot, so leaving it behind would send the next, unrelated reboot to
     * Windows as well.
     */
    async _undoBootNext(previous) {
        this._removeBootNextWatchdog();

        try {
            const current = await EFIBootManager.readBootNext();
            if (current === null) {
                Log('the pending boot entry was already cleared, nothing to undo');
                return;
            }

            if (previous !== null) {
                // Restore what was there before us rather than clearing a value
                // we did not set.
                const entries = await EFIBootManager.listEntries();
                const original = entries.find(entry => entry.id === previous);
                if (original) {
                    await EFIBootManager.setNextBoot(original);
                    Log(`restored the pending boot entry to ${original.id} (${original.label})`);
                    return;
                }
            }

            await EFIBootManager.clearBootNext();
            Log('cleared the pending boot entry after a cancelled restart');
        } catch (error) {
            logError(error, 'RestartToWindows: could not clear the pending boot entry');
            Main.notifyError(
                _('Restart to Windows'),
                `${_('The pending Windows boot entry could not be cleared, so the next restart may still go to Windows.')} ${error.message}`);
        }
    }

    _armBootNextWatchdog(previous) {
        this._removeBootNextWatchdog();
        this._bootNextWatchdogId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, BOOTNEXT_WATCHDOG_SECONDS, () => {
                this._bootNextWatchdogId = 0;
                this._undoBootNext(previous);
                return GLib.SOURCE_REMOVE;
            });
    }

    _removeBootNextWatchdog() {
        if (this._bootNextWatchdogId !== 0) {
            GLib.Source.remove(this._bootNextWatchdogId);
            this._bootNextWatchdogId = 0;
        }
    }

    _showPasswordlessHint() {
        if (this._passwordlessHintShown)
            return;
        this._passwordlessHintShown = true;

        Main.notify(
            _('Restart to Windows'),
            _('Run the bundled setup-passwordless.sh script as root once to restart to Windows without being asked for a password.'));
    }
}
