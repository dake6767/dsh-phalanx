import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import type { ContainerHostnames } from '../ports/container-hostnames.js'
import { parseManagedContainers } from '../dsh/container.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'

/** Lists and removes only this data root's carriers, optionally retaining a proven current-space identity. */
export class OwnedCommunityContainers {
  constructor(
    private readonly container: CommunityRuntimeConfig['container'],
    private readonly ownership: string,
  ) {}
  async rebuild(hostnames?: ContainerHostnames): Promise<readonly string[]> {
    const container = this.container
    if (!container) return []
    const output = await execFileText(container.runtime, [
      'ps',
      '--all',
      '--filter',
      'label=dsh-phalanx.community=1',
      '--filter',
      `label=dsh-phalanx.community-root=${this.ownership}`,
      '--format',
      'json',
    ])
    const removed: string[] = []
    for (const record of parseManagedContainers(output)) {
      if (record.labels['dsh-phalanx.community'] !== '1' || record.labels['dsh-phalanx.community-root'] !== this.ownership)
        throw new Error('Container ownership listing is inconsistent')
      const username = record.labels['dsh-phalanx.user'],
        spaceId = record.labels['dsh-phalanx.space']
      if (hostnames && username && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(username) && spaceId && /^[a-f0-9]{32}$/u.test(spaceId)) {
        const hostname = (await execFileText(container.runtime, ['inspect', '--format', '{{.Config.Hostname}}', record.name])).trim()
        await hostnames.remember({ username, spaceId }, hostname)
      }
      await this.remove(record.name)
      removed.push(record.name)
    }
    return removed
  }
  async assertCarrier(instance: CommunityUserInstance, timeout?: number): Promise<void> {
    const container = this.container
    if (!container || !instance.containerName) throw new Error('Container runtime is unavailable')
    const value = await execFileText(
      container.runtime,
      ['inspect', '--format', '{{.State.Running}} {{.State.Pid}} {{index .Config.Labels "dsh-phalanx.community-root"}}', instance.containerName],
      { env: containerClientEnvironment(), ...(timeout ? { timeout } : {}) },
    )
    if (value.trim() !== `true ${instance.processId} ${this.ownership}`) throw new Error('Member container identity changed')
  }
  async runningNames(): Promise<ReadonlySet<string>> {
    const container = this.container
    if (!container) throw new Error('Container runtime is unavailable')
    const output = await execFileText(container.runtime, [
      'ps',
      '--filter',
      'status=running',
      '--filter',
      'label=dsh-phalanx.community=1',
      '--filter',
      `label=dsh-phalanx.community-root=${this.ownership}`,
      '--format',
      '{{.Names}}',
    ])
    return new Set(output.split('\n').map(name => name.trim()))
  }
  async remove(name: string): Promise<void> {
    const container = this.container
    if (!container) throw new Error('Container runtime is unavailable')
    await execFileText(container.runtime, ['rm', '--force', '--ignore', '--time', '0', name])
    const remaining = await execFileText(container.runtime, ['ps', '--all', '--filter', `name=^${name}$`, '--format', '{{.Names}}'])
    if (remaining.split('\n').some(candidate => candidate.trim() === name)) throw new Error('Owned user container remains after removal')
  }
}
