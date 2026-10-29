// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication, testDatabaseConfigFile } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'

let app: CommunityApplication | undefined
let browser: Browser | undefined
let root: string | undefined
afterEach(async () => {
  await browser?.close()
  await app?.stop()
  if (root) await removeCommunityFixture(root)
})
it('shows bilingual database and key facts and shares an offline-backup confirmation after refresh', async () => {
  root = await mkdtemp(join(tmpdir(), 'system-update-browser-'))
  app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'system-update-browser-fixture-32-bytes',
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } },
    },
  })
  const origin = await app.start()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en' })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await selectBuiltinDatabase(page)
  await page.getByLabel('Username', { exact: true }).fill('admin')
  await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator' }).click()
  await page.waitForURL(`${origin}/admin`)
  let sessionUnavailable = true
  await page.route('**/admin/api/session', async route => {
    if (!sessionUnavailable) {
      await route.continue()
      return
    }
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'platform-database-unavailable',
        error: 'Platform database is temporarily unavailable. Check the database service and connection settings.',
      }),
    })
  })
  await page.getByRole('link', { name: 'System settings', exact: true }).click()
  await page.getByText('Platform database is temporarily unavailable. Check the database service and connection settings.', { exact: true }).waitFor()
  sessionUnavailable = false
  const panel = page.getByRole('region', { name: 'Platform database and master key', exact: true })
  await panel.getByText('Built-in PostgreSQL', { exact: true }).waitFor()
  await panel.getByText('Connected', { exact: true }).waitFor()
  const fingerprint = await panel.locator('code').textContent()
  expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u)
  const cli = await promisify(execFile)(process.execPath, [
    '--import',
    'tsx',
    'src/composition/cli.ts',
    'master-key-fingerprint',
    '--config-file',
    testDatabaseConfigFile(root!),
    '--data-root',
    root!,
  ])
  expect(JSON.parse(cli.stdout).fingerprint).toBe(fingerprint)
  await panel.getByText('Offline backup not confirmed', { exact: true }).waitFor()
  await panel.getByRole('button', { name: 'I have backed up the master key offline', exact: true }).click()
  await panel.getByText('Confirmed by admin', { exact: true }).waitFor()
  await page.reload()
  await panel.getByText('Confirmed by admin', { exact: true }).waitFor()
  expect(await panel.locator('code').textContent()).toBe(fingerprint)
  await context.addCookies([{ name: 'dsh-phalanx.lang', value: 'zh-CN', url: origin }])
  await page.reload()
  const chinese = page.getByRole('region', { name: '平台数据库与主密钥', exact: true })
  await chinese.getByText('内置 PostgreSQL', { exact: true }).waitFor()
  await chinese.getByText('由 admin 确认', { exact: true }).waitFor()
  expect(await chinese.locator('time').getAttribute('dateTime')).toMatch(/^\d{4}-/u)
  expect(await chinese.getByRole('button').count()).toBe(0)
})

it('automatically restores a fresh administration page after an actual database outage', async () => {
  root = await mkdtemp(join(tmpdir(), 'system-database-browser-'))
  const { withTestDatabase } = await import('./support/community-application.js')
  const { createSupervisedCommunityApplication } = await import('../src/composition/community-supervised-application.js')
  const { FilePlatformDatabaseConfig } = await import('../src/adapters/platform-database-config.js')
  const { Pool } = await import('pg')
  const config = withTestDatabase({
    listen: { host: '127.0.0.1', port: 0 },
    runtime: {
      command: '/unused-runtime',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  const { postgresConnection } = await import('./support/postgres.js')
  const connection = postgresConnection()
  FilePlatformDatabaseConfig.select(config.platformDatabaseConfigFile!, root, connection, 'external')
  const control = new Pool({ ...connection, database: 'postgres', user: connection.username })
  let retry: (() => Promise<void>) | undefined
  app = createSupervisedCommunityApplication(
    config,
    {},
    {
      schedule: task => {
        retry = async () => {
          retry = undefined
          await task()
        }
        return () => {
          retry = undefined
        }
      },
    },
  )
  try {
    const origin = await app.start()
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ locale: 'en' }),
      page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await selectBuiltinDatabase(page)
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click()
    await page.waitForURL(`${origin}/admin`)
    await page.goto(origin + '/admin/settings')
    await page.getByText('Connected', { exact: true }).waitFor()
    await page.getByText('External PostgreSQL', { exact: true }).waitFor()
    await control.query(`ALTER DATABASE "${connection.database}" ALLOW_CONNECTIONS false`)
    await control.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [connection.database])
    await expect.poll(async () => (await context.request.get(origin + '/login', { maxRedirects: 0 })).status()).toBe(503)
    await page.goto(origin + '/admin/settings')
    await page.getByRole('heading', { name: 'Platform database is temporarily unavailable', exact: true }).waitFor()
    await context.addCookies([{ name: 'dsh-phalanx.lang', value: 'zh-CN', url: origin }])
    await page.goto(origin + '/login')
    await page.getByRole('heading', { name: '平台数据库暂时不可用', exact: true }).waitFor()
    await page.goto(origin + '/admin/settings')
    await expect.poll(() => typeof retry).toBe('function')
    await control.query(`ALTER DATABASE "${connection.database}" ALLOW_CONNECTIONS true`)
    await retry!()
    // The diagnostic document refreshes itself; there is no explicit navigation after recovery.
    await page.getByRole('region', { name: '平台数据库与主密钥', exact: true }).getByText('已连接', { exact: true }).waitFor()
  } finally {
    await control.query(`ALTER DATABASE "${connection.database}" ALLOW_CONNECTIONS true`)
    await control.end()
  }
})
