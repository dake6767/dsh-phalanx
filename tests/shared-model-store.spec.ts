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
