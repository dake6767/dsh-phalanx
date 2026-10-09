/** Standard Node APIs only; evaluated inside the member container, never by the host. */
export const memberPluginArchiveWorker = String.raw`
const { createHash, randomUUID } = require('node:crypto');
const { mkdir, writeFile, rename, rm } = require('node:fs/promises');
const { join } = require('node:path');
const controller = new AbortController();
const cancel = () => controller.abort();
process.stdin.once('data', cancel); process.stdin.once('end', cancel); process.stdin.resume();
const deadline = setTimeout(cancel, 30000);
(async () => {
  controller.signal.throwIfAborted();
  const [url, integrity, maximum, directory] = process.argv.slice(1);
  if (!directory || !url || !integrity || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error('Invalid archive');
  const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('Download denied');
  let size = 0; const chunks = []; const hash = createHash('sha512');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > Number(maximum)) throw new Error('Archive too large');
    hash.update(chunk); chunks.push(chunk);
  }
  const digest = hash.digest();
  if ('sha512-' + digest.toString('base64') !== integrity) throw new Error('Archive integrity mismatch');
  controller.signal.throwIfAborted();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, digest.toString('hex') + '.tgz');
  const temporary = join(directory, randomUUID() + '.tmp');
  try { controller.signal.throwIfAborted(); await writeFile(temporary, Buffer.concat(chunks), { flag: 'wx', mode: 0o600, signal: controller.signal }); controller.signal.throwIfAborted(); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
  process.stdout.write(target);
})().catch(() => { process.exitCode = 1; }).finally(() => { clearTimeout(deadline); process.stdin.destroy(); });
`
