import { expect, it } from 'vitest'
import { BusinessRuleError } from '../src/domain/business-error.js'
import { npmPluginSource, type LibraryPlugin, type PluginIdentity } from '../src/domain/plugin-library.js'
import { PluginUpdates } from '../src/use-cases/plugin-updates.js'

const actor = { username: 'admin', spaceId: 'space-admin', sessionEpoch: 1 }

const unreachableGithub = {
  resolve: async () => {
    throw new Error('npm fixture')
  },
  pack: async () => {
    throw new Error('npm fixture')
  },
  discard: async () => {},
}

function updates(options: { current?: string; latest?: string; source?: 'npm' | 'upload' } = {}) {
  const resolved: PluginIdentity[] = [],
    replaced: PluginIdentity[] = []
  const service = new PluginUpdates(
    {
      updateBase: async (_actor, packageName) => {
        if (options.source === 'upload') throw new BusinessRuleError('conflict', 'Another source.', 'plugin-source-conflict')
        return {
          packageName,
          source: npmPluginSource,
          version: options.current ?? '1.0.0',
          current: null,
          stage: 'available',
          published: false,
        } as LibraryPlugin
      },
      replace: async (_actor, input) => {
        replaced.push(input)
        return { packageName: input.packageName, version: input.version } as never
      },
    },
    {
      resolve: async input => {
        resolved.push(input)
        return { packageName: input.packageName, version: options.latest ?? '1.0.0' }
      },
    },
    unreachableGithub,
  )
  return { service, resolved, replaced }
}

it('compares the recorded exact version with npm latest without preparing anything', async () => {
  const { service, resolved, replaced } = updates({ current: '1.0.0', latest: '1.2.0' })
  expect(await service.check(actor, 'plugin')).toEqual({ packageName: 'plugin', currentVersion: '1.0.0', latestVersion: '1.2.0', hasUpdate: true })
  expect(resolved).toEqual([{ packageName: 'plugin', version: 'latest' }])
  expect(replaced).toEqual([])
})

it('hands exactly one resolved version to the replacement precheck and refuses an up-to-date update', async () => {
  const fresh = updates({ latest: '2.0.0' })
  await fresh.service.prepare(actor, 'plugin')
  expect(fresh.resolved).toHaveLength(1)
  expect(fresh.replaced).toEqual([{ packageName: 'plugin', version: '2.0.0' }])
  const current = updates({ latest: '1.0.0' })
  await expect(current.service.prepare(actor, 'plugin')).rejects.toMatchObject({ code: 'plugin-up-to-date' })
  expect(current.replaced).toEqual([])
})

it('asks the registry nothing for a plugin recorded from another source', async () => {
  const { service, resolved } = updates({ source: 'upload' })
  await expect(service.check(actor, 'plugin')).rejects.toMatchObject({ code: 'plugin-source-conflict' })
  await expect(service.prepare(actor, 'plugin')).rejects.toMatchObject({ code: 'plugin-source-conflict' })
  expect(resolved).toEqual([])
})

it('compares a GitHub row with the default-branch head and packs only a changed commit into the replacement', async () => {
  const commit = 'dcd348e0bec148af45bc0b1a8f33ef82c44aeeef',
    head = 'b4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3'
  const resolved: string[] = [],
    packed: string[] = [],
    discarded: string[] = []
  const replaced: { packageName: string; version: string; sourceCommit: string | undefined }[] = []
  const row = {
    packageName: '@fixture/github-skin',
    source: { kind: 'github', repository: 'example/skin' } as const,
    version: '0.1.15-settings.4',
    current: { version: '0.1.15-settings.4', sourceCommit: commit },
    stage: 'available',
    published: false,
  } as LibraryPlugin
  let latest = head
  const service = new PluginUpdates(
    {
      updateBase: async () => row,
      replace: async (_actor, input, _source, sourceCommit) => {
        replaced.push({ packageName: input.packageName, version: input.version, sourceCommit })
        return { packageName: input.packageName, version: input.version } as never
      },
    },
    {
      resolve: async () => {
        throw new Error('registry fixture')
      },
    },
    {
      resolve: async repository => {
        resolved.push(repository)
        return { repository, commit: latest }
      },
      pack: async revision => {
        packed.push(revision.commit)
        return { packageName: '@fixture/github-skin', version: '0.1.16-settings.1', archive: '/uploads/archives/packed.tgz', integrity: 'sha512-github' }
      },
      discard: async archive => {
        discarded.push(archive)
      },
    },
  )
  latest = commit
  expect(await service.check(actor, '@fixture/github-skin')).toEqual({
    packageName: '@fixture/github-skin',
    currentVersion: '0.1.15-settings.4',
    latestVersion: null,
    hasUpdate: false,
    currentCommit: commit,
    latestCommit: commit,
  })
  await expect(service.prepare(actor, '@fixture/github-skin')).rejects.toMatchObject({ code: 'plugin-up-to-date' })
  expect(packed).toEqual([])
  latest = head
  expect(await service.check(actor, '@fixture/github-skin')).toMatchObject({ hasUpdate: true, latestCommit: head })
  await service.prepare(actor, '@fixture/github-skin')
  expect(resolved).toEqual(['example/skin', 'example/skin', 'example/skin', 'example/skin'])
  expect(packed).toEqual([head])
  expect(replaced).toEqual([{ packageName: '@fixture/github-skin', version: '0.1.16-settings.1', sourceCommit: head }])
  expect(discarded).toEqual([])
  // A repository that now packs under another package name is refused and its archive released.
  latest = 'cccccccccccccccccccccccccccccccccccccccc'
  const moved = new PluginUpdates(
    {
      updateBase: async () => row,
      replace: async () => {
        throw new Error('unreached')
      },
    },
    {
      resolve: async () => {
        throw new Error('registry fixture')
      },
    },
    {
      resolve: async repository => ({ repository, commit: latest }),
      pack: async () => ({ packageName: '@fixture/moved-away', version: '9.9.9', archive: '/uploads/archives/moved.tgz', integrity: 'sha512-moved' }),
      discard: async archive => {
        discarded.push(archive)
      },
    },
  )
  await expect(moved.prepare(actor, '@fixture/github-skin')).rejects.toMatchObject({ code: 'plugin-package-invalid' })
  expect(discarded).toEqual(['/uploads/archives/moved.tgz'])
})
