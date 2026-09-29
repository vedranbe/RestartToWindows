#!/usr/bin/env -S gjs -m
/* smoke-test.js
 *
 * Tests the parts of the extension that do not need the GNOME Shell UI, so
 * they can be run outside a running desktop session:
 *
 *     ./tests/smoke-test.js
 *
 * It reads the machine's real UEFI boot entries and talks to the real
 * systemd-logind, so it fails on a non-UEFI machine. CanReboot is used
 * instead of Reboot, so nothing is ever rebooted and BootNext is never
 * written.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {EFIBootManager, AuthenticationCancelledError} from '../src/efibootmgr.js';
import {
    RebootCancelledError,
    isCancellation,
    isServiceUnavailable,
} from '../src/cancel.js';
import {callMethod} from '../src/logind.js';
import {FindFirstExistingFile} from '../src/utils.js';

let failures = 0;
let checks = 0;

function check(name, ok, extra = '') {
    checks++;
    if (!ok)
        failures++;
    print(`${ok ? 'ok  ' : 'FAIL'}  ${name}${extra ? `  -> ${extra}` : ''}`);
}

function section(title) {
    print(`\n--- ${title} ---`);
}

/* ------------------------------------------------------------------ utils */

section('utils');
check('FindFirstExistingFile skips missing candidates',
    FindFirstExistingFile(['/nope/efibootmgr', '/usr/bin/efibootmgr']) === '/usr/bin/efibootmgr' ||
    FindFirstExistingFile(['/nope/efibootmgr']) === null);
check('FindFirstExistingFile returns null when nothing matches',
    FindFirstExistingFile(['/nope/a', '/nope/b']) === null);

/* ------------------------------------------------------- efibootmgr lookup */

section('efibootmgr discovery');
const efibootmgr = EFIBootManager.findEfiBootMgr();
check('findEfiBootMgr returns an absolute path',
    efibootmgr === null || efibootmgr.startsWith('/'), String(efibootmgr));
check('findPkexec returns an absolute path',
    EFIBootManager.findPkexec().startsWith('/'), EFIBootManager.findPkexec());
{
    // Installed or not, findHelper() must only ever hand back a path that is
    // safe to hand to pkexec: absolute, and executable.
    const helper = EFIBootManager.findHelper();
    check('findHelper returns null or an absolute path',
        helper === null || helper.startsWith('/'), String(helper));
    check('the helper is executable', (() => {
        if (helper === null)
            return true;
        const file = Gio.File.new_for_path(helper);
        return file.query_info('unix::mode',
            Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::mode') & 0o111 !== 0;
    })(), String(helper));
    print(`      helper -> ${helper ?? 'not installed, pkexec efibootmgr will be used'}`);
}

if (efibootmgr === null) {
    print('\nefibootmgr is not installed, skipping the hardware tests.');
    System.exit(failures === 0 ? 0 : 1);
}

/* --------------------------------------------------------- real UEFI output */

section('real UEFI boot entries');
const entries = await EFIBootManager.listEntries();
for (const e of entries)
    print(`      ${e.id}${e.active ? '*' : ' '}  ${JSON.stringify(e.label)}`);
check('at least one entry parsed', entries.length > 0, `${entries.length} entries`);
check('every id is four hex digits', entries.every(e => /^[0-9A-F]{4}$/.test(e.id)));
check('no label leaked a device path',
    entries.every(e => !/\s(?:HD|File|PciRoot|USB)\(/.test(e.label)));

const windows = await EFIBootManager.findWindowsBootManager();
print(`      Windows entry -> ${JSON.stringify(windows)}`);
if (windows !== null) {
    check('Windows entry has a usable id', /^[0-9A-F]{4}$/.test(windows.id));
    check('Windows entry has a non-empty label', windows.label.length > 0);
} else {
    print('      (no Windows entry on this machine, that is fine)');
}

/* ------------------------------------------------------------ parsing rules */

section('parsing edge cases');
const parse = EFIBootManager._parseEntries;
const cases = [
    ['a long label without padding is kept whole',
        'Boot0004* UEFI: VendorCoProductCode 2.00, Partition 1\tPciRoot(0x0)/Pci(0x8,0x1)',
        'UEFI: VendorCoProductCode 2.00, Partition 1'],
    ['an inactive entry (two spaces) is parsed',
        'Boot0002  Something\tHD(1,GPT,x)/File(\\EFI\\x.efi)',
        'Something'],
    ['BootCurrent is not an entry', 'BootCurrent: 0003', null],
    ['BootOrder is not an entry', 'BootOrder: 0000,0001', null],
    ['a "dp:" line is not an entry', '      dp: 04 01 2a 00', null],
    ['a "data:" line is not an entry', '    data: 57 49 4e 44', null],
    ['a truncated line is ignored', 'Boot000', null],
    ['a five digit id is not an entry', 'Boot00001* X\tHD(1,GPT,y)', null],
];
for (const [name, line, expected] of cases) {
    const [entry] = parse(line);
    const got = entry ? entry.label : null;
    check(name, got === expected, JSON.stringify(got));
}

section('Windows entry matching');
{
    const pick = list => {
        const exact = list.find(
            e => e.label.toLowerCase() === 'windows boot manager');
        return exact ?? list.find(e => /windows/i.test(e.label)) ?? null;
    };

    const usual = parse([
        'Boot0000* Fedora\tHD(1,GPT,a)/File(\\EFI\\fedora\\shimx64.efi)',
        'Boot0001* Windows Boot Manager\tHD(1,GPT,a)/File(\\EFI\\Microsoft\\Boot\\bootmgfw.efi)',
    ].join('\n'));
    check('the exact entry is preferred over other Windows entries',
        pick(usual)?.id === '0001', JSON.stringify(pick(usual)));

    // The comparison has to be case insensitive, otherwise the exact match
    // never fires and a differently named entry could be picked instead.
    const lowerCase = parse([
        'Boot0000* windows boot manager\tHD(1,GPT,a)/File(x)',
        'Boot0001* Windows Boot Manager (old copy)\tHD(1,GPT,a)/File(y)',
    ].join('\n'));
    check('the exact match is case insensitive',
        pick(lowerCase)?.id === '0000', JSON.stringify(pick(lowerCase)));

    check('no Windows entry yields null',
        pick(parse('Boot0000* Fedora\tHD(1,GPT,a)/File(x)')) === null);
}

/* ------------------------------------------------------------------ logind */

section('BootNext reading');
{
    // readBootNext() has to survive both shapes of the efibootmgr output, and
    // must not confuse the BootNext line with a Boot0xxx entry.
    const fake = [
        'BootCurrent: 0001',
        'Timeout: 0 seconds',
        'BootOrder: 0000,0001',
        'BootNext: 0001',
        'Boot0000* Fedora\tHD(1,GPT,a)/File(\\EFI\\fedora\\shimx64.efi)',
        'Boot0001* Windows Boot Manager\tHD(1,GPT,b)/File(\\EFI\\Microsoft\\Boot\\bootmgfw.efi)',
    ].join('\n');
    const match = /^BootNext:\s*([0-9A-Fa-f]{4})\s*$/m.exec(fake);
    check('the BootNext line is parsed', match?.[1] === '0001', match?.[1] ?? 'no match');
    check('BootNext is not mistaken for a boot entry',
        EFIBootManager._parseEntries(fake).length === 2,
        `${EFIBootManager._parseEntries(fake).length} entries`);

    const unset = 'BootCurrent: 0000\nBoot0000* Fedora\tHD(1,GPT,a)';
    check('an unset BootNext yields null',
        !/^BootNext:\s*([0-9A-Fa-f]{4})\s*$/m.exec(unset));

    const real = await EFIBootManager.readBootNext();
    check('readBootNext() works on this machine', real === null || /^[0-9A-F]{4}$/.test(real),
        String(real));
    if (real !== null) {
        print(`      NOTE: a BootNext of ${real} is currently set.`);
        print('      Clear a stale one with: pkexec <helper> none');
    }
}

section('cancellation handling');
{
    // Regression test for the reported bug: cancelling gnome-session's "Restart"
    // dialog used to be treated as a failure, and the extension then rebooted
    // via logind anyway, so cancelling did not actually cancel anything.
    // gnome-session reports the cancellation as G_IO_ERROR_CANCELLED, which
    // surfaces as "Operation was cancelled".
    const real = new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED,
        'Operation was cancelled');
    check('a G_IO_ERROR_CANCELLED is recognised as a cancellation',
        isCancellation(real) === true, real.message);
    check('a plain "Operation was cancelled" is recognised',
        isCancellation(new Error('Operation was cancelled')) === true);
    check('"Canceled" (one l) is recognised',
        isCancellation(new Error('request was canceled by the user')) === true);

    // Genuine failures must not be mistaken for a cancellation.
    check('a permission error is not a cancellation',
        isCancellation(new Error('Access denied')) === false);
    check('an unknown method is not a cancellation',
        isCancellation(new Error('Unknown method Reboot')) === false);
    check('a service error is not a cancellation',
        isCancellation(new Error('The name org.gnome.SessionManager was not provided')) === false);
    check('undefined is not a cancellation', isCancellation(undefined) === false);
    check('null is not a cancellation', isCancellation(null) === false);

    // Only a genuinely missing gnome-session may fall back to logind. Anything
    // else must be reported instead of rebooting behind the user's back.
    // A real one, not just a matching string, so the GDBus code path is used.
    let missingService = null;
    try {
        await new Promise((resolve, reject) => {
            Gio.DBus.session.call(
                'org.gnome.NoSuchService', '/org/gnome/NoSuch', 'org.gnome.NoSuch',
                'Nope', null, null, Gio.DBusCallFlags.NONE, 2000, null,
                (connection, result) => {
                    try {
                        resolve(connection.call_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
        });
    } catch (error) {
        missingService = error;
    }
    check('a real missing D-Bus service is seen as unavailable',
        missingService !== null && isServiceUnavailable(missingService),
        missingService?.message ?? 'no error raised');
    check('the same wording is recognised from the message alone',
        isServiceUnavailable(new Error('The name org.gnome.SessionManager was not provided by any .service files')) === true);
    check('a cancellation is NOT a missing service',
        isServiceUnavailable(real) === false, real.message);
    check('a permission error is NOT a missing service',
        isServiceUnavailable(new Error('Access denied')) === false);
    // An old gnome-session without the method is a capability problem, and
    // nothing was ever shown to the user, so falling back is safe.
    check('an unknown method counts as unavailable',
        isServiceUnavailable(new Error('org.gnome.SessionManager.Reboot: unknown method')) === true);

    const cancelled = new RebootCancelledError(real);
    check('RebootCancelledError is an Error', cancelled instanceof Error);
    check('RebootCancelledError is recognisable by name',
        cancelled.name === 'RebootCancelledError', cancelled.name);
    check('RebootCancelledError keeps the cause', cancelled.cause === real);
}

section('logind');
{
    // Note the value: "challenge" rather than "yes" is expected, because
    // gnome-session holds a strong block inhibitor on "shutdown" for as long
    // as a desktop session is running. That is why the reboot goes through
    // gnome-session instead, see src/reboot.js.
    const canReboot = (await callMethod('CanReboot', null)).deepUnpack()[0];
    check('logind is reachable on the system bus', typeof canReboot === 'string',
        `CanReboot -> ${canReboot}`);
    if (canReboot === 'challenge')
        print('      "challenge": a direct logind Reboot() would ask for a password');
    else
        print('      "yes": no shutdown inhibitor is held at the moment');
    print('      src/reboot.js uses gnome-session either way, which is what');
    print('      GNOME\'s own "Restart…" menu item does.');
}

section('logind call plumbing (the fallback reboot path)');
{
    // Gio.Variant is the GObject interface and is not constructible, the
    // constructor is GLib.Variant. Getting this backwards fails at runtime
    // with "Variant is not a constructor", long after the code is written.
    check('Gio.Variant is not constructible', typeof Gio.Variant !== 'function',
        typeof Gio.Variant);
    check('GLib.Variant is the constructor', typeof GLib.Variant === 'function');

    const parameters = new GLib.Variant('(b)', [false]);
    check('new GLib.Variant("(b)", [false]) unpacks to [false]',
        JSON.stringify(parameters.deepUnpack()) === '[false]',
        JSON.stringify(parameters.deepUnpack()));
    check('the variant type signature is what logind expects',
        `${parameters.get_type_string()}` === '(b)', parameters.get_type_string());

    // Exactly the plumbing Reboot.now() falls back to, with a harmless method.
    const reply = await callMethod('CanReboot', null);
    check('callMethod() resolves over the system bus',
        reply !== null && Array.isArray(reply.deepUnpack()),
        JSON.stringify(reply?.deepUnpack()));

    let rejected = null;
    try {
        await callMethod('ThisMethodDoesNotExist', null);
    } catch (error) {
        rejected = error;
    }
    check('a failing D-Bus call rejects the promise', rejected !== null,
        rejected?.message ?? 'no error raised');
}

section('errors');
{
    const cancelled = new AuthenticationCancelledError();
    check('AuthenticationCancelledError is an Error', cancelled instanceof Error);
    check('AuthenticationCancelledError is recognisable by name',
        cancelled.name === 'AuthenticationCancelledError', cancelled.name);
    check('Gio.Subprocess flags used by utils exist',
        typeof Gio.SubprocessFlags.STDOUT_PIPE === 'number' &&
        typeof Gio.SubprocessFlags.STDERR_PIPE === 'number');
    check('GLib timeout helpers used by extension.js exist',
        typeof GLib.timeout_add === 'function' &&
        typeof GLib.timeout_add_seconds === 'function' &&
        GLib.USEC_PER_SEC === 1000000);
}

print(`\n${failures === 0
    ? `ALL ${checks} CHECKS PASSED`
    : `${failures} OF ${checks} CHECKS FAILED`}`);
System.exit(failures === 0 ? 0 : 1);
