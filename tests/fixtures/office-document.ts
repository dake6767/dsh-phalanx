import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { chromium } from 'playwright'
import { expect } from 'vitest'
import { effectiveUserDataRoot } from '../../src/domain/storage-layout.js'
import { defaultWorkspacePath, instanceWorkspacePath } from '../support/real-dsh-runtime.js'
import { selectCommunityWorkspace, signInCommunity, startCommunitySession } from './community-native-browser.js'
import inputs from './office-inputs.json' with { type: 'json' }
import { until, type OfficeFactsInput, type OfficeSession } from './office-session.js'
import { skillZip } from './skills/archive.js'

/** Observes the published plugin and the SDK's public message seam, without changing either. */
export async function probeOfficeDocument(
  input: OfficeFactsInput,
  session: OfficeSession,
  record: (name: string, value: unknown) => Promise<void>,
): Promise<void> {
  const packageName = '@dake6767/dsh-onlyoffice'
  const installed = (await session.api('plugins')).find((row: { packageName: string }) => row.packageName === packageName)
  if (!installed) await session.api('plugins', { action: 'add', packageName, version: input.onlyofficeVersion })
  const plugin = await until(
    async () => (await session.api('plugins')).find((row: { packageName: string }) => row.packageName === packageName),
    row => row?.stage === 'available' || row?.stage === 'failed',
    300_000,
  )
  await record('office-plugin', plugin)
  assert(
    plugin.stage === 'available' && plugin.version === input.onlyofficeVersion && plugin.integrity === input.onlyofficeIntegrity,
    'Published plugin preparation or exact integrity check failed',
  )
  await session.api('plugins/publication', { action: 'publish', packageName, published: true })
  const login = await session.login('member')
  assert(login.status === 303, 'Member login failed before plugin installation')
  const cookie = login.headers
    .getSetCookie()
    .map(value => value.split(';')[0])
    .join('; ')
  const request = (path: string, data?: object) => session.request(path, cookie, data)
  const state = () => request('/market/api/plugins')
  if (!(await state()).plugins.some((row: { packageName: string; status: string }) => row.packageName === packageName && row.status === 'installed')) {
    const requestId = 'office-facts-install'
    await request('/market/api/plugins', { action: 'install', packageName, requestId })
    const result = await until(
      state,
      data =>
        data.plugins.some(
          (row: { packageName: string; job?: { requestId: string; status: string } }) =>
            row.packageName === packageName && row.job?.requestId === requestId && row.job.status !== 'running',
        ),
      300_000,
    )
    assert(
      result.plugins.find((row: { packageName: string }) => row.packageName === packageName)?.job.status === 'succeeded',
      'Native plugin installation failed',
    )
  }
  if ((await state()).pending) await request('/recovery/restart', { confirmed: true })

  const cache = join(effectiveUserDataRoot({ dataRoot: session.root }), 'member/home/.dsh/onlyoffice-sdk'),
    sdk = join(cache, '9.4.0-develop')
  assert(!relative(input.root, input.sdkRoot).startsWith('..'), 'SDK must be in the owned probe root')
  try {
    await lstat(sdk)
  } catch (error) {
    assert((error as NodeJS.ErrnoException).code === 'ENOENT')
    await mkdir(cache, { recursive: true, mode: 0o700 })
    await rename(input.sdkRoot, sdk)
  }
  const manifestBytes = await readFile(input.sdkManifest)
  assert(createHash('sha256').update(manifestBytes).digest('hex') === inputs.onlyofficeSdk.fileManifestSha256, 'SDK identity manifest checksum mismatch')
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { path: string; bytes: number; sha256: string }[]
  assert(manifest.length === 19629, 'Unexpected locked SDK file manifest')
  for (const file of manifest) {
    assert(file.path !== '' && !file.path.startsWith('/') && !file.path.split('/').includes('..'), 'Unsafe SDK manifest path')
    const path = join(sdk, file.path),
      info = await lstat(path)
    assert(info.isFile() && !info.isSymbolicLink() && info.size === file.bytes, 'SDK file identity mismatch: ' + file.path)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    assert(hash.digest('hex') === file.sha256, 'SDK file checksum mismatch: ' + file.path)
  }
  const apiJs = join(sdk, 'web-apps/apps/api/documents/api.js')
  assert((await readFile(apiJs, 'utf8')).includes('onDocumentReady'), 'Missing real SDK document API')
  const workspace = defaultWorkspacePath(session.root, 'member')
  await mkdir(workspace, { recursive: true })
  await writeFile(
    join(workspace, 'office-facts.docx'),
    skillZip([
      {
        path: '[Content_Types].xml',
        content:
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      },
      {
        path: '_rels/.rels',
        content:
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      },
      {
        path: 'word/document.xml',
        content:
          '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Office facts probe</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>',
      },
    ]),
  )
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ locale: 'en', viewport: { width: 1600, height: 1000 } })
  const responses: { path: string; status: number }[] = []
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname.includes('onlyoffice')) responses.push({ path: url.pathname, status: response.status() })
  })
  let phase = 'login'
  try {
    await page.addInitScript(() => {
      const host = window as unknown as { officeReady: { instanceId: string; origin: string; at: number }[] }
      host.officeReady = []
      window.addEventListener('message', event => {
        let data = event.data
        try {
          if (typeof data === 'string') data = JSON.parse(data)
        } catch {
          return
        }
        if (data?.event !== 'onDocumentReady') return
        const frame = [...document.querySelectorAll<HTMLIFrameElement>('iframe[name="frameEditor"]')].find(frame => frame.contentWindow === event.source)
        if (!frame) return
        const instanceId = new URL(frame.src, location.href).searchParams.get('frameEditorId')
        if (!instanceId || instanceId !== data.frameEditorId) return
        host.officeReady.push({ instanceId, origin: event.origin, at: Date.now() })
      })
    })
    await signInCommunity(page, session.origin, 'member', 'office-facts-fixture-password')
    await selectCommunityWorkspace(page.context(), page, session.origin, instanceWorkspacePath(workspace, true), true)
    await startCommunitySession(page)
    phase = 'files'
    const expand = page.locator('[data-sidebar-right-expand]')
    if (await expand.isVisible()) await expand.click()
    await page.locator('[data-sidebar-right-guide-entry="files"]').click()
    await page.locator('[data-files-state="tree"]').waitFor()
    await page.locator('[data-files-entry="file"]').filter({ hasText: 'office-facts.docx' }).getByRole('button').click()
    phase = 'renderer'
    const renderer = page.locator('[data-document-preview="dsh-onlyoffice:document"]')
    if ((await renderer.count()) === 0) {
      await page.locator('[data-document-viewer-menu]').click()
      await page.getByRole('menuitem', { name: 'OnlyOffice document', exact: true }).click()
    }
    await renderer.waitFor()
    await page.getByRole('toolbar', { name: 'OnlyOffice', exact: true }).waitFor()
    phase = 'document-ready'
    const wrapper = renderer.locator('.onlyoffice-container[data-onlyoffice-container-id]')
    const instanceId = await wrapper.getAttribute('data-onlyoffice-container-id')
    assert(instanceId, 'Missing current OnlyOffice editor identity')
    await expect
      .poll(
        () => page.evaluate(id => (window as unknown as { officeReady: { instanceId: string }[] }).officeReady.some(row => row.instanceId === id), instanceId),
        { timeout: 180_000 },
      )
      .toBe(true)
    await expect.poll(() => renderer.locator('.dshoo-state').count()).toBe(0)
    await expect.poll(() => renderer.locator('.dshoo-notice').count()).toBe(0)
    await page.screenshot({ path: join(input.root, 'results/onlyoffice-document.png'), fullPage: true })
    await wrapper.screenshot({ path: join(input.root, 'results/onlyoffice-editor.png') })
    const ready = await page.evaluate(() => (window as unknown as { officeReady: unknown[] }).officeReady)
    await record('onlyoffice-document', {
      status: 'automatic-ready-passed',
      packageName,
      version: plugin.version,
      integrity: plugin.integrity,
      sdkSource: 'locked archive preseeded into this member writable cache; shared fallback not implemented',
      verifiedSdkFiles: manifest.length,
      instanceId,
      ready,
      responses,
      rendererId: 'dsh-onlyoffice:document',
      screenshotRequiresVisualInspection: true,
    })
  } catch (error) {
    await page.screenshot({ path: join(input.root, 'results/onlyoffice-failed.png'), fullPage: true }).catch(() => undefined)
    await record('onlyoffice-document', { status: 'failed', phase, responses, message: error instanceof Error ? error.message : String(error) })
    throw error
  } finally {
    await browser.close()
  }
}
