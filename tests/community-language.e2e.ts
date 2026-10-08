import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
let app: CommunityApplication | undefined, browser: Browser | undefined, root: string | undefined
afterEach(async () => { await browser?.close(); await app?.stop(); if (root) await rm(root, { recursive: true, force: true }) })
it('renders Chinese platform entries without admin assets and shares explicit language with the management framework', async () => {
 root = await mkdtemp(join(tmpdir(), 'community-language-'))
 app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'language-fixture-session-secret-at-least-32-bytes', runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://api.deepseek.com' } } } })
 const origin = await app.start(); browser = await chromium.launch({ headless: true })
 const context = await browser.newContext({ locale: 'zh-TW' }); const page = await context.newPage(); page.setDefaultTimeout(10_000)
 await context.route('**/admin/assets/**', route => route.abort())
 const initial = await page.goto(`${origin}/login`)
 expect(await initial!.text()).toContain('<html lang="zh-CN">')
 await page.getByRole('heading', { name: '登录 dsh-phalanx', exact: true }).waitFor()
 await page.getByLabel('用户名', { exact: true }).fill('missing'); await page.getByLabel('密码', { exact: true }).fill('wrong')
 await page.getByRole('button', { name: '登录', exact: true }).click()
 await page.getByRole('alert').filter({ hasText: '用户名或密码错误。' }).waitFor()
 await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
 await page.getByRole('heading', { name: '创建首个管理员', exact: true }).waitFor()
 await page.getByLabel('平台语言', { exact: true }).selectOption('en')
 await page.getByRole('heading', { name: 'Create the first administrator', exact: true }).waitFor()
 await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
 await page.getByRole('button', { name: 'Create administrator', exact: true }).click(); await page.waitForURL(`${origin}/admin`)
 await context.unroute('**/admin/assets/**'); await page.reload()
 await page.getByRole('heading', { name: 'Account management', exact: true }).waitFor()
 await page.getByRole('button', { name: /Platform language/ }).click(); await page.getByRole('option', { name: '简体中文', exact: true }).click()
 await page.getByRole('navigation', { name: '管理导航', exact: true }).waitFor()
 expect(await page.locator('html').getAttribute('lang')).toBe('zh-CN')
 await page.reload(); await page.getByRole('link', { name: '系统设置', exact: true }).click()
 await page.getByRole('heading', { name: '系统设置', exact: true }).waitFor()
 expect((await context.cookies()).find(cookie => cookie.name === 'dsh-phalanx.lang')?.value).toBe('zh-CN')
 await context.route('**/admin/assets/**', route => route.abort())
 await page.goto(`${origin}/recovery`)
 await page.getByRole('heading', { name: '实例恢复', exact: true }).waitFor()
 await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '重启实例', exact: true }).click()
 await page.getByRole('status').filter({ hasText: '重启失败。' }).waitFor()
 expect(await page.locator('script[src]').count()).toBe(0)
 await page.getByRole('button', { name: '退出登录', exact: true }).click(); await page.waitForURL(`${origin}/login`)
 await page.getByRole('heading', { name: '登录 dsh-phalanx', exact: true }).waitFor()
 await page.getByLabel('平台语言', { exact: true }).selectOption('system')
 await page.getByRole('heading', { name: '登录 dsh-phalanx', exact: true }).waitFor()
 expect((await context.cookies()).find(cookie => cookie.name === 'dsh-phalanx.lang')?.value).toBe('system')
})
