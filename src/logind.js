/* logind.js
 *
 * A very small client for systemd-logind's D-Bus API.
 *
 * NOTE: the constructor is `GLib.Variant`. `Gio.Variant` is only the GObject
 * interface and is not constructible, so `new Gio.Variant('(b)', [false])`
 * throws "Variant is not a constructor" at runtime.
 *
 * NOTE: `Gio.DBus.makeProxyWrapper()` is `undefined` these days, the wrapper
 * lives at `Gio.DBusProxy.makeProxyWrapper()`. This module does not need it and
 * uses the bare connection, which is the most stable option of the three.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.freedesktop.login1';
const OBJECT_PATH = '/org/freedesktop/login1';
const INTERFACE = 'org.freedesktop.login1.Manager';

/**
 * Call a method on the logind manager over the system bus.
 *
 * @param {string} method
 * @param {GLib.Variant|null} parameters
 * @returns {Promise<GLib.Variant>}
 */
export function callMethod(method, parameters) {
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

/**
 * Reboot by asking logind directly.
 *
 * polkit ships `allow_active: yes` for `org.freedesktop.login1.reboot`, but
 * while a desktop session is running gnome-session holds a *strong block*
 * inhibitor on `shutdown`. logind then adds `POLKIT_ALWAYS_QUERY` to its check
 * of `org.freedesktop.login1.reboot-ignore-inhibit`, which is
 * `allow_active: auth_admin_keep`, so this normally shows a password prompt.
 *
 * Prefer `Reboot.now()` from reboot.js, which goes through gnome-session
 * instead. This is only the fallback for when there is no gnome-session.
 *
 * @returns {Promise<void>}
 */
export async function reboot() {
    await callMethod('Reboot', new GLib.Variant('(b)', [false]));
}
