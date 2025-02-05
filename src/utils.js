import Gio from 'gi://Gio';

export function Log(message) {
    console.log(`[RestartToWindows] ${message}`);
}

export async function ExecCommand(argv) {
    try {
        const proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );

        return new Promise((resolve, reject) => {
            proc.communicate_utf8_async(null, null, (proc, result) => {
                try {
                    const [, stdout, stderr] = proc.communicate_utf8_finish(result);
                    const status = proc.get_exit_status();
                    resolve([status, stdout, stderr]);
                } catch (error) {
                    reject(error);
                }
            });
        });
    } catch (error) {
        throw error;
    }
}
