// Each file owns a port range, process group and labelled containers. Diagnostics precede cleanup.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import net from 'node:net'
import { setTimeout, clearTimeout } from 'node:timers'

const pause = ms => new Promise(done => setTimeout(done, ms))
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const inspect = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000 })
  return { code: result.status, output: result.stdout ?? '', error: result.error?.message ?? result.stderr ?? '' }
}
async function busyPorts(base) {
  const busy = []
  for (let port = base; port < base + 20; port++) {
    for (const host of ['127.0.0.1', '::1']) {
      const available = await new Promise(done => {
        const server = net.createServer()
        server.once('error', error => done(['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)))
        server.listen(port, host, () => server.close(() => done(true)))
      })
      if (!available) {
        busy.push(port)
        break
      }
    }
  }
  return busy
}
function owners(base) {
  if (process.env.DSH_PHALANX_PORT_OWNERS_SOCKET) {
    const root = inspect('python3', [fileURLToPath(new URL('./port-owners.py', import.meta.url)), process.env.DSH_PHALANX_PORT_OWNERS_SOCKET, String(base)])
    return root.output || root.error
  }
  const sockets = process.platform === 'linux' ? inspect('ss', ['-lntup']) : inspect('lsof', ['-nP', '-iTCP:' + base + '-' + (base + 19), '-sTCP:LISTEN'])
  return (sockets.output || sockets.error)
    .split('\n')
    .filter(
      line => process.platform !== 'linux' || Array.from({ length: 20 }, (_, i) => base + i).some(port => new RegExp(':' + port + '(?:\\s|$)', 'u').test(line)),
    )
    .join('\n')
}
function processes(pid) {
  const rows = inspect('ps', ['-axo', 'pid,ppid,pgid,uid,stat,command']).output.split('\n')
  return rows.filter(line => line.trim().split(/\s+/u)[2] === String(pid)).join('\n')
}
function groupAlive(pid) {
  return processes(pid)
    .split('\n')
    .some(line => {
      const fields = line.trim().split(/\s+/u)
      return fields[2] === String(pid) && !fields[4]?.startsWith('Z')
    })
}
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}
export function fileIndex(file, inventory) {
  const index = inventory.indexOf(file)
  if (index < 0) throw Error(`File is outside the Linux inventory: ${file}`)
  return index
}
export async function runFile({ file, index, directory, extra = [], command, timeoutMs, containerChecks = true, env = process.env }) {
  if (!Number.isInteger(index) || index < 0 || index > 2200) throw Error('Invalid file port range')
  const portBase = 20000 + index * 20
  directory = resolve(directory)
  mkdirSync(directory, { recursive: true })
  const report = join(directory, 'report.json'),
    output = join(directory, 'output.log')
  const started = Date.now()
  const record = { file, portBase, report, directory, status: 'running', startedAt: new Date(started).toISOString() }
  const save = () => {
    record.elapsedMs = Date.now() - started
    json(join(directory, 'execution.json'), record)
  }
  const occupied = await busyPorts(portBase)
  if (occupied.length) {
    Object.assign(record, { status: 'environment-failed', busyPorts: occupied, ownerDetails: owners(portBase) })
    json(join(directory, 'diagnostics.json'), { processes: '', ports: record.ownerDetails })
    save()
    return record
  }
  const tag = createHash('sha256').update(directory).digest('hex')
  const runtime = env.DSH_PHALANX_CONTAINER_RUNTIME ?? 'podman'
  const resolvedRuntime = containerChecks ? inspect('which', [runtime]).output.trim() : ''
  const bin = join(directory, 'bin'),
    temporary = join(directory, 'tmp')
  mkdirSync(bin)
  mkdirSync(temporary)
  if (resolvedRuntime) {
    // PATH also covers tests which deliberately invoke podman without the runtime variable.
    // The host-only per-file directory is absent from the container namespace.
    // Bare --env TMPDIR copies this value; each container already owns its /tmp.
    // exec preserves the runtime PID and pipe lifetime for callers which abort it.
    writeFileSync(
      join(bin, 'podman'),
      `#!/usr/bin/env python3\nimport os,sys\nargs=sys.argv[1:]\nenv=dict(os.environ)\nif args and args[0] in ('run','create'):\n args[1:1]=['--label',${JSON.stringify('dsh.validation.file=' + tag)}]\n if env.get('TMPDIR')==${JSON.stringify(temporary)}:env['TMPDIR']='/tmp'\nos.execvpe(${JSON.stringify(resolvedRuntime)},[${JSON.stringify(resolvedRuntime)},*args],env)\n`,
      { mode: 0o700 },
    )
  }
  const childEnvironment = {
    ...env,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    DSH_PHALANX_PROCESS_GROUPS_FILE: join(directory, 'owned-groups.jsonl'),
    DSH_PHALANX_E2E_PORT_BASE: String(portBase),
    DSH_PHALANX_FILE_TAG: tag,
    DSH_PHALANX_E2E_EVIDENCE_DIR: join(directory, 'browser-failures'),
    ...(resolvedRuntime ? { PATH: bin + ':' + env.PATH, DSH_PHALANX_CONTAINER_RUNTIME: join(bin, 'podman') } : {}),
  }
  mkdirSync(childEnvironment.DSH_PHALANX_E2E_EVIDENCE_DIR)
  const invocation = command ?? [
    process.execPath,
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'vitest.e2e.config.ts',
    file,
    ...extra,
    '--reporter=default',
    '--reporter=json',
    `--outputFile=${report}`,
  ]
  const log = openSync(output, 'wx')
  let child, timer
  try {
    child = spawn(invocation[0], invocation.slice(1), { detached: true, env: childEnvironment, stdio: ['ignore', log, log] })
    record.pid = child.pid
    save()
    await new Promise(done => {
      child.once('error', error => {
        record.error = error.message
        done()
      })
      child.once('exit', (code, signal) => {
        record.code = code
        record.signal = signal
        done()
      })
      // Production relies on each Vitest case's timeout, including explicit long-running overrides.
      if (timeoutMs !== undefined)
        timer = setTimeout(() => {
          record.timedOut = true
          done()
        }, timeoutMs)
    })
  } finally {
    clearTimeout(timer)
    closeSync(log)
    const containerArgs = ['ps', '-a', '--filter', 'label=dsh.validation.file=' + tag, '--format', 'json']
    const containers = resolvedRuntime ? inspect(resolvedRuntime, containerArgs) : { code: 0, output: '[]' }
    const errors = []
    const ownedGroups = new Set(child?.pid ? [child.pid] : [])
    const collectGroups = () => {
      const path = childEnvironment.DSH_PHALANX_PROCESS_GROUPS_FILE
      if (existsSync(path))
        for (const line of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
          try {
            const { pid } = JSON.parse(line)
            if (!Number.isInteger(pid) || pid < 2 || pid === process.pid) errors.push('Invalid owned process group')
            else ownedGroups.add(pid)
          } catch (error) {
            errors.push(error.message)
          }
        }
    }
    collectGroups()
    json(join(directory, 'diagnostics.json'), {
      processes: [...ownedGroups].map(processes).join('\n'),
      ports: owners(portBase),
      containers,
      output,
      pid: child?.pid,
    })
    let ids = []
    try {
      if (containers.code !== 0) errors.push('Owned container inventory failed: ' + containers.error)
      else
        ids = JSON.parse(containers.output)
          .map(row => row.Id ?? row.ID)
          .filter(Boolean)
      for (const id of ids) {
        json(join(directory, 'container-' + basename(id) + '.json'), {
          inspect: inspect(resolvedRuntime, ['inspect', id]),
          logs: inspect(resolvedRuntime, ['logs', id]),
        })
      }
    } catch (error) {
      errors.push(error.message)
    }
    try {
      for (const pid of ownedGroups) signalGroup(pid, 'SIGTERM')
      for (let attempt = 0; attempt < 20; attempt++) {
        collectGroups()
        if (![...ownedGroups].some(groupAlive)) break
        await pause(100)
      }
      for (const pid of ownedGroups) if (groupAlive(pid)) signalGroup(pid, 'SIGKILL')
      for (let attempt = 0; attempt < 20 && [...ownedGroups].some(groupAlive); attempt++) await pause(100)
      if ([...ownedGroups].some(groupAlive)) errors.push('Owned process group is still alive')
    } catch (error) {
      errors.push(error.message)
    }
    if (resolvedRuntime) {
      const after = inspect(resolvedRuntime, containerArgs)
      if (after.code !== 0) errors.push('Post-process container inventory failed')
      else {
        try {
          ids = [
            ...new Set([
              ...ids,
              ...JSON.parse(after.output)
                .map(row => row.Id ?? row.ID)
                .filter(Boolean),
            ]),
          ]
        } catch (error) {
          errors.push(error.message)
        }
      }
    }
    for (const id of ids) {
      const diagnostic = join(directory, 'container-' + basename(id) + '.json')
      if (!existsSync(diagnostic)) json(diagnostic, { inspect: inspect(resolvedRuntime, ['inspect', id]), logs: inspect(resolvedRuntime, ['logs', id]) })
      const removed = inspect(resolvedRuntime, ['rm', '--force', id])
      if (removed.code !== 0) errors.push('Owned container removal failed: ' + id)
    }
    if (resolvedRuntime) {
      const final = inspect(resolvedRuntime, containerArgs)
      if (final.code !== 0) errors.push('Final container inventory failed')
      else {
        try {
          if (JSON.parse(final.output).length) errors.push('Owned containers remain after cleanup')
        } catch (error) {
          errors.push(error.message)
        }
      }
    }
    const remaining = await busyPorts(portBase)
    if (remaining.length) errors.push('Ports still occupied: ' + remaining.join(', '))
    record.cleanup = { passed: errors.length === 0, errors, remainingPorts: remaining, ownerDetails: remaining.length ? owners(portBase) : '' }
    record.status = errors.length ? 'environment-failed' : record.code === 0 && !record.timedOut ? 'passed' : 'failed'
    if (record.status === 'passed') {
      try {
        discardCompilerCaches(temporary)
      } catch (error) {
        record.cacheCleanupError = error.message
      }
    }
    save()
  }
  return record
}
/** Passed files keep their outputs; Vitest's transformed-module copies and Node's compile cache are regenerable. */
function discardCompilerCaches(temporary) {
  rmSync(join(temporary, 'node-compile-cache'), { recursive: true, force: true })
  for (const entry of readdirSync(temporary, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[\w-]{21}$/u.test(entry.name)) continue
    const project = join(temporary, entry.name)
    rmSync(join(project, 'ssr'), { recursive: true, force: true })
    if (!readdirSync(project).length) rmSync(project, { recursive: true })
  }
}
export function mergeReports(reports) {
  const rows = reports.map(path => JSON.parse(readFileSync(path, 'utf8')))
  const testResults = rows.flatMap(row => row.testResults)
  const cases = testResults.flatMap(row => row.assertionResults)
  return {
    testResults,
    success: rows.every(row => row.success),
    numTotalTestSuites: testResults.length,
    numPassedTestSuites: testResults.filter(row => row.status === 'passed').length,
    numFailedTestSuites: testResults.filter(row => row.status !== 'passed').length,
    numTotalTests: cases.length,
    numPassedTests: cases.filter(row => row.status === 'passed').length,
    numFailedTests: cases.filter(row => row.status === 'failed').length,
    numPendingTests: cases.filter(row => ['pending', 'skipped', 'todo'].includes(row.status)).length,
    numRuntimeErrorTestSuites: rows.reduce((sum, row) => sum + (row.numRuntimeErrorTestSuites ?? 0), 0),
  }
}
