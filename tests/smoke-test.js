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
check('findHelper is null unless setup-passwordless.sh was run',
    typeof EFIBootManager.findHelper() === 'object' ||
    EFIBootManager.findHelper() === null, String(EFIBootManager.findHelper()));

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

section('logind');
{
    // org.freedesktop.login1.reboot has allow_active: yes, so this resolves
    // with no password prompt. That is what makes the reboot half of a restart
    // to Windows password free.
    const canReboot = await new Promise((resolve, reject) => {
        Gio.DBus.system.call(
            'org.freedesktop.login1',
            '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager',
            'CanReboot', null, null,
            Gio.DBusCallFlags.NONE, -1, null,
            (connection, result) => {
                try {
                    resolve(connection.call_finish(result).deepUnpack());
                } catch (error) {
                    reject(error);
                }
            });
    });
    check('logind answers on the system bus without a password prompt',
        !!canReboot, JSON.stringify(canReboot));
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
