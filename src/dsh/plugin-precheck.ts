import { containerWebCommand, webServiceArgs } from './cli.js'
import { DSH_READY_PATTERN, DSH_INACTIVE_ENTRY_PATTERN } from './readiness.js'
import { DSH_RPC_PREFIX, rpcRequestBody } from './session-protocol.js'

export const DSH_PLUGIN_LIST = 'pluginManager/listPlugins'

/** Actual offline boot and public plugin-manager RPC, inside the disposable container. */
export const pluginOfflinePrecheck = `
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const input = JSON.parse(await readFile('/control/input.json', 'utf8'));
const command = ${JSON.stringify(webServiceArgs(containerWebCommand(), ['/artifact/managed.patch.json'], 4180, '127.0.0.1:4180'))};
const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
const closed = new Promise(resolve => child.once('close', resolve));
let output = ''; let started = false;
const completed = new Promise((resolve, reject) => {
  const deadline = setTimeout(() => reject(Error('DSH did not become ready')), 60000);
  child.once('error', reject); child.once('exit', () => { clearTimeout(deadline); reject(Error('DSH exited before precheck')); });
  const consume = chunk => {
    output = (output + chunk.toString()).slice(-1048576);
    const ready = ${DSH_READY_PATTERN.toString()}.exec(output)?.[1];
    if (!ready || started) return;
    started = true;
    void (async () => {
      const url = new URL(ready);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '4180' || !url.searchParams.get('token')) throw Error('Invalid readiness URL');
      if (${DSH_INACTIVE_ENTRY_PATTERN.toString()}.test(output)) throw Error('Inactive plugins');
      const exchange = await fetch(url, { redirect: 'manual' });
      if (exchange.status !== 303) throw Error('Launch exchange failed');
      const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      if (!cookie) throw Error('Launch cookie missing');
      const response = await fetch(new URL(${JSON.stringify(DSH_RPC_PREFIX + DSH_PLUGIN_LIST)}, url), { method: 'POST',
        headers: { cookie, origin: url.origin, 'content-type': 'application/json' }, body: ${JSON.stringify(rpcRequestBody('phalanx-precheck', DSH_PLUGIN_LIST, {}))} });
      const result = await response.json();
      if (!response.ok || !result.result?.ok || !Array.isArray(result.result.value)) throw Error('Plugin inventory unavailable');
      const rows = result.result.value.filter(row => row.moduleName === input.packageName || row.bundleName === input.packageName || row.moduleName?.includes('/node_modules/' + input.packageName + '/'));
      if (!rows.length || rows.some(row => row.fiberPhase !== 'active')) throw Error('Plugin did not activate');
      clearTimeout(deadline); resolve();
    })().catch(error => { clearTimeout(deadline); reject(error); });
  };
  child.stdout.on('data', consume); child.stderr.on('data', consume);
});
try { await completed; console.log('Offline plugin precheck passed'); }
finally {
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  await closed; clearTimeout(force);
}
`
