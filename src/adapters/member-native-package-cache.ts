import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { ContainerConfig } from '../domain/community-config.js'
import type { PluginIdentity } from '../domain/plugin-library.js'
import type { RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import type { NativePluginCache } from '../ports/member-native-plugins.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'

const stagePattern = /^\/tmp\/phalanx-native-cache-[A-Za-z0-9]{10}$/u

/** Copies the prepared offline seed into an isolated operation, leaving the shared tree read-only. */
export class MemberNativePackageCache {
  constructor(
    private readonly container: ContainerConfig,
    private readonly library: Pick<PluginLibraryStorePort, 'list'>,
    private readonly dependencies: {
      withPrepared<T>(names: readonly string[], run: (versions: readonly RuntimeDependencyVersion[]) => Promise<T>): Promise<T>
    },
  ) {}

  async use<T>(
    instance: CommunityUserInstance,
    owner: PluginIdentity | undefined,
    integrity: string,
    signal: AbortSignal,
    run: (cache?: NativePluginCache) => Promise<T>,
  ): Promise<T> {
    if (!owner) return await run()
    const row = (await this.library.list()).find(row => row.packageName === owner.packageName)
    const binding =
      row?.suiteOrigin && row.current?.version === owner.version && row.current.integrity === integrity
        ? row.suiteResourceBindings?.find(row => row.kind === 'native-package-cache')
        : undefined
    if (!binding || binding.kind !== 'native-package-cache') return await run()
    if (!instance.containerName) throw Error('The member offline cache requires a native container')
    const container = instance.containerName
    return await this.dependencies.withPrepared([binding.runtimeDependency], async ([version]) => {
      if (!version?.isolated) throw Error('The locked package cache is unavailable')
      const root = await realpath(version.directory),
        seed = join(root, binding.path)
      if ((await realpath(seed)) !== seed) throw Error('The locked package cache path changed')
      const env = containerClientEnvironment()
      const directory = (
        await execFileText(this.container.runtime, ['exec', container, 'mktemp', '-d', '/tmp/phalanx-native-cache-XXXXXXXXXX'], { env, signal })
      ).trim()
      if (!stagePattern.test(directory)) throw Error('The member offline cache could not be prepared')
      try {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        await copySeed(this.container.runtime, container, seed, directory, deadline)
        return await run({ directory, owner, packages: binding.packages })
      } finally {
        await execFileText(this.container.runtime, ['exec', container, 'rm', '-rf', '--', directory], { env, timeout: 10_000 }).catch(() => {})
      }
    })
  }
}

async function copySeed(runtime: string, container: string, seed: string, stage: string, signal: AbortSignal) {
  const pack = spawn('tar', ['-C', seed, '-cf', '-', 'metadata', 'store'], { signal, stdio: ['ignore', 'pipe', 'ignore'] })
  // The prepared tree is sealed. SQLite WAL sidecars and registry aliases need a writable private copy.
  const unpack = spawn(
    runtime,
    [
      'exec',
      '-i',
      container,
      'sh',
      '-ec',
      'tar -xf - -C "$1" --no-same-owner && find -P "$1/metadata" "$1/store" \\( -type f -o -type d \\) -exec chmod u+w {} +',
      'sh',
      stage,
    ],
    {
      env: containerClientEnvironment(),
      signal,
      stdio: ['pipe', 'ignore', 'ignore'],
    },
  )
  const finished = (child: typeof pack | typeof unpack) =>
    new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => (code === 0 ? resolve() : reject(Error('The locked package cache could not be copied'))))
    })
  try {
    await Promise.all([pipeline(pack.stdout, unpack.stdin, { signal }), finished(pack), finished(unpack)])
  } finally {
    if (pack.exitCode === null) pack.kill()
    if (unpack.exitCode === null) unpack.kill()
  }
}
