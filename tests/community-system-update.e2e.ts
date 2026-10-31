// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunitySystemUpdateCheck, CommunitySystemUpdateEvent, CommunitySystemUpdateOperation } from '../src/domain/admin-contract.js'
import { BusinessRuleError } from '../src/domain/business-error.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { CommunitySystemUpdateUnavailableError, type CommunitySystemUpdatePort } from '../src/ports/community-system-update.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'

let app: CommunityApplication | undefined
let browser: Browser | undefined
let root: string | undefined
afterEach(async () => {
  await browser?.close()
  await app?.stop()
  if (root) await removeCommunityFixture(root)
})
it('prepares manually, cancels without applying and reconnects to the accepted operation after a lost response and refresh', async () => {
  let operation: CommunitySystemUpdateOperation | null = null
  let events: CommunitySystemUpdateEvent[] = []
  let blockStatus = false
  let unavailable = false
  let statusEntered!: () => void
  let releaseStatus!: () => void
  let staleError = false
  let statusBlocked = new Promise<void>(resolve => {
    statusEntered = resolve
  })
  let statusReleased = new Promise<void>(resolve => {
    releaseStatus = resolve
  })
  let cleanups = 0
  let checks = 0
  let applies = 0
  let failCheck = false
  let freshInstall = false
  let checkOverride: CommunitySystemUpdateCheck | undefined
  const preparations: { version: string; manifestSha256: string }[] = []
  let submitted!: () => void
  const accepted = new Promise<void>(resolve => {
    submitted = resolve
  })
  const statusCalls: (string | undefined)[] = []
  const port: CommunitySystemUpdatePort = {
    status: async id => {
      statusCalls.push(id)
      if (unavailable) throw new CommunitySystemUpdateUnavailableError('Control unavailable')
      if (blockStatus) {
        blockStatus = false
        statusEntered()
        await statusReleased
        if (staleError) {
          staleError = false
          throw new BusinessRuleError('missing', 'Old operation unavailable', 'update-request-refused')
        }
        return { currentVersion: 'v0.1.2', runningVersion: 'v0.1.2', operation: null, events: [] }
      }
      return { currentVersion: 'v0.1.2', runningVersion: 'v0.1.2', operation, events }
    },
    check: async () => {
      checks++
      return {
        currentVersion: 'v0.1.2',
        runningVersion: 'v0.1.2',
        operation,
        events,
        check:
          checkOverride ??
          (freshInstall
            ? {
                status: 'incompatible',
                freshInstallRequired: true,
                checkedAt: '2026-10-05T00:00:00Z',
                version: 'v0.1.25',
                manifestSha256: 'd'.repeat(64),
                reason: 'Fresh installation required.',
                releaseNotes: 'Fresh installation required.',
              }
            : failCheck
              ? { status: 'failed', checkedAt: '2026-10-05T00:00:00Z', reason: 'Release source unavailable' }
              : {
                  status: 'available',
                  checkedAt: '2026-10-05T00:00:00Z',
                  version: 'v0.1.3',
                  manifestSha256: 'a'.repeat(64),
                  releaseNotes: '<script>untrusted()</script>\nUpdate notes.',
                }),
      }
    },
    prepare: async (version, manifestSha256) => {
      preparations.push({ version, manifestSha256 })
      operation = {
        id: '12345678-1234-1234-1234-123456789abc',
        phase: 'prepared',
        targetVersion: version,
        sourceVersion: 'v0.1.2',
        targetCommit: 'b'.repeat(40),
        platformSha256: 'a'.repeat(64),
        imageDigest: `sha256:${'c'.repeat(64)}`,
      }
      return { operation }
    },
    cleanup: async id => {
      expect(id).toBe(operation!.id)
      cleanups++
      operation = { ...operation!, cleanup: { ...operation!.cleanup!, status: 'running' } }
      return { operation }
    },
    apply: async () => {
      applies++
      operation = { ...operation!, phase: 'stopping' }
      submitted()
      throw new CommunitySystemUpdateUnavailableError('Connection lost after acceptance')
    },
  }
  root = await mkdtemp(join(tmpdir(), 'system-update-browser-'))
  app = createCommunityApplication(
    {
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'system-update-browser-fixture-32-bytes',
      runtime: {
        command: '/unavailable-dsh',
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } },
      },
    },
    { systemUpdate: port },
  )
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
  await page.getByRole('link', { name: 'System settings', exact: true }).click()
  let panel = page.getByRole('region', { name: 'System update', exact: true })
  await panel.getByText('Running version: v0.1.2', { exact: true }).waitFor()
  await panel.getByRole('heading', { name: 'Update available', exact: true }).waitFor()
  expect(checks).toBe(1)
  await panel.getByRole('button', { name: 'Update to latest version', exact: true }).waitFor()
  expect(await panel.locator('script').count()).toBe(0)
  expect(await panel.locator('pre').textContent()).toContain('<script>untrusted()</script>')
  checkOverride = {
    status: 'incompatible',
    outcomeCode: 'update.breakpoint-required',
    requiredVersion: '0.1.4',
    checkedAt: '2026-10-05T00:00:00Z',
    version: 'v0.1.9',
    manifestSha256: '9'.repeat(64),
    releaseNotes: 'Intermediate version required.',
  }
  await panel.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await panel.getByRole('heading', { name: 'Update to the required intermediate version first', exact: true }).waitFor()
  const intermediate = panel.getByRole('button', { name: 'Update to v0.1.4', exact: true })
  expect(await intermediate.isDisabled()).toBe(true)
  checkOverride = { ...checkOverride, versions: [{ status: 'available', version: 'v0.1.4', manifestSha256: '4'.repeat(64) }] }
  await panel.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await intermediate.click()
  expect(preparations.at(-1)).toEqual({ version: 'v0.1.4', manifestSha256: '4'.repeat(64) })
  expect(await panel.getByRole('combobox').count()).toBe(0)
  operation = null
  checkOverride = undefined
  await page.reload()
  freshInstall = true
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await panel.getByText('This version requires a fresh installation.', { exact: true }).waitFor()
  expect(await panel.getByRole('button', { name: 'Update to latest version', exact: true }).count()).toBe(0)
  expect(await panel.getByRole('link', { name: 'Fresh installation instructions', exact: true }).getAttribute('href')).toContain(
    '/docs/install.md#recoverable-system-updates',
  )
  await context.addCookies([{ name: 'dsh-phalanx.lang', value: 'zh-CN', url: origin }])
  await page.reload()
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await page.getByText('此版本需要全新安装。', { exact: true }).waitFor()
  expect(await page.getByRole('link', { name: '全新安装指引', exact: true }).getAttribute('href')).toContain(
    '/docs/install.zh-CN.md#recoverable-system-updates',
  )
  await context.addCookies([{ name: 'dsh-phalanx.lang', value: 'en', url: origin }])
  await page.reload()
  freshInstall = false
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await panel.getByText('Formal update available: v0.1.3', { exact: true }).waitFor()
  blockStatus = true
  await statusBlocked
  await panel.getByRole('button', { name: 'Update to latest version', exact: true }).click()
  await panel.getByText('Ready to apply', { exact: true }).waitFor()
  expect(await panel.getByRole('button', { name: 'Update to latest version', exact: true }).count()).toBe(0)
  expect(await panel.getByRole('heading', { name: 'Update available', exact: true }).count()).toBe(0)
  await panel.getByRole('button', { name: 'Apply update', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Apply update: v0.1.3', exact: true })
  expect(await dialog.textContent()).toMatch(/all running tasks.*unsaved/iu)
  await dialog.getByText('Estimated downtime: usually a few minutes.', { exact: true }).waitFor()
  expect(await dialog.textContent()).toContain('The update does not back up member files.')
  expect(await dialog.getByRole('link', { name: 'User data backup instructions' }).getAttribute('href')).toContain(
    '/docs/install.md#consistent-backup-and-whole-host-migration',
  )
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(applies).toBe(0)
  const staleResponse = page.waitForResponse(response => response.url().includes('/admin/api/system-update') && response.request().method() === 'GET')
  releaseStatus()
  await staleResponse
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  statusCalls.length = 0
  await page.reload()
  await panel.getByText('Ready to apply', { exact: true }).waitFor()
  expect(statusCalls[0]).toBe('12345678-1234-1234-1234-123456789abc')
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await panel.getByText('Ready to apply', { exact: true }).waitFor()
  expect(await panel.getByRole('button', { name: 'Update to latest version', exact: true }).count()).toBe(0)
  await panel.getByRole('button', { name: 'Apply update', exact: true }).click()
  unavailable = true
  await panel.getByText(/Reconnecting to the original update/u).waitFor()
  await panel.getByText('Running version: Unknown while reconnecting.', { exact: true }).waitFor()
  expect(await panel.getByText('Last verified running version: v0.1.2', { exact: true }).count()).toBe(1)
  expect(await panel.getByRole('button', { name: 'Apply update', exact: true }).isDisabled()).toBe(true)
  expect(await panel.getByRole('button', { name: 'Update to latest version', exact: true }).count()).toBe(0)
  expect(await dialog.getByRole('button', { name: 'Confirm and apply now', exact: true }).isDisabled()).toBe(true)
  expect(await panel.getByRole('link', { name: 'server recovery instructions', exact: true }).count()).toBe(1)
  unavailable = false
  await panel.getByText('Running version: v0.1.2', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Confirm and apply now', exact: true }).click()
  await accepted
  await panel.getByText(/Reconnecting to the original update/u).waitFor()
  operation = {
    ...operation!,
    phase: 'restored',
    failure: 'Target failed readiness',
    errorCode: 'migration.failed',
    timing: { phaseSeconds: { stopping: 2, 'backing-up': 4, validating: 6, restoring: 3 }, phaseElapsedSeconds: 0, downtimeSeconds: 15, downtimeActive: false },
  }
  await panel.getByText('Update failed; the previous version was restored', { exact: true }).waitFor()
  await panel.getByText('Update failure: The platform database migration failed', { exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Check for updates and retry', exact: true }).click()
  await panel.getByRole('button', { name: 'Update to latest version', exact: true }).waitFor()
  expect(applies).toBe(1)
  await page.reload()
  await panel.getByText('Total downtime: 15s', { exact: true }).waitFor()
  await panel.getByText('Backing up platform data: 4s', { exact: true }).waitFor()
  await page.reload()
  await panel.getByText('Update failed; the previous version was restored', { exact: true }).waitFor()
  expect(applies).toBe(1)
  expect(statusCalls).toContain(operation.id)
  expect(await panel.textContent()).toContain('Running version: v0.1.2')
  operation = {
    ...operation!,
    phase: 'prepare-failed',
    space: {
      sufficient: false,
      backupBytes: 4096,
      locations: [
        {
          paths: ['/var/cache/example'],
          purposes: ['download cache'],
          availableBytes: 100 * 1024 ** 2,
          requiredBytes: 200 * 1024 ** 2,
          shortfallBytes: 100 * 1024 ** 2,
        },
      ],
    },
  }
  const capacity = panel.getByRole('region', { name: 'Disk capacity', exact: true })
  await capacity.getByText('Insufficient space. The running service has not been stopped.', { exact: true }).waitFor()
  await capacity.getByText('Required: 200 MB · Available: 100 MB · Shortfall: 100 MB', { exact: true }).waitFor()
  expect(await panel.getByText('Backups are retained', { exact: false }).count()).toBe(0)
  await page.reload()
  await capacity.getByText('/var/cache/example', { exact: true }).waitFor()
  expect(await panel.getByRole('button', { name: 'Apply update', exact: true }).count()).toBe(0)
  failCheck = true
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await panel.getByText('Update availability unknown: Release source unavailable', { exact: true }).waitFor()
  expect(await panel.getByText('Formal update available: v0.1.3', { exact: true }).count()).toBe(0)
  operation = { ...operation!, phase: 'preparing' }
  events = [
    {
      phase: 'Upgrade preparation',
      status: 'running',
      action: 'Downloading platform',
      message: 'Still working; waiting for this step to finish',
      bytes: 400,
      total: 1000,
      phaseElapsed: 8,
      elapsed: 12,
    },
  ]
  await panel.getByText('Downloading platform', { exact: true }).waitFor()
  await panel.getByRole('progressbar', { name: 'Download progress' }).waitFor()
  expect(await panel.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40')
  await panel.getByText('Phase elapsed: 8s · Total elapsed: 12s', { exact: true }).waitFor()
  const diagnostics = panel.getByRole('button', { name: 'Update diagnostics', exact: true })
  expect(await diagnostics.getAttribute('aria-expanded')).toBe('false')
  await diagnostics.click()
  expect(await diagnostics.getAttribute('aria-expanded')).toBe('true')
  await panel.getByText(`Operation: ${operation.id}`, { exact: true }).waitFor()
  await diagnostics.click()
  expect(await diagnostics.getAttribute('aria-expanded')).toBe('false')
  events = [
    {
      phase: 'Upgrade preparation',
      status: 'running',
      action: 'Pulling instance image',
      message: 'Still working',
      bytes: 5 * 1024 ** 2,
      phaseElapsed: 10,
      elapsed: 14,
    },
  ]
  await panel.getByText('Pulling instance image', { exact: true }).waitFor()
  expect(await panel.getByRole('progressbar', { name: 'Download progress' }).getAttribute('aria-valuenow')).toBeNull()
  await panel.getByText('5 MB received', { exact: true }).waitFor()
  for (const [phase, message] of [
    ['stopping', 'Step 1/6 · Stopping the service and user instances'],
    ['backing-up', 'Step 2/6 · Backing up platform data'],
    ['backed-up', 'Step 3/6 · Platform backup verified'],
    ['switching', 'Step 4/6 · Switching to the verified version'],
    ['validating', 'Step 5/6 · Checking the new service'],
    ['committed', 'Step 6/6 · Update verified; reopening the service'],
    ['restoring', 'Step 1/2 · Restoring the previous version'],
    ['restoration-committed', 'Step 2/2 · Previous version verified; reopening the service'],
  ] as const) {
    operation = { ...operation!, phase, timing: { phaseSeconds: {}, phaseElapsedSeconds: 8, downtimeSeconds: 12, downtimeActive: true } }
    await panel.getByRole('heading', { name: message, exact: true }).waitFor()
    await panel.getByText('Downtime so far: 12s', { exact: true }).waitFor()
    await panel.getByRole('progressbar', { name: 'Upgrade progress' }).waitFor()
  }
  for (const [phase, message] of [
    ['prepare-failed', 'Download or verification failed'],
    ['recovery-failed', 'Recovery failed; operator action is required'],
    ['succeeded', 'Update completed successfully'],
  ] as const) {
    const { failure: _failure, recoveryFailure: _recoveryFailure, instruction: _instruction, ...identity } = operation!
    operation = {
      ...identity,
      phase,
      timing: {
        phaseSeconds: { stopping: 2, 'backing-up': 4, validating: 6, restoring: 3 },
        phaseElapsedSeconds: 0,
        downtimeSeconds: 15,
        downtimeActive: false,
      },
      ...(phase === 'succeeded' ? {} : { failure: 'Fixture update failure' }),
      ...(phase === 'recovery-failed'
        ? { recoveryFailure: 'Fixture restoration failure', instruction: 'Run the current installer recovery command on the server.' }
        : {}),
    }
    void _failure
    void _recoveryFailure
    void _instruction
    events = []
    await panel.getByText(message, { exact: true }).waitFor()
    if (phase === 'recovery-failed') {
      expect(await panel.getByRole('button', { name: 'Check for updates', exact: true }).isDisabled()).toBe(true)
      expect(await panel.getByRole('link', { name: 'Open recovery instructions', exact: true }).getAttribute('href')).toContain(
        '/docs/install.md#recoverable-system-updates',
      )
      await panel.getByText('Recovery failure: Fixture restoration failure', { exact: true }).waitFor()
      await panel.getByText('Run the current installer recovery command on the server.', { exact: true }).waitFor()
    }
  }
  operation = {
    ...operation!,
    phase: 'succeeded',
    cleanup: {
      status: 'failed',
      reclaimedBytes: 4096,
      items: [
        {
          kind: 'program',
          name: '/opt/dsh-phalanx/releases/previous',
          status: 'retained',
          reason: 'most recent successful previous version',
          reclaimedBytes: 0,
        },
        { kind: 'image', name: 'a'.repeat(64), status: 'failed', reason: 'Storage busy', reclaimedBytes: 0 },
      ],
    },
  }
  await panel.getByText('Update succeeded; some resources still need cleanup.', { exact: true }).waitFor()
  await panel.getByText('Space reclaimed: 0.004 MB', { exact: true }).waitFor()
  expect(await panel.getByRole('button', { name: 'Installation resource cleanup', exact: true }).getAttribute('aria-expanded')).toBe('true')
  await panel.getByText('most recent successful previous version', { exact: false }).waitFor()
  await panel.getByRole('button', { name: 'Retry cleanup', exact: true }).click()
  await expect.poll(() => panel.getByRole('button', { name: 'Installation resource cleanup', exact: true }).getAttribute('aria-expanded')).toBe('false')
  await panel.getByRole('button', { name: 'Installation resource cleanup', exact: true }).click()
  await panel.getByText('Cleaning unused installation resources…', { exact: true }).waitFor()
  expect(await panel.getByRole('button', { name: 'Retry cleanup', exact: true }).isDisabled()).toBe(true)
  expect(await panel.getByRole('button', { name: 'Update to latest version', exact: true }).count()).toBe(0)
  expect(cleanups).toBe(1)
  expect(applies).toBe(1)
  operation = { ...operation!, cleanup: { ...operation!.cleanup!, status: 'succeeded', reclaimedBytes: 8192 } }
  await panel.getByText('Unused installation resources cleaned.', { exact: true }).waitFor()
  await panel.getByText('Space reclaimed: 0.008 MB', { exact: true }).waitFor()
  const completed = operation!
  for (const locale of ['en', 'zh-CN'] as const) {
    operation = null
    checkOverride = undefined
    await context.addCookies([{ name: 'dsh-phalanx.lang', value: locale, url: origin }])
    panel = page.getByRole('region', { name: locale === 'en' ? 'System update' : '系统升级', exact: true })
    await page.reload()
    const checkButton = panel.getByRole('button', { name: locale === 'en' ? 'Check for updates' : '检查更新', exact: true })
    for (const [code, status, english, chinese, action] of [
      ['update.current', 'current', 'Already up to date', '已是最新版本', undefined],
      ['update.below-floor', 'incompatible', 'The installed version is below the upgrade floor', '当前版本低于升级下限', undefined],
      [
        'update.channel-switch',
        'available',
        'A formal release is available for this candidate',
        '此候选版可以转为正式版',
        locale === 'en' ? 'Switch to formal v0.1.9' : '转为正式版 v0.1.9',
      ],
    ] as const) {
      checkOverride = {
        status,
        outcomeCode: code,
        checkedAt: '2026-10-05T00:00:00Z',
        version: 'v0.1.9',
        manifestSha256: '9'.repeat(64),
        releaseNotes: 'Verified formal notes.',
      }
      await checkButton.click()
      await panel.getByRole('heading', { name: locale === 'en' ? english : chinese, exact: true }).waitFor()
      if (action) {
        await panel.getByRole('button', { name: action, exact: true }).click()
        expect(preparations.at(-1)).toEqual({ version: 'v0.1.9', manifestSha256: '9'.repeat(64) })
        operation = null
        await page.reload()
      }
      expect(await panel.getByRole('combobox').count()).toBe(0)
    }
    checkOverride = {
      status: 'available',
      outcomeCode: 'update.available',
      checkedAt: '2026-10-05T00:00:00Z',
      version: 'run-202',
      targetVersion: '0.1.28',
      manifestSha256: '2'.repeat(64),
      releaseNotes: 'Verified candidate notes.',
    }
    await checkButton.click()
    await panel.getByRole('button', { name: locale === 'en' ? 'Update to latest version' : '更新到最新版本', exact: true }).click()
    expect(preparations.at(-1)).toEqual({ version: 'run-202', manifestSha256: '2'.repeat(64) })
    operation = null
    await page.reload()
    checkOverride = {
      status: 'failed',
      outcomeCode: 'update.reader-update-required',
      requiredVersion: '0.1.28',
      checkedAt: '2026-10-05T00:00:00Z',
      reason: 'The small executor must be updated first.',
    }
    await checkButton.click()
    await panel.getByRole('heading', { name: locale === 'en' ? 'Update the small executor first' : '需要先更新小执行器', exact: true }).waitFor()
  }
  checkOverride = {
    status: 'failed',
    checkedAt: '2026-10-05T00:00:00Z',
    reason: 'Opaque check failure',
    errorCode: 'future.vendor-failure',
    diagnosticLog: '/var/log/dsh-phalanx/20261005T000000-12345678.jsonl',
  }
  operation = null
  await panel.getByRole('button', { name: '检查更新', exact: true }).click()
  await panel.getByText('升级失败：Opaque check failure', { exact: true }).waitFor()
  await panel.getByText('诊断日志：/var/log/dsh-phalanx/20261005T000000-12345678.jsonl', { exact: true }).waitFor()
  checkOverride = undefined
  operation = {
    ...completed,
    phase: 'prepare-failed',
    failure: 'Opaque future vendor failure',
    errorCode: 'future.vendor-failure',
    diagnosticLog: '/var/log/dsh-phalanx/20261005T000000-12345678.jsonl',
  }
  await page.reload()
  await panel.getByText('升级失败：Opaque future vendor failure', { exact: true }).waitFor()
  await panel.getByText('发生未分类的升级错误，请查看诊断日志并联系管理员。', { exact: true }).waitFor()
  await panel.getByText('诊断日志：/var/log/dsh-phalanx/20261005T000000-12345678.jsonl', { exact: true }).filter({ visible: true }).waitFor()
  expect(await panel.getByRole('button', { name: '升级诊断', exact: true }).getAttribute('aria-expanded')).toBe('false')
  operation = {
    ...operation,
    phase: 'restored',
    errorCode: 'migration.failed',
    recoveryFailure: 'Opaque restoration failure',
    recoveryErrorCode: 'database.restore-failed',
  }
  await page.reload()
  await panel.getByRole('heading', { name: '升级失败，已恢复旧版本', exact: true }).waitFor()
  await panel.getByText('升级失败：平台数据库迁移失败', { exact: true }).waitFor()
  await panel.getByText('恢复失败：平台数据库恢复失败', { exact: true }).waitFor()
  expect(await panel.getByText('升级失败：Opaque future vendor failure', { exact: true }).count()).toBe(0)
  operation = { ...completed, phase: 'validating', timing: { phaseSeconds: {}, phaseElapsedSeconds: 8, downtimeSeconds: 12, downtimeActive: true } }
  await page.reload()
  await panel.getByRole('heading', { name: '第 5/6 步 · 检查新版本服务', exact: true }).waitFor()
  await panel.getByText('已停机：12 秒', { exact: true }).waitFor()
  operation = { ...completed, phase: 'prepared', previousDowntimeSeconds: 42 }
  await page.reload()
  await panel.getByRole('button', { name: '应用升级', exact: true }).click()
  const chineseDialog = page.getByRole('alertdialog', { name: '应用升级：v0.1.3', exact: true })
  await chineseDialog.getByText('预计停机：42 秒（上次升级实际值）。', { exact: true }).waitFor()
  expect(await chineseDialog.textContent()).toContain('升级不备份成员文件')
  expect(await chineseDialog.getByRole('link', { name: '用户数据备份方法' }).getAttribute('href')).toContain('/docs/install.zh-CN.md#一致备份与整机迁移')
  await chineseDialog.getByRole('button', { name: '取消', exact: true }).click()
  operation = completed
  panel = page.getByRole('region', { name: 'System update', exact: true })
  await context.addCookies([{ name: 'dsh-phalanx.lang', value: 'en', url: origin }])
  await page.reload()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => localStorage.setItem('dsh-phalanx.appearance.v1', 'dark'))
  await page.reload()
  await panel.getByText('Update completed successfully', { exact: true }).waitFor()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  statusBlocked = new Promise<void>(resolve => {
    statusEntered = resolve
  })
  statusReleased = new Promise<void>(resolve => {
    releaseStatus = resolve
  })
  staleError = true
  blockStatus = true
  await statusBlocked
  failCheck = false
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await panel.getByText('Formal update available: v0.1.3', { exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Update to latest version', exact: true }).click()
  await panel.getByText('Ready to apply', { exact: true }).waitFor()
  const oldError = page.waitForResponse(response => response.url().includes('/admin/api/system-update') && response.status() === 404)
  releaseStatus()
  await oldError
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await panel.getByText('Old operation unavailable', { exact: true }).count()).toBe(0)
  await panel.getByText('Ready to apply', { exact: true }).waitFor()
  expect(
    (
      await context.request.post(`${origin}/admin/api/accounts`, {
        headers: { origin },
        data: { username: 'other-admin', email: 'other@example.test', password: 'password' },
      })
    ).status(),
  ).toBe(201)
  expect(
    (
      await context.request.post(`${origin}/admin/api/accounts/other-admin/actions`, { headers: { origin }, data: { action: 'set-admin', admin: true } })
    ).status(),
  ).toBe(200)
  expect(
    (
      await context.request.post(`${origin}/admin/api/accounts/admin/actions`, {
        headers: { origin },
        data: { action: 'set-admin', admin: false, groupId: 'default' },
      })
    ).status(),
  ).toBe(200)
  await panel
    .getByRole('alert')
    .filter({ hasText: /administrator/iu })
    .waitFor()
  expect(await panel.getByText(/Reconnecting to the original update/u).count()).toBe(0)
  expect(await panel.getByText('Update diagnostics', { exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Check for updates', exact: true }).isDisabled()).toBe(true)
})
