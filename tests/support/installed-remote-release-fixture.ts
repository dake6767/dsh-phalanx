import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const files = [
  'tests/support/installed-release-fixture.ts',
  'scripts/release/integrity.mjs',
  'scripts/release/image-reuse.mjs',
  'scripts/release/compatibility.mjs',
]

/** Run the unchanged full-directory verifier beside the artifacts; SSH owns the server lifetime. */
export async function installedRemoteReleaseFixture(config: {
  ssh: readonly string[]
  source: string
  node: string
  directory: string
  candidate: string
  tag: string
  port: number
  releaseNotes: string
}) {
  if (
    ![config.source, config.node, config.directory].every(path => /^\/[a-zA-Z0-9/_.-]+$/u.test(path)) ||
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535
  )
    throw Error('Invalid remote fixture configuration')
  const hashes = Object.fromEntries(
    await Promise.all(
      files.map(
        async path =>
          [
            path,
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
          ] as const,
      ),
    ),
  )
  const harnessSource = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const program = `
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const config=${JSON.stringify(config)}, hashes=${JSON.stringify(hashes)};
let fixture, closing, disconnected=false;
const close=()=>{disconnected=true;process.stdin.destroy();return closing??=(async()=>{if(fixture)await fixture.close()})()};
for(const signal of ['SIGTERM','SIGHUP'])process.once(signal,()=>void close());
process.stdin.on('data',()=>void close());process.stdin.once('end',()=>void close());process.stdin.resume();
for(const [name,hash]of Object.entries(hashes)){
 const actual=createHash('sha256').update(await readFile(config.source+'/'+name)).digest('hex');
 if(actual!==hash)throw Error('Remote fixture source identity differs');
}
const {installedReleaseFixture}=await import('file://'+config.source+'/tests/support/installed-release-fixture.ts');
fixture=await installedReleaseFixture(config.directory,config.candidate,config.tag,config.port,config.releaseNotes,'127.0.0.1');
if(disconnected){await fixture.close();process.exit(1)}
console.log(JSON.stringify({schema:1,candidate:config.candidate,tag:config.tag,port:fixture.port,hashes,
 harnessSource:${JSON.stringify(harnessSource)},manifestSha256:fixture.manifestSha256,fullDirectoryVerified:true}));
`
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  const child = spawn('ssh', [...config.ssh, `${config.node} --input-type=module -e ${quote(program)}`], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = '',
    stdout = '',
    settled = false,
    closeRequested = false,
    protocolFailure: Error | undefined
  child.stdin.on('error', () => {})
  child.stderr.on('data', chunk => {
    stderr = (stderr + String(chunk)).slice(-16_384)
  })
  const exited = new Promise<number | null>(resolve => child.once('close', resolve))
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      closeRequested = true
      child.stdin.end('close\n')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const code = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error('Remote fixture did not confirm shutdown; preserve the owned process for diagnosis')), 30_000)
          }),
        ])
        if (code !== 0) throw Error('Remote fixture exited unsuccessfully: ' + stderr)
        if (protocolFailure) throw protocolFailure
      } finally {
        if (timer) clearTimeout(timer)
      }
    })())
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      timer = setTimeout(() => reject(Error('Remote full-directory verification did not become ready')), 120_000)
      child.once('error', reject)
      child.once('close', () => {
        if (!settled) reject(Error('Remote fixture exited before ready: ' + stderr))
        else if (!closeRequested) protocolFailure = Error('Remote fixture exited before requested shutdown')
      })
      child.stdout.on('data', chunk => {
        stdout += String(chunk)
        if (stdout.length > 65_536) {
          protocolFailure = Error('Remote fixture protocol exceeded its bound')
          reject(protocolFailure)
          return
        }
        if (!stdout.includes('\n')) return
        if (settled || stdout.trim().split('\n').length !== 1) {
          protocolFailure = Error('Duplicate remote fixture ready')
          reject(protocolFailure)
          return
        }
        try {
          const value = JSON.parse(stdout)
          settled = true
          resolve(value)
        } catch (error) {
          reject(error)
        }
      })
    })
    if (
      ready.schema !== 1 ||
      ready.candidate !== config.candidate ||
      ready.tag !== config.tag ||
      ready.port !== config.port ||
      ready.harnessSource !== harnessSource ||
      ready.fullDirectoryVerified !== true ||
      JSON.stringify(ready.hashes) !== JSON.stringify(hashes) ||
      !/^[a-f0-9]{64}$/u.test(String(ready.manifestSha256))
    )
      throw Error('Remote fixture ready identity differs')
    return { port: config.port, identity: ready, close }
  } catch (error) {
    try {
      await close()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Remote fixture startup or cleanup failed')
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}
