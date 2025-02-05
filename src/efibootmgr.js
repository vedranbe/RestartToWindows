import Gio from 'gi://Gio';
import { ExecCommand, Log } from './utils.js';

export class EFIBootManager {
    static async findWindowsBootManager() {
        try {
            const [status, stdout] = await ExecCommand(['efibootmgr', '-v']);
            if (status === 0) {
                const match = stdout.match(/Boot([0-9A-F]+)\* Windows Boot Manager/i);
                if (match) {
                    return match[1];
                }
            }
            throw new Error('Windows Boot Manager entry not found');
        } catch (error) {
            throw new Error(`Error finding Windows Boot Manager: ${error}`);
        }
    }

    static async setNextBoot(entryNum) {
        try {
            const [status] = await ExecCommand(['/usr/bin/pkexec', 'efibootmgr', '-n', entryNum]);
            if (status === 0) {
                Log(`Set boot option to ${entryNum}`);
                return true;
            }
            Log("Unable to set boot option using efibootmgr");
            return false;
        } catch (error) {
            Log(`Error setting next boot: ${error}`);
            return false;
        }
    }

    static async IsUseable() {
        return await this.GetBinary() !== "";
    }

    static async GetBinary() {
        let paths = ["/usr/bin/efibootmgr", "/usr/sbin/efibootmgr"];
        let file;
        for (let i = 0; i < paths.length; i++) {
            file = Gio.file_new_for_path(paths[i]);
            if (file.query_exists(null)) {
                return paths[i];
            }
        }
        return "";
    }
}
