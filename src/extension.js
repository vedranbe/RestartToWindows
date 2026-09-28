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

import {
    AuthenticationCancelledError,
    EFIBootManager,
} from './efibootmgr.js';
import {Logind} from './logind.js';
import {Log} from './utils.js';

const COUNTDOWN_SECONDS = 60;

/* How often to retry attaching the menu item while the panel is not up yet. */
const ATTACH_RETRIES = 50;

export default class RestartToWindowsExtension extends Extension {
    /** @type {import('../ui/popupMenu.js').PopupMenu|null} */
    _menu = null;
    /** @type {import('../ui/popupMenu.js').PopupBaseMenuItem|null} */
    _menuItem = null;
    /** @type {ModalDialog.ModalDialog|null} */
    _dialog = null;
    /** @type {St.Label|null} */
    _countdownLabel = null;
    /** @type {number} */
    _countdown = 0;
    _deadline = 0;
    _countdownSourceId = 0;
    _labelSourceId = 0;
    _attachSourceId = 0;
    _attachRetries = ATTACH_RETRIES;
    _passwordlessHintShown = false;
    /** @type {import('./efibootmgr.js').BootEntry|null} */
    _entry = null;

    /* ------------------------------------------------------------------ */
    /* Extension life cycle                                                */
    /* ------------------------------------------------------------------ */

    enable() {
        this._attach();
    }

    disable() {
        this._removeAttachTimeout();
        this._destroyDialog();
        this._menuItem?.destroy();
        this._menuItem = null;
        this._menu = null;
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
        this._menuItem.connect('activate', () => {
            this._onMenuItemActivated().catch(error => {
                logError(error, 'RestartToWindows: unexpected failure');
                Main.notifyError(
                    _('Restart to Windows'),
                    `${_('Failed to restart to Windows.')} ${error.message}`);
            });
        });

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
    /* Confirmation dialog                                                 */
    /* ------------------------------------------------------------------ */

    async _onMenuItemActivated() {
        if (this._dialog !== null)
            return;

        Main.panel?.closeQuickSettings();

        if (!EFIBootManager.isAvailable()) {
            Main.notifyError(
                _('Restart to Windows'),
                _('efibootmgr is required by this extension. Please install it and try again.'));
            return;
        }

        let entry;
        try {
            entry = await EFIBootManager.findWindowsBootManager();
        } catch (error) {
            logError(error, 'RestartToWindows: could not read the UEFI boot entries');
            Main.notifyError(
                _('Restart to Windows'),
                `${_('Failed to restart to Windows.')} ${error.message}`);
            return;
        }

        if (entry === null) {
            Main.notifyError(
                _('Restart to Windows'),
                _('Could not find the Windows Boot Manager entry in the UEFI boot entries. Is this a dual-boot system?'));
            return;
        }

        this._entry = entry;
        this._startCountdown();
        this._dialog = this._buildDialog();
        this._dialog.connect('closed', () => {
            this._dialog = null;
            this._countdownLabel = null;
            this._stopCountdown();
        });
        this._dialog.open();
    }

    _buildDialog() {
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
                    this._reboot();
                },
            },
            // NOTE: no default button on purpose, so that a stray Enter cannot
            // reboot into Windows without the countdown having been seen.
        ]);

        // `message-dialog-title` and `message-dialog-description` already
        // centre their text, so no alignment enum is needed here. That is
        // deliberate: Clutter.ActorAlign was renamed in some versions and
        // Clutter.ActorAlignment does not exist at all on GNOME 50.
        const titleLabel = new St.Label({
            text: _('Restart to Windows'),
            style_class: 'message-dialog-title',
        });
        titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        this._countdownLabel = new St.Label({
            text: this._countdownText(),
            style_class: 'message-dialog-description',
        });
        this._countdownLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._countdownLabel.clutter_text.line_wrap = true;

        const content = new St.BoxLayout({
            style_class: 'message-dialog-content',
            // NOTE: St widgets dropped the `vertical` property in GNOME 51,
            // `orientation` has to be used instead.
            orientation: Clutter.Orientation.VERTICAL,
        });
        content.add_child(titleLabel);
        content.add_child(this._countdownLabel);

        dialog.contentLayout.add_child(content);

        return dialog;
    }

    _countdownText() {
        return _('The system will restart to Windows in %d seconds.').replace(
            '%d', this._countdown);
    }

    /**
     * The remaining seconds are derived from a deadline rather than counted
     * down, so a tick that arrives late (or is coalesced) cannot make the
     * countdown drift.
     */
    _tickCountdown() {
        this._countdown = Math.max(
            0, Math.ceil((this._deadline - GLib.get_monotonic_time()) / GLib.USEC_PER_SEC));
        return this._countdown;
    }

    _startCountdown() {
        this._deadline = GLib.get_monotonic_time() +
            COUNTDOWN_SECONDS * GLib.USEC_PER_SEC;
        this._tickCountdown();

        this._labelSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._countdownLabel?.set_text(this._countdownText());
            return GLib.SOURCE_CONTINUE;
        });

        this._countdownSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._countdownSourceId = 0;
            if (this._tickCountdown() > 0)
                return GLib.SOURCE_CONTINUE;

            this._destroyDialog();
            this._reboot();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopCountdown() {
        for (const id of [this._countdownSourceId, this._labelSourceId]) {
            if (id)
                GLib.Source.remove(id);
        }
        this._countdownSourceId = 0;
        this._labelSourceId = 0;
    }

    _destroyDialog() {
        this._stopCountdown();

        const dialog = this._dialog;
        this._dialog = null;
        this._countdownLabel = null;

        dialog?.close();
    }

    /* ------------------------------------------------------------------ */
    /* Restarting                                                          */
    /* ------------------------------------------------------------------ */

    async _reboot() {
        try {
            const entry = this._entry ?? await EFIBootManager.findWindowsBootManager();
            if (entry === null)
                throw new Error('no Windows boot entry found');

            if (EFIBootManager.findHelper() === null)
                this._showPasswordlessHint();

            const result = await EFIBootManager.setNextBoot(entry);
            Log(`next boot set to ${entry.id} (${entry.label}) via ${result.method}`);

            await Logind.reboot();
        } catch (error) {
            if (error instanceof AuthenticationCancelledError) {
                Log('authentication was cancelled, not restarting');
                return;
            }

            logError(error, 'RestartToWindows: failed to restart to Windows');
            Main.notifyError(
                _('Restart to Windows'),
                `${_('Failed to restart to Windows.')} ${error.message}`);
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
