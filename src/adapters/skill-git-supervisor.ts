/** The IPC channel closes when the platform dies, terminating the entire owned Git group. */
export const gitSupervisor = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const terminate = () => { process.kill(-process.pid, 'SIGKILL'); };
process.on('disconnect', terminate);
if (!process.connected) terminate();
writeFileSync(process.argv[1], String(process.pid), { mode: 0o600 });
const child = spawn('git', process.argv.slice(2), { stdio: ['ignore', 'inherit', 'ignore'] });
child.once('error', () => process.exit(127));
child.once('close', code => process.exit(code ?? 1));
`
