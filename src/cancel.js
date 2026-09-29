/* cancel.js
 *
 * Recognising "the user said no" in a D-Bus error.
 *
 * This lives on its own so it can be unit tested; reboot.js imports
 * resource:///org/gnome/shell/... and therefore cannot be loaded outside a
 * running shell.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from 'gi://Gio';

/**
 * Thrown when the user dismissed a confirmation dialog instead of confirming.
 *
 * This is an *answer*, not a failure. Retrying it by another route would do the
 * exact thing the user just refused.
 */
export class RebootCancelledError extends Error {
    constructor(cause = null) {
        super('the restart was cancelled');
        this.name = 'RebootCancelledError';
        this.cause = cause;
    }
}

/**
 * Did the user dismiss the confirmation?
 *
 * gnome-session reports this as `G_IO_ERROR_CANCELLED`, which arrives as
 * "Operation was cancelled". The message is checked as well, because the
 * GDBus error domain is not fully introspected in every GJS version.
 */
export function isCancellation(error) {
    if (error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        return true;

    return /\bcancel+ed\b/i.test(error?.message ?? '');
}

/**
 * Is gnome-session simply not there, or too old to have the method?
 *
 * Only then is it safe to reboot by another route. If the request did reach
 * gnome-session and still failed, guessing with a second mechanism could reboot
 * the machine after the user refused, so that case must not fall back.
 */
export function isServiceUnavailable(error) {
    const codes = [
        Gio.DBusError.SERVICE_UNKNOWN,
        Gio.DBusError.NAME_HAS_NO_OWNER,
        Gio.DBusError.UNKNOWN_METHOD,
        Gio.DBusError.UNKNOWN_INTERFACE,
        Gio.DBusError.UNKNOWN_OBJECT,
    ];

    if (codes.some(code => code !== undefined && error?.matches?.(Gio.DBusError, code)))
        return true;

    // The GDBus error domain is not fully introspected in every GJS version, so
    // fall back to the wording GLib uses.
    return /\b(?:not activatable|not provided by any|was not provided|no such (?:file|interface|name)|unknown (?:method|interface|object)|not available|not supported)\b/i
        .test(error?.message ?? '');
}
