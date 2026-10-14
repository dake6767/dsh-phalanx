import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RuntimeContributionCommands } from '../src/adapters/contribution-command-inventory.js'
import { ContainerExecutionProcess } from '../src/adapters/execution-container-process.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { runtimeSection } from './support/real-dsh-runtime.js'

it('reads actual image commands without member mounts or contributed programs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-inventory-'))
  const process = new ContainerExecutionProcess(runtimeSection(root, 'http://127.0.0.1:1', runtimeSettings))
  try {
    await process.recover()
    const inventory = new RuntimeContributionCommands(process), names = await inventory.commands(new AbortController().signal)
    expect(names).toEqual(expect.arrayContaining(['node', 'bash', 'sh']))
    expect(names).not.toContain('officecli')
    expect(await inventory.commands(new AbortController().signal)).toBe(names)
  } finally { await process.stop(); await rm(root, { recursive: true, force: true }) }
})
