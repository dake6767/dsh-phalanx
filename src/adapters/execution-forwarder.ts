import { EXECUTION_UNAVAILABLE_EXIT, ExecutionFailure } from '../domain/platform-execution.js'

/** No platform credential or member token is embedded in a generated file. */
export function executionForwarderSource(): string {
  return `import { once } from 'node:events';
const unavailable = ${JSON.stringify(new ExecutionFailure('internal').message + '\n')};
try {
 const chunks = []; let size = 0;
 for await (const chunk of process.stdin) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error(); chunks.push(chunk); }
 const [owner, command, ...argv] = process.argv.slice(2);
 const response = await fetch(new URL('/execution', process.env.DSH_PHALANX_MODEL_GATEWAY_URL), {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN },
  body: JSON.stringify({ owner, command, argv, cwd: process.cwd(), stdin: Buffer.concat(chunks).toString('base64') })
 });
 if (!response.ok || !response.body) throw new Error();
 let pending = '', exited = false;
 for await (const chunk of response.body) {
  pending += Buffer.from(chunk).toString('utf8'); let end;
  while ((end = pending.indexOf('\\n')) !== -1) {
   const event = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
   if (event.stream === 'stdout' || event.stream === 'stderr') {
    const output = event.stream === 'stdout' ? process.stdout : process.stderr;
    if (!output.write(Buffer.from(event.data, 'base64'))) await once(output, 'drain');
   } else if (event.exit !== undefined) { process.exitCode = event.exit; exited = true; }
   else throw new Error();
  }
 }
 if (!exited || pending) throw new Error();
} catch { process.stderr.write(unavailable); process.exitCode = ${EXECUTION_UNAVAILABLE_EXIT}; }
`
}

export function executionStub(dispatch: string, owner: string, command: string, memberPath = command): string {
  const args = [dispatch, owner, command]
  if (memberPath.endsWith('.py')) return `#!/usr/bin/env python3\nimport os, sys\nos.execvp('node', ${JSON.stringify(['node', ...args])} + sys.argv[1:])\n`
  if (/\.[cm]?js$/u.test(memberPath))
    return `#!/usr/bin/env node\nimport('node:child_process').then(({spawn}) => { const p = spawn('node', ${JSON.stringify(args)}.concat(process.argv.slice(2)), {stdio:'inherit'}); p.on('error', () => {process.exitCode=125}); p.on('exit', code => {process.exitCode=code ?? 125}); });\n`
  return '#!/bin/sh\nexec node ' + args.map(value => "'" + value.replaceAll("'", "'\\''") + "'").join(' ') + ' "$@"\n'
}
