import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

const failureExit = 78
const run = '/tmp/dsh-phalanx-credentials'
const address = `unix:path=${run}/bus`
const exec = promisify(execFile)
const service = 'org.freedesktop.secrets'
const secretInterface = 'org.freedesktop.Secret'
const servicePath = '/org/freedesktop/secrets'
const controlEnvironment = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', DBUS_SESSION_BUS_ADDRESS: address, XDG_RUNTIME_DIR: run }

async function privateDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const info = await lstat(path)
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new Error('Invalid private credential directory')
}

async function unlockPassword(root) {
  const keyrings = join(root, 'keyrings')
  const path = join(root, 'unlock')
  await privateDirectory(root)
  await privateDirectory(keyrings)
  if ((await readdir(keyrings)).length === 0) {
    // Publish a complete key before the daemon can create its persistent collection.
    const temporary = join(root, `unlock-${randomBytes(16).toString('hex')}`)
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(randomBytes(32).toString('hex'))
      await file.sync()
      try {
        await link(temporary, path)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    } finally {
      await file.close()
      await rm(temporary, { force: true })
    }
    for (const directory of [root, dirname(root)]) {
      const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size !== 64) throw new Error('Invalid credential unlock file')
    const key = await file.readFile('utf8')
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error('Invalid credential unlock data')
    return key
  } finally {
    await file.close()
  }
}

function childProcess(command, args, env, stdio) {
  const child = spawn(command, args, { env, stdio })
  const exited = new Promise(resolve => {
    child.once('error', () => resolve(1))
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGTERM' ? 143 : 1)))
  })
  return { child, exited }
}

async function gdbus(destination, path, method, args = []) {
  const { stdout } = await exec(
    '/usr/bin/gdbus',
    ['call', '--session', '--timeout', '1', '--dest', destination, '--object-path', path, '--method', method, ...args],
    { env: controlEnvironment, timeout: 1_500, maxBuffer: 4096 },
  )
  return stdout.trim()
}

async function ready(check, signal) {
  while (!signal.aborted) {
    try {
      if (await check()) return
    } catch {
      // The newly spawned service may not have registered yet.
    }
    await sleep(100, undefined, { signal })
  }
  signal.throwIfAborted()
}

async function unlocked() {
  if ((await gdbus('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', [service])) !== '(true,)') return false
  const alias = await gdbus(service, servicePath, `${secretInterface}.Service.ReadAlias`, ['default'])
  const collection = /^\(objectpath '(\/org\/freedesktop\/secrets\/collection\/[A-Za-z0-9_]+)',\)$/u.exec(alias)?.[1]
  return (
    collection !== undefined &&
    collection !== `${servicePath}/collection/session` &&
    (await gdbus(service, collection, 'org.freedesktop.DBus.Properties.Get', [`${secretInterface}.Collection`, 'Locked'])) === '(<false>,)'
  )
}

async function launch(command, args) {
  const children = []
  const lifetime = new globalThis.AbortController()
  let exitOnStop = 143
  let ownsRunDirectory = false
  const stop = () => lifetime.abort()
  const serviceExited = () => {
    if (lifetime.signal.aborted) return
    exitOnStop = failureExit
    stop()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    const home = process.env.HOME
    const data = join(home, '.dsh/profiles/web/.phalanx-credentials')
    const key = await unlockPassword(data)
    // A fresh carrier owns the socket. A restarted process cannot reuse an existing bus path.
    await mkdir(run, { mode: 0o700 })
    ownsRunDirectory = true
    const bus = childProcess('/usr/bin/dbus-daemon', ['--session', '--nofork', `--address=${address}`], controlEnvironment, 'ignore')
    children.push(bus)
    const deadline = AbortSignal.any([lifetime.signal, AbortSignal.timeout(8_000)])
    void bus.exited.then(serviceExited)
    await ready(async () => Boolean(await gdbus('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.Peer.Ping')), deadline)
    const keyring = childProcess(
      '/usr/bin/gnome-keyring-daemon',
      ['--foreground', '--unlock', '--components=secrets', `--control-directory=${run}`],
      { ...controlEnvironment, HOME: home, XDG_DATA_HOME: data },
      ['pipe', 'ignore', 'ignore'],
    )
    children.push(keyring)
    void keyring.exited.then(serviceExited)
    keyring.child.stdin.on('error', () => undefined)
    keyring.child.stdin.end(key)
    await ready(unlocked, deadline)
    deadline.throwIfAborted()
    const app = childProcess(command, args, { ...process.env, XDG_RUNTIME_DIR: run, DBUS_SESSION_BUS_ADDRESS: address, GNOME_KEYRING_CONTROL: run }, 'inherit')
    children.push(app)
    const interrupted = new Promise(resolve => lifetime.signal.addEventListener('abort', () => resolve(exitOnStop), { once: true }))
    const code = await Promise.race([app.exited.then(code => (code === failureExit ? 1 : code)), interrupted])
    return code
  } catch {
    if (lifetime.signal.aborted && exitOnStop !== failureExit) return exitOnStop
    // Never send credential material or command output to the member startup log.
    console.error('Member credential service could not be prepared.')
    return failureExit
  } finally {
    for (const { child } of children.reverse()) child.kill('SIGTERM')
    const cleanup = Promise.all(children.map(({ exited }) => exited))
    await Promise.race([cleanup, sleep(1_000, undefined, { ref: false })])
    for (const { child } of children) child.kill('SIGKILL')
    await cleanup
    if (ownsRunDirectory) await rm(run, { recursive: true, force: true })
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
}

async function access() {
  let bytes = 0
  const chunks = []
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 262_144) throw new Error('Credential request is too large')
    chunks.push(chunk)
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const { operation, attributes, value } = input
  if (!['lookup', 'store', 'clear'].includes(operation) || !Array.isArray(attributes) || attributes.length < 1 || attributes.length > 16)
    throw new Error('Invalid credential request')
  const names = new Set()
  for (const pair of attributes) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(pair[0]) ||
      pair[0] !== pair[0].trim() ||
      names.has(pair[0]) ||
      typeof pair[1] !== 'string' ||
      !pair[1] ||
      Buffer.byteLength(pair[1]) > 1024 ||
      pair[1].includes('\0')
    )
      throw new Error('Invalid credential attributes')
    names.add(pair[0])
  }
  // secret-tool 0.20.5 uses an 8192-byte buffer for non-interactive input.
  if (operation === 'store' && (typeof value !== 'string' || !value || Buffer.byteLength(value) >= 8192 || value.includes('\0')))
    throw new Error('Invalid credential value')
  if (!(await unlocked())) throw new Error('Credential service is unavailable')
  const args = [operation, ...(operation === 'store' ? ['--label=Member credential'] : []), '--', ...attributes.flat()]
  const result = await new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/secret-tool', args, { env: controlEnvironment, timeout: 4_000, maxBuffer: 32_768 }, (error, stdout, stderr) => {
      if (!error && !stderr) resolve(operation === 'lookup' ? stdout : true)
      else if (operation !== 'store' && error?.code === 1 && !stderr) resolve(operation === 'lookup' ? null : true)
      else reject(new Error('Credential operation failed'))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(operation === 'store' ? value : undefined)
  })
  process.stdout.write(JSON.stringify(result))
}

if (process.argv[2] === '--access') {
  try {
    await access()
  } catch {
    process.exitCode = failureExit
  }
} else process.exitCode = await launch(process.argv[2], process.argv.slice(3))
