import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { MemberModelsProjection } from '../src/adapters/member-models.js'
import { managedModelsCatalog, managedModelsConfig, managedModelsWatcher } from '../src/dsh/shared-models.js'
import type { SharedModelState } from '../src/domain/shared-models.js'

const state = (models: boolean): SharedModelState => ({
  revision: 1,
  defaultModelId: models ? 'chat' : null,
  providers: models
    ? [
        {
          id: '61626364313233343536373839303132',
          name: 'Shared',
          baseUrl: 'https://models.example.test/anthropic',
          apiFormat: 'anthropic-messages',
          apiKey: 'fixture-key',
          enabled: true,
          models: [{ id: 'chat', name: 'fixture-chat', enabled: true, input: 'text' }],
        },
      ]
    : [],
})
const current = { state: state(false) }
const currentState = (): SharedModelState => current.state

it('derives one projection directory per space in the entering browser language and reuses it across restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'member-models-'))
  try {
    const projection = new MemberModelsProjection(root, currentState)
    projection.enter('space-a', 'zh-CN')
    projection.enter('space-b', 'en')
    // A space that has not entered yet still gets a projection before its instance consumes it.
    projection.ensure('space-c')
    const read = async (space: string, file: string) => readFile(join(root, 'managed-models/members', space, file), 'utf8')
    expect(await read('space-a', managedModelsCatalog)).toContain('共享模型未配置')
    expect(await read('space-b', managedModelsCatalog)).toContain('Shared models not configured')
    expect(await read('space-c', managedModelsCatalog)).toContain('Shared models not configured')
    expect(await read('space-a', managedModelsWatcher)).toContain('phalanx-model-watch')
    expect(await read('space-a', managedModelsConfig)).toContain('catalog.json')
    // A fresh owner over the same data root keeps the language each space last entered.
    expect(await new MemberModelsProjection(root, currentState).language('space-a')).toBe('zh-CN')
  } finally {
    await rm0(root)
  }
})

it('republishes every existing space directory in its own language when the shared models change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'member-models-'))
  try {
    const projection = new MemberModelsProjection(root, currentState)
    projection.enter('space-a', 'zh-CN')
    projection.ensure('space-b')
    current.state = state(true)
    projection.publish(current.state)
    const read = async (space: string) => readFile(join(root, 'managed-models/members', space, managedModelsCatalog), 'utf8')
    for (const space of ['space-a', 'space-b']) {
      expect(await read(space)).toContain('phalanx-61626364313233343536373839303132')
      expect(await read(space)).toContain('fixture-chat')
    }
    current.state = state(false)
    projection.publish(current.state)
    expect(await read('space-a')).toContain('共享模型未配置')
    expect(await read('space-b')).toContain('Shared models not configured')
    expect(await readdir(join(root, 'managed-models/members'))).toEqual(['space-a', 'space-b'])
  } finally {
    await rm0(root)
  }
})

it('binds only the entering space directory into its member container', async () => {
  const root = await mkdtemp(join(tmpdir(), 'member-models-'))
  try {
    const projection = new MemberModelsProjection(root, currentState)
    projection.enter('space-a', 'zh-CN')
    projection.ensure('space-b')
    const bound = projection.mount('space-a')
    expect(bound.patch).toBe(join(root, 'managed-models/members/space-a', 'overlay.yml'))
    expect(bound.volumes).toEqual([{ host: join(root, 'managed-models/members/space-a'), mounted: '/dsh-phalanx/managed-models' }])
  } finally {
    await rm0(root)
  }
})

async function rm0(path: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(path, { recursive: true, force: true })
}
