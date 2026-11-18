import { readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DSH_CONTAINER_HOME, dshWebProfilePath } from '../dsh/profile-layout.js'
import { CONTAINER_WRITE_LOCK_FORMAT, parseContainerWriteLockFacts } from '../dsh/container-write-lock.js'
import { profileHomeIdentity, readProfileLock, type MemberProfileLockEvidence, type ProfileLock } from './member-profile-write-lock.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'

const options = () => ({ env: containerClientEnvironment(), timeout: 5_000 })

async function writerContainerIds(runtime: string): Promise<string[]> {
  const list = await execFileText(runtime, ['ps', '--all', '--no-trunc', '--format', '{{.ID}}'], options())
  const ids = list.trim().split('\n').filter(Boolean)
  if (new Set(ids).size !== ids.length || !ids.every(value => /^[a-f0-9]{64}$/u.test(value))) throw new Error('Invalid container inventory')
  return ids
}

async function inspectWriterContainers(runtime: string, ids: readonly string[]) {
  if (ids.length === 0) return []
  const inspected = await execFileText(runtime, ['inspect', '--type', 'container', '--format', CONTAINER_WRITE_LOCK_FORMAT, ...ids], options())
  const facts = parseContainerWriteLockFacts(inspected)
  if (facts.length !== ids.length || new Set(facts.map(row => row.id)).size !== ids.length || facts.some(row => !ids.includes(row.id))) {
    throw new Error('Container inventory changed')
  }
  return facts
}

async function writerContainers(runtime: string, knownDisjoint: readonly string[] = []) {
  const ids = await writerContainerIds(runtime)
  try {
    return await inspectWriterContainers(runtime, ids)
  } catch (error) {
    if (knownDisjoint.length === 0 || (error as { code?: unknown }).code !== 125) throw error
    // A peer checked before shutdown can disappear between the Podman list and lookup.
    // Keep unknown peers and a missing predecessor on the existing fail-closed path.
    const current = await writerContainerIds(runtime)
    const removed = ids.filter(id => !current.includes(id))
    if (removed.length === 0 || removed.some(id => !knownDisjoint.includes(id))) throw error
    return await inspectWriterContainers(runtime, current)
  }
}

function directoryIdentity(path: string): string {
  const { dev, ino } = statSync(path, { bigint: true })
  return `${dev}:${ino}`
}

function ancestorIdentities(path: string): Set<string> {
  const result = new Set<string>()
  for (let current = realpathSync(path); ; current = dirname(current)) {
    result.add(directoryIdentity(current))
    if (current === dirname(current)) return result
  }
}

function overlaps(path: string, profile: string, ancestors: Set<string>): boolean {
  return ancestors.has(directoryIdentity(path)) || ancestorIdentities(path).has(directoryIdentity(profile))
}

function hostCouldOwnLock(holder: number): boolean {
  try {
    const status = readFileSync(`/proc/${holder}/status`, 'utf8')
    const uids = /^Uid:[\t ]+([0-9\t ]+)$/mu.exec(status)?.[1]?.trim().split(/\s+/u)
    return !uids || uids.includes(String(process.getuid?.()))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Establish the starting home identity before the platform admits an exclusive writer. */
export async function unclaimedProfileWriterHome(runtime: string, home: string): Promise<string | undefined> {
  if (process.platform !== 'linux') return
  try {
    const identity = profileHomeIdentity(home)
    const ancestors = ancestorIdentities(home)
    if ((await writerContainers(runtime)).some(row => row.sources.some(path => overlaps(path, home, ancestors)))) return
    try {
      readProfileLock(home)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && profileHomeIdentity(home) === identity) return identity
    }
  } catch {
    // Recovery can only use a generation whose exclusive start was verifiable.
  }
}

export interface LiveProfileWriter {
  readonly lock: string
  readonly home: string
  readonly boot: string
  readonly startedAt: number
  readonly observed: readonly string[]
}

const bootIdentity = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()

function processStartTicks(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  if (ticks === undefined || !/^[1-9][0-9]*$/u.test(ticks)) throw new Error('Invalid process start identity')
  return ticks
}

async function hasLegacyWriterHistory(runtime: string, id: string, startedAt: number, visible: ReadonlySet<string>): Promise<boolean> {
  const logger = await execFileText(runtime, ['info', '--format', '{{.Host.EventLogger}}'], options())
  if (logger.trim() !== 'file' || !Number.isFinite(startedAt)) return false
  const output = await execFileText(
    runtime,
    ['events', '--stream=false', '--since', new Date(startedAt - 5_000).toISOString(), '--filter', 'type=container', '--format', 'json'],
    options(),
  )
  let sawStart = false
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const event = JSON.parse(line) as { ID?: string; Status?: string; Time?: string; Name?: string }
    if (!event.ID || !event.Status || !event.Time || !Number.isFinite(Date.parse(event.Time))) return false
    if (event.ID === id && event.Status === 'start') sawStart = true
    if (Date.parse(event.Time) >= startedAt && event.ID !== id && !visible.has(event.ID)) return false
    if (Date.parse(event.Time) >= startedAt && event.Name?.startsWith('dsh-phalanx-execution-')) return false
  }
  return sawStart
}

/** Old images lack a launch record. Bind a real lock to the old writer before stopping it. */
export async function liveLegacyProfileWriter(runtime: string, id: string, home: string): Promise<LiveProfileWriter | undefined> {
  if (process.platform !== 'linux') return
  try {
    const lock = readProfileLock(home)
    if (hostCouldOwnLock(lock.holder)) return
    const facts = await writerContainers(runtime)
    const owner = facts.find(row => row.id === id)
    if (!owner?.home || owner.state !== 'running' || owner.pid <= 0 || owner.pidMode !== 'private' || lock.bornAt <= owner.startedAt) return
    const profile = dshWebProfilePath(home)
    const ancestors = ancestorIdentities(profile)
    if (facts.some(row => row.id !== id && row.sources.some(path => overlaps(path, profile, ancestors)))) return
    if (!(await hasLegacyWriterHistory(runtime, id, owner.startedAt, new Set(facts.map(row => row.id))))) return
    const mountedHome = `/proc/${owner.pid}/root${DSH_CONTAINER_HOME}`
    const identity = profileHomeIdentity(home)
    // Enter Podman's rootless user namespace to inspect the actual bind through procfs.
    const mounted = await execFileText(
      runtime,
      ['unshare', '/usr/bin/stat', '--dereference', '--format', '%d:%i', '--', mountedHome, dshWebProfilePath(mountedHome)],
      options(),
    )
    if (mounted.trim() !== [directoryIdentity(home), directoryIdentity(profile)].join('\n')) return
    const processes = await execFileText(runtime, ['top', id, 'hpid', 'pid'], options())
    const pids = processes
      .trim()
      .split('\n')
      .slice(1)
      .map(row => row.trim().split(/\s+/u))
    const holders = pids.filter(([, pid]) => pid === String(lock.holder))
    if (holders.length !== 1 || !/^[1-9][0-9]*$/u.test(holders[0]?.[0] ?? '')) return
    const holder = Number(holders[0]![0])
    const namespace = readlinkSync(`/proc/${owner.pid}/ns/pid`)
    if (readlinkSync(`/proc/${holder}/ns/pid`) !== namespace || namespace === readlinkSync('/proc/self/ns/pid')) return
    const start = processStartTicks(holder)
    const started = /^btime ([0-9]+)$/mu.exec(readFileSync('/proc/stat', 'utf8'))?.[1]
    const frequency = Number((await execFileText('getconf', ['CLK_TCK'], options())).trim())
    // /proc/stat gives boot time in whole seconds. Use its upper bound.
    if (!started || !Number.isSafeInteger(frequency) || frequency <= 0 || lock.bornAt <= (Number(started) + 1 + Number(start) / frequency) * 1000) return
    if (processStartTicks(holder) !== start || readProfileLock(home).identity !== lock.identity || hostCouldOwnLock(lock.holder)) return
    return { lock: lock.identity, home: identity, boot: bootIdentity(), startedAt: owner.startedAt, observed: facts.map(row => row.id) }
  } catch {
    return
  }
}

/** Verify the stopped private PID namespace and reject every other carrier that can write this profile. */
export async function exitedContainerLockEvidence(
  runtime: string,
  id: string,
  home: string,
  lock: ProfileLock,
  startingHome: string | undefined,
  revision: string | undefined,
  legacy: LiveProfileWriter | undefined,
): Promise<MemberProfileLockEvidence> {
  if (process.platform !== 'linux') return { state: 'unknown' }
  if (hostCouldOwnLock(lock.holder)) return { state: 'active' }
  const facts = await writerContainers(
    runtime,
    legacy?.observed.filter(candidate => candidate !== id),
  )
  const owner = facts.find(row => row.id === id)
  if (!owner || !owner.home || realpathSync(owner.home) !== realpathSync(home) || owner.pidMode !== 'private') return { state: 'unknown' }
  if (owner.pid !== 0 || owner.state !== 'exited') return { state: 'active' }
  const identity = profileHomeIdentity(home)
  const launched = revision !== undefined && startingHome === `${identity}/${revision}`
  if (
    !launched &&
    (legacy?.home !== identity ||
      legacy.lock !== lock.identity ||
      legacy.boot !== bootIdentity() ||
      legacy.startedAt !== owner.startedAt ||
      !(await hasLegacyWriterHistory(runtime, id, owner.startedAt, new Set([...legacy.observed, ...facts.map(row => row.id)]))))
  ) {
    return { state: 'unknown' }
  }
  if (!Number.isFinite(owner.startedAt) || !Number.isFinite(owner.finishedAt) || owner.startedAt <= 0 || owner.finishedAt <= owner.startedAt) {
    return { state: 'unknown' }
  }
  const profile = dshWebProfilePath(home)
  const ancestors = ancestorIdentities(profile)
  for (const peer of facts) {
    if (peer.id === id) continue
    const couldShareLifetime =
      peer.pid > 0 ||
      peer.state === 'running' ||
      !Number.isFinite(peer.startedAt) ||
      !Number.isFinite(peer.finishedAt) ||
      (peer.startedAt < owner.finishedAt && peer.finishedAt > owner.startedAt)
    if (couldShareLifetime && peer.sources.some(path => overlaps(path, profile, ancestors))) {
      return { state: peer.pid > 0 || peer.state === 'running' ? 'active' : 'unknown' }
    }
  }
  if (hostCouldOwnLock(lock.holder)) return { state: 'active' }
  return { state: 'exited', startedAt: owner.startedAt + 1, finishedAt: owner.finishedAt }
}
