/* reboot.js
 *
 * Rebooting the machine once the UEFI boot entry has been set.
 *
 * The reboot deliberately does NOT go straight to
 * `org.freedesktop.login1.Manager.Reboot()`. While a desktop session is
 * running, gnome-session always holds a *strong block* inhibitor on
 * `shutdown`, and logind reacts to a strong blocker by adding
 * `POLKIT_ALWAYS_QUERY` to its check of
 * `org.freedesktop.login1.reboot-ignore-inhibit`. That action ships
 * `allow_active: auth_admin_keep`, so a direct `Reboot()` reliably pops an
 * authentication dialog. You can observe it:
 *
 *     systemd-inhibit --list | grep shutdown
 *     # gnome-session-s  vedran  gnome-session  shutdown  user session inhibited  block
 *
 *     gdbus call --system --dest org.freedesktop.login1 \
 *         --object-path /org/freedesktop/login1 \
 *         --method org.freedesktop.login1.Manager.CanReboot
 *     # -> ('challenge',)
 *
 * Asking gnome-session to reboot instead, which is exactly what GNOME's own
 * "Restart…" menu item does, drops that inhibitor first and so needs no
 * password. `misc/gnomeSession.js` has exported `SessionManager` since well
 * before GNOME 46 and is what `misc/systemActions.js` uses.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as GnomeSession from 'resource:///org/gnome/shell/misc/gnomeSession.js';

import {
    RebootCancelledError,
    isCancellation,
    isServiceUnavailable,
} from './cancel.js';
import {reboot as rebootViaLogind} from './logind.js';
import {Log} from './utils.js';

export {RebootCancelledError};

let _sessionManager = null;

function _getSessionManager() {
    // `SessionManager()` is a factory that returns a ready proxy. GNOME's own
    // code calls it with `new`, which is harmless because a constructor that
    // returns an object has that object win.
    if (_sessionManager === null)
        _sessionManager = new GnomeSession.SessionManager();

    return _sessionManager;
}

export const Reboot = class Reboot {
    /**
     * Reboot the machine now.
     *
     * Prefers gnome-session, which needs no password but does put up its own
     * standard "Restart" confirmation. That confirmation is honoured: cancelling
     * it means no reboot at all, and no attempt to reboot by another route
     * either.
     *
     * logind is only used when gnome-session is genuinely not there, because
     * that is a failure rather than a decision. It may then ask for a password,
     * see logind.js.
     *
     * @returns {Promise<void>}
     * @throws {RebootCancelledError} when the user dismissed the confirmation
     */
    static async now() {
        try {
            await _getSessionManager().RebootAsync();
            return;
        } catch (error) {
            if (isCancellation(error)) {
                Log('the restart was cancelled, not rebooting');
                throw new RebootCancelledError(error);
            }

            if (isServiceUnavailable(error)) {
                Log(`gnome-session is not available (${error.message}), using logind`);
                await rebootViaLogind();
                return;
            }

            // The request did reach gnome-session and still failed. Rebooting
            // by another route now could happen after the user refused, so
            // report it and leave the decision to them. The caller takes the
            // BootNext back off.
            Log(`gnome-session could not reboot: ${error.message}`);
            throw error;
        }
    }
};
