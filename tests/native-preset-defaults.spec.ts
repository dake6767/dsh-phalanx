import { expect, it } from 'vitest'
import { repairNativePresetDefault } from '../src/dsh/native-presets.js'
import { dshNativeFeatures } from '../src/dsh/native-features.js'

it('repairs a saved disabled builtin before admission using its current settings revision and leaves other settings intact', async () => {
  const value = { selectedDefault: 'standard', retained: 'member-value' }
  let revision = 7
  let writes = 0
  const remote = async (method: string, args: object) => {
    if (method === 'settings/describe') return { namespaces: [{ ns: 'agent-preset-registry', revision, value: { ...value } }] }
    if (method === 'phalanxNativePresets/default') return { defaultId: value.selectedDefault ?? 'standard' }
    if (method !== 'settings/update') throw new Error('Unexpected public operation')
    const request = args as { ns: string; patch: { selectedDefault: string }; expectedRevision: number }
    expect(request.ns).toBe('agent-preset-registry')
    expect(request.expectedRevision).toBe(revision)
    expect(Object.keys(request.patch)).toEqual(['selectedDefault'])
    Object.assign(value, request.patch)
    revision++
    writes++
    return { ns: request.ns, revision, value: { ...value } }
  }
  await repairNativePresetDefault(['preset-standard'], remote, new AbortController().signal)
  expect(value).toEqual({ selectedDefault: 'ptc', retained: 'member-value' })
  expect(writes).toBe(1)
})

it.each([undefined, 'minimal', 'phalanx-expert-fixture', 'member-preset'])(
  'preserves a saved available or member-defined default %s',
  async selectedDefault => {
    let writes = 0
    await repairNativePresetDefault(
      ['preset-standard'],
      async method => {
        if (method === 'phalanxNativePresets/default') return { defaultId: selectedDefault ?? 'member-preset' }
        if (method !== 'settings/describe') writes++
        return { namespaces: [{ ns: 'agent-preset-registry', revision: 1, value: { selectedDefault } }] }
      },
      new AbortController().signal,
    )
    expect(writes).toBe(0)
  },
)

it.each([true, false])('preserves a concurrent expert selection with revisionAdvanced=%s', async revisionAdvanced => {
  let selectedDefault = 'standard',
    revision = 1,
    writes = 0
  await repairNativePresetDefault(
    ['preset-standard'],
    async method => {
      if (method === 'settings/describe') return { namespaces: [{ ns: 'agent-preset-registry', revision, value: { selectedDefault } }] }
      if (method === 'phalanxNativePresets/default') return { defaultId: selectedDefault }
      writes++
      selectedDefault = 'phalanx-expert-fixture'
      if (revisionAdvanced) revision++
      throw new Error('Fixture revision conflict')
    },
    new AbortController().signal,
  )
  expect(selectedDefault).toBe('phalanx-expert-fixture')
  expect(writes).toBe(1)
})

it('reapplies the fallback to a fresh revision when a concurrent choice is also disabled', async () => {
  let selectedDefault = 'standard',
    revision = 1,
    writes = 0
  await repairNativePresetDefault(
    ['preset-standard', 'preset-minimal'],
    async (method, args) => {
      if (method === 'settings/describe') return { namespaces: [{ ns: 'agent-preset-registry', revision, value: { selectedDefault } }] }
      if (method === 'phalanxNativePresets/default') return { defaultId: selectedDefault }
      const request = args as { patch: { selectedDefault: string }; expectedRevision: number }
      expect(request.expectedRevision).toBe(revision)
      if (++writes === 1) {
        revision++
        selectedDefault = 'minimal'
        throw new Error('Fixture revision conflict')
      }
      selectedDefault = request.patch.selectedDefault
      revision++
      return {}
    },
    new AbortController().signal,
  )
  expect(selectedDefault).toBe('ptc')
  expect(writes).toBe(2)
})

it('stops before changing settings if startup is cancelled during the read', async () => {
  const controller = new AbortController()
  let release!: (value: unknown) => void,
    begun!: () => void,
    writes = 0
  const ready = new Promise<void>(resolve => (begun = resolve))
  const read = new Promise<unknown>(resolve => (release = resolve))
  const pending = repairNativePresetDefault(
    ['preset-standard'],
    async method => {
      if (method !== 'settings/describe') writes++
      begun()
      return read
    },
    controller.signal,
  )
  await ready
  const reason = new Error('Fixture startup cancelled')
  controller.abort(reason)
  release({ namespaces: [{ ns: 'agent-preset-registry', revision: 1, value: { selectedDefault: 'standard' } }] })
  await expect(pending).rejects.toBe(reason)
  expect(writes).toBe(0)
})

it('retains provider errors when no competing revision explains the refusal', async () => {
  const failure = new Error('Fixture provider refused a write')
  await expect(
    repairNativePresetDefault(
      ['preset-standard'],
      async method => {
        if (method === 'settings/describe') return { namespaces: [{ ns: 'agent-preset-registry', revision: 1, value: { selectedDefault: 'standard' } }] }
        if (method === 'phalanxNativePresets/default') return { defaultId: 'standard' }
        throw failure
      },
      new AbortController().signal,
    ),
  ).rejects.toBe(failure)
})

it('does not contact settings when every builtin is enabled', async () => {
  await repairNativePresetDefault(
    ['terminal'],
    async () => {
      throw new Error('Unnecessary settings request')
    },
    new AbortController().signal,
  )
})

it('repairs a disabled configured default even when no volatile selection was saved', async () => {
  let selectedDefault: string | undefined
  let revision = 1
  const writes: object[] = []
  await repairNativePresetDefault(
    ['preset-standard'],
    async (method, args) => {
      if (method === 'settings/describe') return { namespaces: [{ ns: 'agent-preset-registry', revision, value: { selectedDefault } }] }
      if (method === 'phalanxNativePresets/default') return { defaultId: selectedDefault ?? 'standard' }
      const request = args as { patch: { selectedDefault: string }; expectedRevision: number }
      expect(method).toBe('settings/update')
      expect(request.expectedRevision).toBe(revision)
      writes.push(args)
      selectedDefault = request.patch.selectedDefault
      revision++
      return {}
    },
    new AbortController().signal,
  )
  expect(selectedDefault).toBe('ptc')
  expect(writes).toHaveLength(1)
})

it('leaves registry configuration in the member profile when disabling builtin declarations', () => {
  const patch = dshNativeFeatures().patch(['preset-standard'])
  expect(patch).toContainEqual({ id: 'preset-standard', disabled: true })
  expect(patch.find(row => row.id === 'agent-preset-registry')).toBeUndefined()
})
