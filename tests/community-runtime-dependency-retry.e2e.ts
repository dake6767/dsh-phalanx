// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { RuntimeDependency } from '../src/domain/runtime-dependency.js'
import { RuntimeDependencies } from '../src/use-cases/runtime-dependencies.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'

function signal() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

it('refreshes a queued retry after the previous publication and its first browser refresh finish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dependency-retry-browser-'))
  const app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'dependency-retry-fixture-secret-32',
    runtime: {
      command: '/unavailable',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
    },
  })
  const actor = { username: 'admin', spaceId: 'admin', sessionEpoch: 0 },
    rows = new Map<string, RuntimeDependency>()
  const published = signal(),
    release = signal(),
    refreshed = signal()
  let attempts = 0,
    retryAccepted = false
  // The public owner and browser wire seam use a controlled publisher. No real DSH is required.
  const dependencies = new RuntimeDependencies(
    { get: async () => ({ ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
    {
      view: { list: () => [...rows.values()], version: () => JSON.stringify([...rows.values()]) },
      list: async () => [...rows.values()],
      save: async row => {
        rows.set(row.name, row)
      },
      remove: async name => {
        rows.delete(name)
      },
    },
    {
      isolated: false,
      recover: async () => {},
      collect: async () => {},
      identity: () => 'fixture',
      prepare: async () => {
        attempts++
        return {
          id: `version-${attempts}`,
          identity: 'fixture',
          directory: '/fixture',
          mountedPath: '/fixture',
          pathDirectories: ['bin'],
          commands: ['example'],
          commandPaths: { example: 'bin/example' },
          bytes: 1,
          isolated: false,
          checks: [],
          log: `preparation-${attempts}`,
        }
      },
    },
    { now: () => 100 },
    { list: async () => [] },
    async () => {
      if (attempts === 1) {
        published.resolve()
        await release.promise
      }
    },
  )
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(),
      page = await browser.newPage({ locale: 'en' })
    page.setDefaultTimeout(10000)
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await selectBuiltinDatabase(page)
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click()
    await page.waitForURL(`${origin}/admin`)
    await dependencies.create(actor, { name: 'example', prepareCommand: 'fixture', pathDirectories: ['bin'] })
    await published.promise
    await page.route('**/admin/api/runtime-dependencies', async route => {
      if (route.request().method() === 'POST') {
        expect(route.request().postDataJSON()).toEqual({ action: 'prepare', name: 'example' })
        void dependencies.prepare(actor, 'example')
        retryAccepted = true
        await route.fulfill({ status: 202, json: await dependencies.list(actor) })
      } else {
        await route.fulfill({ json: await dependencies.list(actor) })
        if (retryAccepted) refreshed.resolve()
      }
    })
    await page.getByRole('link', { name: 'Runtime dependencies', exact: true }).click()
    await page.getByRole('button', { name: 'View dependency example', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: 'example', exact: true })
    await drawer.getByRole('button', { name: 'Prepare again', exact: true }).click()
    await refreshed.promise
    await drawer.getByRole('status').getByText('Preparing dependency', { exact: true }).waitFor()
    expect(await drawer.getByRole('button', { name: 'Prepare again', exact: true }).isDisabled()).toBe(true)
    release.resolve()
    await expect.poll(() => drawer.getByLabel('Full preparation and check log').inputValue(), { timeout: 10000 }).toBe('preparation-2')
    await drawer.getByRole('status').getByText('Ready', { exact: true }).waitFor()
    expect(attempts).toBe(2)
  } finally {
    release.resolve()
    await dependencies.stop()
    await browser.close()
    await app.stop()
    await removeCommunityFixture(root)
  }
})
