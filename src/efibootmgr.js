/* efibootmgr.js
 *
 * Everything needed to make the firmware boot into Windows on the next boot.
 *
 * Reading the UEFI boot entries needs no privileges at all. Writing the next
 * boot entry does, so there are two strategies:
 *
 *  1. The small root-owned helper installed by `setup-passwordless.sh`,
 *     started through pkexec. Because a polkit rule authorises exactly that
 *     one helper for the active session, no password prompt appears.
 *  2. `pkexec efibootmgr -n <id>`, the old behaviour. This always works but
 *     asks for a password.
 *
 * The actual reboot is left to gnome-session, see reboot.js.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {ExecCommand, FindFirstExistingFile, Log} from './utils.js';

const EFIBOOTMGR_PATHS = [
    '/usr/bin/efibootmgr',
    '/usr/sbin/efibootmgr',
    '/bin/efibootmgr',
    '/sbin/efibootmgr',
];

const PKEXEC_PATHS = [
    '/usr/bin/pkexec',
    '/bin/pkexec',
    '/usr/sbin/pkexec',
    '/sbin/pkexec',
];

/* Installed by setup-passwordless.sh, either of the two locations. */
const HELPER_PATHS = [
    '/usr/libexec/restart-to-windows',
    '/usr/local/libexec/restart-to-windows',
];

const WINDOWS_BOOT_MANAGER = 'Windows Boot Manager';

/* Argument understood by the helper: delete BootNext instead of setting it. */
const CLEAR_BOOT_NEXT = 'none';

/* pkexec exit codes, see pkexec(1). */
const EXIT_AUTH_DISMISSED = 126;
const EXIT_AUTH_NOT_AUTHORIZED = 127;

/* Thrown when the user closes the polkit authentication dialog. */
export class AuthenticationCancelledError extends Error {
    constructor() {
        super('Authentication was cancelled');
        this.name = 'AuthenticationCancelledError';
    }
}

/* `Boot0001* Windows Boot Manager  HD(1,GPT,…)/File(\EFI\Microsoft\…)` */
const ENTRY_RE = /^Boot([0-9A-Fa-f]{4})([* ])\s*(.*)$/;

/* efibootmgr pads the description to a fixed width, so split it off at the
 * device path rather than at whitespace. */
const DEVICE_PATH_RE =
    /\s(?:HD|File|ACPI|FvFile|Fv|MemoryMapped|PciRoot|USB|End|S)\(/;

export class EFIBootManager {
    static findEfiBootMgr() {
        return FindFirstExistingFile(EFIBOOTMGR_PATHS);
    }

    static findPkexec() {
        return FindFirstExistingFile(PKEXEC_PATHS) ?? 'pkexec';
    }

    /** Absolute path of the passwordless helper, or null when not installed. */
    static findHelper() {
        return FindFirstExistingFile(HELPER_PATHS);
    }

    static isAvailable() {
        return this.findEfiBootMgr() !== null;
    }

    /**
     * @typedef {{id: string, label: string, active: boolean}} BootEntry
     */

    static _parseEntries(output) {
        const entries = [];

        for (const line of output.split('\n')) {
            const match = ENTRY_RE.exec(line);
            if (!match)
                continue;

            const rest = match[3];
            const pathStart = DEVICE_PATH_RE.exec(rest);

            entries.push({
                id: match[1].toUpperCase(),
                label: (pathStart ? rest.slice(0, pathStart.index) : rest).trim(),
                active: match[2] === '*',
            });
        }

        return entries;
    }

    /**
     * Read the raw `efibootmgr -v` output. Reading needs no privileges.
     *
     * @returns {Promise<string>}
     */
    static async _readOutput() {
        const binary = this.findEfiBootMgr();
        if (binary === null)
            throw new Error('efibootmgr is not installed');

        const [status, stdout, stderr] = await ExecCommand([binary, '-v']);
        if (status !== 0)
            throw new Error(`efibootmgr -v failed: ${stderr.trim() || status}`);

        return stdout;
    }

    /** @returns {Promise<BootEntry[]>} */
    static async listEntries() {
        return this._parseEntries(await this._readOutput());
    }

    /**
     * The boot entry the firmware is currently told to use next, if any.
     *
     * Worth knowing because BootNext survives a cancelled restart: it would
     * then quietly hijack the next, unrelated reboot.
     *
     * @returns {Promise<string|null>} four hex digits, or null when unset
     */
    static async readBootNext() {
        const match = /^BootNext:\s*([0-9A-Fa-f]{4})\s*$/m.exec(await this._readOutput());
        return match ? match[1].toUpperCase() : null;
    }

    /**
     * Locate the Windows boot entry.
     *
     * @returns {Promise<BootEntry|null>}
     */
    static async findWindowsBootManager() {
        const entries = await this.listEntries();

        const exact = entries.find(
            entry => entry.label.toLowerCase() === WINDOWS_BOOT_MANAGER.toLowerCase());
        if (exact)
            return exact;

        // Some setups rename the entry, so fall back to anything Windows-ish.
        return entries.find(entry => /windows/i.test(entry.label)) ?? null;
    }

    /**
     * Run the privileged helper (or efibootmgr as a fallback) with a single
     * argument.
     *
     * @param {string} argument an EFI boot entry id, or CLEAR_BOOT_NEXT
     * @returns {Promise<{method: string, needsAuthentication: boolean}>}
     */
    static async _runPrivileged(argument) {
        const pkexec = this.findPkexec();

        // Preferred: the dedicated helper, which polkit authorises for the
        // active session, so no password prompt shows up.
        const helper = this.findHelper();
        if (helper !== null) {
            Log(`using the passwordless helper ${helper} ${argument}`);
            const [status, , stderr] = await ExecCommand([pkexec, helper, argument]);
            if (status === 0)
                return {method: 'helper', needsAuthentication: false};
            if (status === EXIT_AUTH_DISMISSED)
                throw new AuthenticationCancelledError();
            if (status === EXIT_AUTH_NOT_AUTHORIZED)
                throw new Error('the restart-to-windows helper was not authorised');

            throw new Error(`the restart-to-windows helper failed: ${stderr.trim() || status}`);
        }

        // Last resort: this asks for the user's password.
        const binary = this.findEfiBootMgr();
        if (binary === null)
            throw new Error('efibootmgr is not installed');

        // efibootmgr spells "clear BootNext" differently from our helper.
        const argv = argument === CLEAR_BOOT_NEXT
            ? [pkexec, binary, '-N']
            : [pkexec, binary, '-n', argument];

        Log(`falling back to pkexec ${argv.slice(1).join(' ')}`);
        const [status, , stderr] = await ExecCommand(argv);
        if (status === 0)
            return {method: 'pkexec', needsAuthentication: true};
        if (status === EXIT_AUTH_DISMISSED)
            throw new AuthenticationCancelledError();
        if (status === EXIT_AUTH_NOT_AUTHORIZED)
            throw new Error('not authorised to change the next boot entry');

        throw new Error(`${argv.slice(1).join(' ')} failed: ${stderr.trim() || status}`);
    }

    /**
     * Make `entry` the target of the next boot by writing the UEFI `BootNext`
     * variable. That needs root, so it goes through pkexec.
     *
     * @param {BootEntry} entry
     * @returns {Promise<{method: string, needsAuthentication: boolean}>}
     */
    static async setNextBoot(entry) {
        return this._runPrivileged(entry.id);
    }

    /**
     * Undo a previously set BootNext.
     *
     * BootNext is a one-shot that the firmware only forgets after a boot, so a
     * cancelled restart would otherwise send the *next* unrelated reboot to
     * Windows as well.
     *
     * @returns {Promise<{method: string, needsAuthentication: boolean}>}
     */
    static async clearBootNext() {
        return this._runPrivileged(CLEAR_BOOT_NEXT);
    }
}
