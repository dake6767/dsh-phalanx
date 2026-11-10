import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { managedModelWatchModule } from '../src/dsh/shared-models.js'

type Presentation = { sections: { text: string }[]; contexts: { text: string }[]; variables: Record<string, string> }
type AssemblyHook = (assembly: Presentation, context: object, next: () => Promise<Presentation>) => Promise<Presentation>

it('resolves the selected supplier and model after the native waterfall without changing templates or routing context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'model-identity-'))
  try {
    const path = join(root, 'catalog.json')
    await writeFile(
      path,
      JSON.stringify([
        {
          id: 'phalanx-shared-models',
          config: {
            providers: {
              'phalanx-first': { models: [{ id: 'route-a', name: 'Default model' }] },
              'phalanx-second': { models: [{ id: 'route-b', name: 'Selected model' }] },
            },
          },
        },
        { id: 'phalanx-default-model', config: { provider: 'phalanx-first', model: 'route-a' } },
      ]),
    )
    const hooks = new Map<string, unknown>()
    const ctx = {
      provide: () => {},
      on: (event: string, handler: unknown) => {
        hooks.set(event, handler)
      },
      hmr: { watchConfig: async () => {} },
    }
    const plugin = (await import('data:text/javascript;base64,' + Buffer.from(managedModelWatchModule).toString('base64'))) as {
      apply: (context: typeof ctx, config: { path: string }) => Promise<void>
    }
    await plugin.apply(ctx, { path })
    const hook = hooks.get('system-prompt/assemble') as AssemblyHook | undefined
    expect(hook).toBeTypeOf('function')
    const original: Presentation = {
      sections: [{ text: 'Native {{model}} template' }],
      contexts: [],
      variables: { provider: 'phalanx-first', model: 'route-a' },
    }
    const selected = { ...original, variables: { provider: 'phalanx-second', model: 'route-b', other: 'kept' } }
    const selection = { modelSelection: { provider: 'phalanx-second', model: 'route-b' } }
    const result = await hook!(original, selection, async () => selected)
    expect(result.variables).toEqual({ provider: 'phalanx-second', model: 'Selected model', other: 'kept' })
    expect(result.sections).toBe(original.sections)
    expect(result.contexts).toBe(original.contexts)
    expect(original.variables.model).toBe('route-a')
    expect(selected.variables.model).toBe('route-b')
    expect(selection.modelSelection).toEqual({ provider: 'phalanx-second', model: 'route-b' })
    for (const variables of [
      { provider: 'personal', model: 'route-b' },
      { provider: 'constructor', model: 'route-b' },
      { provider: '__proto__', model: 'route-b' },
      { provider: 'toString', model: 'route-b' },
      { provider: 'phalanx-second', model: 'missing' },
    ]) {
      const unmanaged = { ...original, variables }
      expect(await hook!(original, {}, async () => unmanaged)).toBe(unmanaged)
    }
    await writeFile(
      path,
      JSON.stringify([
        {
          id: 'phalanx-shared-models',
          config: {
            providers: {
              'phalanx-first': { models: [{ id: 'route-a', name: 'Renamed shared model' }] },
              'phalanx-second': { models: [{ id: 'route-b', name: 'Renamed shared model' }] },
            },
          },
        },
        { id: 'phalanx-default-model', config: { provider: 'phalanx-first', model: 'route-a' } },
      ]),
    )
    for (const variables of [
      { provider: 'phalanx-first', model: 'route-a' },
      { provider: 'phalanx-second', model: 'route-b' },
    ]) {
      const actual = { ...original, variables }
      expect((await hook!(actual, {}, async () => actual)).variables).toEqual({ ...variables, model: 'Renamed shared model' })
      expect(actual.variables).toEqual(variables)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
