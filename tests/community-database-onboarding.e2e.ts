// Validation: T1; real credentials: none; controlled browser and real PostgreSQL fixtures.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { testDatabaseConfigFile } from './support/community-application.js'
import { postgresConnection } from './support/postgres.js'

it('authorizes the invitation before showing the database step and keeps the default installation keyboard accessible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'database-onboarding-browser-'))
  const application = createCommunityApplication({
    platformDatabaseConfigFile: testDatabaseConfigFile(root),
    listen: { host: '127.0.0.1', port: 0 },
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await application.start(),
      context = await browser.newContext({ locale: 'en', viewport: { width: 390, height: 844 } }),
      page = await context.newPage()
    await page.goto(origin + '/bootstrap')
    expect(await page.locator('[name="databaseHost"]').count()).toBe(0)
    await page.goto(origin + '/bootstrap#credential=' + readBootstrapCredential(root)!.credential)
    await page.getByRole('heading', { name: 'Platform database', exact: true }).waitFor()
    expect(await page.getByLabel('Username', { exact: true }).count()).toBe(0)
    expect(await page.getByLabel('Platform database', { exact: true }).inputValue()).toBe('builtin')
    await page.getByRole('button', { name: 'Continue', exact: true }).focus()
    await page.keyboard.press('Enter')
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('fictional-admin-password')
    await page.getByRole('button', { name: 'Create administrator', exact: true }).click()
    await page.waitForURL(origin + '/admin')
    expect(readBootstrapCredential(root)).toBeUndefined()
    expect((await context.request.get(origin + '/admin/api/session')).status()).toBe(200)
  } finally {
    await browser.close()
    await application.stop()
    await removeCommunityFixture(root)
  }
})

it('reports external connection failures in Chinese and requires an explicit successful test before continuing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'external-database-browser-')),
    external = postgresConnection()
  const application = createCommunityApplication({
    platformDatabaseConfigFile: testDatabaseConfigFile(root),
    listen: { host: '127.0.0.1', port: 0 },
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await application.start(),
      context = await browser.newContext({ locale: 'zh-CN' }),
      page = await context.newPage()
    await page.goto(origin + '/bootstrap#credential=' + readBootstrapCredential(root)!.credential)
    await page.getByRole('heading', { name: '平台数据库', exact: true }).waitFor()
    await page.getByLabel('平台数据库', { exact: true }).selectOption('external')
    await page.getByLabel('数据库地址', { exact: true }).fill(external.host)
    await page.getByLabel('数据库端口', { exact: true }).fill(String(external.port))
    await page.getByLabel('数据库名称', { exact: true }).fill(external.database)
    await page.getByLabel('数据库账号', { exact: true }).fill(external.username)
    await page.getByLabel('数据库口令', { exact: true }).fill(external.password)
    await page.getByLabel('TLS 模式', { exact: true }).selectOption('require')
    expect(await page.getByRole('button', { name: '继续', exact: true }).isDisabled()).toBe(true)
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await page
      .getByRole('status')
      .filter({ hasText: /数据库连通性: (未通过|失败)/u })
      .waitFor()
    expect(await page.getByRole('button', { name: '继续', exact: true }).isDisabled()).toBe(true)
    await page.getByLabel('TLS 模式', { exact: true }).selectOption('disable')
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await page
      .getByRole('status')
      .filter({ hasText: /空 Schema 或属于当前平台: 通过/u })
      .waitFor()
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await page.getByLabel('用户名', { exact: true }).fill('admin')
    await page.getByLabel('密码', { exact: true }).fill('fictional-admin-password')
    await page.getByRole('button', { name: '创建管理员', exact: true }).click()
    await page.waitForURL(origin + '/admin')
  } finally {
    await browser.close()
    await application.stop()
    await removeCommunityFixture(root)
  }
})
