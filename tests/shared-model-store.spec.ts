import { realpath, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileSharedModelStore } from '../src/adapters/shared-model-store.js'

it('loads the installed public model adapter without requiring an unused runtime package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-model-runtime-'))
  try {
    const command = join(root, 'cli.js'), adapter = join(root, 'node_modules/@deepseek-ai/dsh-llm-pi-ai')
    await mkdir(adapter, { recursive: true }); await writeFile(command, '')
    await writeFile(join(adapter, 'package.json'), JSON.stringify({ main: 'index.js' })); await writeFile(join(adapter, 'index.js'), '')
    const dataRoot = join(root, 'data'); await mkdir(dataRoot, { mode: 0o700 })
    new FileSharedModelStore(join(dataRoot, 'shared-models.json'), { revision: 0, providers: [], defaultModelId: null }, { command: process.execPath, args: [command], dataRoot, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } })
    const config = JSON.parse(await readFile(join(dataRoot, 'managed-models/models.json'), 'utf8')) as { id: string, name: string }[]
    expect(config.find(row => row.id === 'phalanx-shared-models')?.name).toBe(await realpath(join(adapter, 'index.js')))
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('adds the declared input to existing shared models once and keeps it on every later load', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-model-migration-'))
  try {
    const path = join(root, 'shared-models.json')
    await writeFile(path, JSON.stringify({ revision: 4, defaultModelId: 'flash', providers: [{
      id: 'provider', name: 'Shared', baseUrl: 'https://models.example.test/anthropic', apiFormat: 'anthropic-messages',
      apiKey: 'fixture-key', enabled: true, models: [
        { id: 'flash', name: 'deepseek-flash', enabled: true },
        { id: 'custom', name: 'custom-chat', enabled: true },
      ] }] }))
    const initial = { revision: 0, providers: [], defaultModelId: null }
    const store = new FileSharedModelStore(path, initial)
    expect(store.read().providers[0]!.models).toEqual([
      { id: 'flash', name: 'deepseek-flash', enabled: true, input: 'text+image' },
      { id: 'custom', name: 'custom-chat', enabled: true, input: 'text' },
    ])
    const migrated = await readFile(path, 'utf8')
    expect((JSON.parse(migrated) as { providers: { models: unknown[] }[] }).providers[0]!.models).toEqual(store.read().providers[0]!.models)
    const config = JSON.parse(await readFile(join(root, 'managed-models/models.json'), 'utf8')) as Array<{ id: string, config: { providers: Record<string, { models: unknown[] }> } }>
    expect(config.find(row => row.id === 'phalanx-shared-models')!.config.providers['deepseek-official']!.models).toEqual([
      { id: 'flash', name: 'Shared / deepseek-flash', input: ['text', 'image'] },
      { id: 'custom', name: 'Shared / custom-chat', input: ['text'] },
    ])
    new FileSharedModelStore(path, initial)
    expect(await readFile(path, 'utf8')).toBe(migrated)
  } finally { await rm(root, { recursive: true, force: true }) }
})
