/* utils.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from 'gi://Gio';

/**
 * Run a command and collect its output.
 *
 * @param {string[]} argv absolute path first, never resolved through $PATH
 * @param {Gio.Cancellable} [cancellable] optional cancellable
 * @returns {Promise<[number, string, string]>} exit status, stdout, stderr
 */
export async function ExecCommand(argv, cancellable = null) {
    const proc = Gio.Subprocess.new(
        argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

    return new Promise((resolve, reject) => {
        proc.communicate_utf8_async(null, cancellable, (proc, result) => {
            try {
                const [, stdout, stderr] = proc.communicate_utf8_finish(result);
                resolve([proc.get_exit_status(), stdout, stderr]);
            } catch (error) {
                reject(error);
            }
        });
    });
}

/**
 * First existing path out of a list of absolute candidates.
 *
 * @param {string[]} paths
 * @returns {string|null} the path, or null when nothing was found
 */
export function FindFirstExistingFile(paths) {
    for (const path of paths) {
        const file = Gio.File.new_for_path(path);
        try {
            if (file.query_exists(null))
                return path;
        } catch {
            // Unreadable parents etc. simply mean "not available".
        }
    }

    return null;
}

export function Log(message) {
    console.log(`[RestartToWindows] ${message}`);
}
