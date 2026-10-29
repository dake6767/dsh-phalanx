import { expect, it } from 'vitest'
import { DownloadSources } from '../src/use-cases/download-sources.js'
import type { DownloadSourceSelection } from '../src/domain/download-source.js'

it('lets a fresh administrator select a preset and override individual categories without changing the preset', async () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let account = { ...actor, email: '', admin: true, groupId: 'admin', disabled: false, createdAt: 0, updatedAt: 0 }
  let saved: DownloadSourceSelection = { preset: 'official' }
  const sources = new DownloadSources(
    { get: async () => account },
    {
      get: () => ({ ...saved, saved: true }),
      save: async value => {
        saved = value
      },
    },
  )
  expect((await sources.view(actor)).sources.npm).toBe('https://registry.npmjs.org')
  const selected = await sources.save(actor, { preset: 'mainland', overrides: { pypi: 'https://packages.example.test/simple/' } })
  expect(selected.sources.npm).toBe('https://registry.npmmirror.com')
  expect(selected.sources.pypi).toBe('https://packages.example.test/simple')
  expect(selected.sources.githubAssets).toBe('https://ghfast.top/')
  expect(sources.current()).toEqual(selected.sources)
  expect((await sources.save(actor, { preset: 'official' })).sources.pypi).toBe('https://pypi.org/simple')
  account = { ...account, admin: false }
  await expect(sources.save(actor, { preset: 'mainland' })).rejects.toThrow('Administrator')
  account = { ...account, admin: true, sessionEpoch: 1 }
  await expect(sources.view(actor)).rejects.toThrow('Sign in')
})

it('rejects credential-bearing, malformed and unknown download choices without replacing the saved selection', async () => {
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
  const account = { ...actor, email: '', admin: true, groupId: 'admin', disabled: false, createdAt: 0, updatedAt: 0 }
  let saved: DownloadSourceSelection = { preset: 'official' }
  const sources = new DownloadSources(
    { get: async () => account },
    {
      get: () => ({ ...saved, saved: true }),
      save: async value => {
        saved = value
      },
    },
  )
  for (const value of [
    { preset: 'unknown' },
    { preset: 'official', overrides: { npm: 'https://name:secret@example.test' } },
    { preset: 'official', overrides: { npm: 'https://registry.example.test/?token=secret' } },
    { preset: 'official', overrides: { npm: 'file:///etc/passwd' } },
    { preset: 'official', overrides: { npm: '' } },
    { preset: 'official', overrides: { npm: 'https:example.test' } },
    { preset: 'official', overrides: { ghcrMirror: 'http://images.example.test' } },
    { preset: 'official', overrides: { npm: 'https://example.test:0/' } },
    { preset: 'official', overrides: { command: 'anything' } },
  ])
    await expect(sources.save(actor, value)).rejects.toThrow(expect.objectContaining({ code: 'download-source-invalid' }))
  expect((await sources.view(actor)).preset).toBe('official')
})
