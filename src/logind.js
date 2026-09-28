/* logind.js
 *
 * systemd-logind's reboot method, over the system bus.
 *
 * polkit ships `allow_active: yes` for `org.freedesktop.login1.reboot`, so the
 * user sitting at the machine may reboot without authenticating. That is what
 * makes the second half of a restart to Windows password free. Verified on
 * systemd 259 / Fedora 44.
 *
 * The call is made on the bare connection rather than through
 * `Gio.DBusProxy.makeProxyWrapper()` or a `Gio.DBusProxy` subclass: the former
 * was removed in GJS 1.88 (GNOME 50), and the proxy conveniences it used to
 * add (`RebootAsync()` and friends) went with it.
 *
 * Note that logind's `SetRebootToBootLoaderEntry()` is deliberately *not* used
 * as a shortcut here. systemd only accepts loader entry *file names* built
 * from alphanumerics and "+-_.@" (`efi_loader_entry_name_valid()`), so it
 * rejects "Windows Boot Manager" outright, and it additionally needs a boot
 * loader that advertises the `entry-oneshot` feature. Writing the UEFI
 * `BootNext` variable through a small authorised helper is the portable way.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from 'gi://Gio';

const BUS_NAME = 'org.freedesktop.login1';
const OBJECT_PATH = '/org/freedesktop/login1';
const INTERFACE = 'org.freedesktop.login1.Manager';

/**
 * @param {string} method
 * @param {GLib.Variant|null} parameters
 * @returns {Promise<GLib.Variant>}
 */
function call(method, parameters) {
    return new Promise((resolve, reject) => {
        Gio.DBus.system.call(
            BUS_NAME, OBJECT_PATH, INTERFACE, method,
            parameters, null,
            Gio.DBusCallFlags.NONE, -1, null,
            (connection, result) => {
                try {
                    resolve(connection.call_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
}

export const Logind = class Logind {
    /**
     * Reboot now, without asking for a password.
     */
    static async reboot() {
        await call('Reboot', new Gio.Variant('(b)', [false]));
    }
};
