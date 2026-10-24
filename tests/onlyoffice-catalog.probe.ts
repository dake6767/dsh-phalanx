// Explicit published-plugin acceptance; excluded from regular credential-free inventories.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { officialSuiteCatalogKeys } from '../src/domain/suite-catalog-keys.js'
import { readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { openOfficeSession, until } from './fixtures/office-session.js'
import { selectCommunityWorkspace, signInCommunity, startCommunitySession } from './fixtures/community-native-browser.js'
import { communityEntryUrl } from './support/community-space.js'
import { defaultWorkspacePath, instanceWorkspacePath } from './support/real-dsh-runtime.js'

const packageName = '@dake6767/dsh-onlyoffice'
const password = 'office-facts-fixture-password'
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')

it('prepares the signed SDK resource and uses its read-only shared tree for two members with native document save', async () => {
  const inputPath = process.env.DSH_PHALANX_ONLYOFFICE_INPUT
  assert(inputPath, 'Pass the private owned acceptance input explicitly')
  const input = JSON.parse(await readFile(inputPath, 'utf8')) as { root: string, runId: string, catalogFile: string, contentHash: string }
  const owner = JSON.parse(await readFile(join(input.root, 'OWNER.json'), 'utf8'))
  assert(owner.runId === input.runId && owner.uid === process.getuid!(), 'Acceptance root ownership mismatch')
  const results = join(input.root, 'results')
  await mkdir(results, { recursive: true })
  const record = async (name: string, value: unknown) => writeFile(join(results, name + '.json'), JSON.stringify(value,
    (_key, item: unknown) => typeof item === 'string' ? item.replace(/(https?:\/\/)[^/\s@"']+@/gu, '$1{credential}@') : item, 2) + '\n')
  const bytes = await readFile(input.catalogFile)
  const catalog = readSuiteCatalog(bytes, { trustedKeys: officialSuiteCatalogKeys, platformVersion: '0.1.24' })
  assert(catalog.status === 'ok', 'Official catalog signature must verify')
  const signed = catalog.entries.find(row => row.entry.id === 'onlyoffice')
  assert(signed?.contentHash === input.contentHash && !signed.unavailableReason, 'Published entry identity mismatch')
  const published = JSON.parse(bytes.toString('utf8')).entries.find((row: { id: string }) => row.id === 'onlyoffice')
  const resource = published.items.find((row: { kind: string, name?: string }) => row.kind === 'runtime-dependency' && row.name === 'onlyoffice-sdk')
  assert(resource?.downloads.length > 0 && resource.downloads.every((row: { target: string }) => row.target.startsWith('sdk/9.4.0-develop/')), 'Expected declared core SDK files')
  const expectedFiles = resource.downloads.map((row: { target: string, sha256: { arm64: string, amd64: string } }) => {
    assert(row.sha256.arm64 === row.sha256.amd64, 'The SDK files must have identical architecture-independent bytes')
    return { path: row.target.slice('sdk/'.length), sha256: row.sha256.arm64 }
  }).sort((a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  assert(new Set(expectedFiles.map((row: { path: string }) => row.path)).size === expectedFiles.length, 'Declared paths must be unique')
  const expectedTree = createHash('sha256')
  for (const row of expectedFiles) { expectedTree.update(row.path + '\0'); expectedTree.update(Buffer.from(row.sha256, 'hex')) }
  const expectedTreeSha256 = expectedTree.digest('hex')
  const expectedPlugin = signed.entry.items.find(item => item.kind === 'plugin')
  assert(expectedPlugin?.kind === 'plugin' && expectedPlugin.packageName === packageName && expectedPlugin.version === '0.1.9', 'Expected exact signed plugin declaration')
  const mirror = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(bytes) })
  await new Promise<void>(resolve => mirror.listen(0, '127.0.0.1', resolve))
  const address = mirror.address(); assert(address && typeof address !== 'string')
  const closeMirror = () => new Promise<void>((resolve, reject) => { mirror.closeAllConnections(); mirror.close(error => error ? reject(error) : resolve()) })
  const session = await openOfficeSession(input, `http://127.0.0.1:${address.port}/catalog.json`, '[dsh-onlyoffice]').catch(async error => { await closeMirror(); throw error })
  let browser: Browser | undefined
  let phase = 'catalog-install'
  try {
    browser = await chromium.launch({ headless: true })
    const admin = await browser.newPage({ locale: 'en' }); admin.setDefaultTimeout(30_000)
    await signInCommunity(admin, session.origin, 'admin', password, true)
    await admin.goto(session.origin + '/admin/plugins?tab=catalog')
    const card = admin.locator('.plugin-library-card').filter({ has: admin.getByRole('button', { name: 'View catalog entry OnlyOffice', exact: true }) })
    const before = (await session.api('suites')).installations.find((row: { id: string }) => row.id === 'onlyoffice')
    const started = Date.now()
    if (before?.status !== 'installed') {
      await card.getByRole('button', { name: 'Install', exact: true }).click()
      await admin.getByRole('dialog', { name: 'OnlyOffice', exact: true }).getByRole('button', { name: 'Install entry', exact: true }).click()
      const installed = await until(() => session.api('suites'), value => value.installations.some((row: { id: string, status: string }) => row.id === 'onlyoffice' && row.status !== 'installing'), 900_000)
      await record('catalog-install', { elapsedMs: Date.now() - started, catalogSha256: sha(bytes), contentHash: input.contentHash, state: installed })
      assert(installed.installations.find((row: { id: string }) => row.id === 'onlyoffice')?.status === 'installed', 'SDK preparation or plugin installation failed')
    }
    const plugin = await until(async () => (await session.api('plugins')).find((row: { packageName: string }) => row.packageName === packageName),
      row => row?.stage === 'available' || row?.stage === 'failed', 300_000)
    assert(plugin?.stage === 'available' && plugin.version === expectedPlugin.version && plugin.integrity === expectedPlugin.integrity, 'Exact published plugin must be available')
    await session.api('plugins/publication', { action: 'publish', packageName, published: true })
    const grantPath = `groups/${session.group.id}/plugins`, grant = await session.api(grantPath)
    await session.api(grantPath, { action: 'save', packages: [], preinstalls: [], revision: grant.revision })
    const accounts = await session.api('accounts')
    if (!accounts.items.some((row: { username: string }) => row.username === 'member-b')) {
      await session.api('accounts', { username: 'member-b', email: '', password, groupId: session.group.id })
    }
    const observer = await readFile(join(session.root, 'users/member/home/observer.mjs'))
    await mkdir(join(session.root, 'users/member-b/home'), { recursive: true })
    await writeFile(join(session.root, 'users/member-b/home/observer.mjs'), observer)
    await admin.close()
    const sharedIdentities: string[] = []
    const hostReaders = new Map<string, () => { stdout: string, stderr: string }>()
    const sharedChecks: { username: string, check: () => Promise<void> }[] = []
    for (const username of ['member', 'member-b']) {
      phase = username + '-install'
      const login = await session.login(username); assert(login.status === 303)
      const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      const request = (path: string, body?: object) => session.request(path, cookie, body)
      const market = () => request('/market/api/plugins')
      if (!(await market()).plugins.some((row: { packageName: string, status: string }) => row.packageName === packageName && row.status === 'installed')) {
        const requestId = input.runId + '-' + username
        await request('/market/api/plugins', { action: 'install', packageName, requestId })
        const settled = await until(market, value => value.plugins.some((row: { packageName: string, job?: { requestId: string, status: string } }) => row.packageName === packageName && row.job?.requestId === requestId && row.job.status !== 'running'), 300_000)
        assert(settled.plugins.find((row: { packageName: string }) => row.packageName === packageName)?.job.status === 'succeeded')
      }
      await request('/recovery/restart', { confirmed: true })
      const workspace = defaultWorkspacePath(session.root, username)
      await mkdir(workspace, { recursive: true })
      for (const extension of ['docx', 'xlsx', 'pptx']) {
        await writeFile(join(workspace, 'shared-editor.' + extension), await readFile(join(input.root, 'documents/audit.' + extension)))
      }
      const cache = join(session.root, 'users', username, 'home/.dsh/onlyoffice-sdk')
      const cacheFiles = async () => {
        try { return (await readdir(cache, { recursive: true })).filter(path => !path.startsWith('.')) } catch (error) { assert((error as NodeJS.ErrnoException).code === 'ENOENT'); return [] }
      }
      assert.deepEqual(await cacheFiles(), [], 'First open must start with an empty member SDK cache')
      const cli = process.env.DSH_PHALANX_CONTAINER_RUNTIME ?? 'podman'
      const hosts = execFileSync(cli, ['ps', '--filter', 'label=dsh-phalanx.community-root=' + sha(Buffer.from(session.root)), '--filter', 'label=dsh-phalanx.user=' + username, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
      assert(hosts.length === 1, 'Identify exactly this member Host')
      const sharedPath = execFileSync(cli, ['exec', hosts[0]!, 'node', '-e', 'process.stdout.write(process.env.DSH_ONLYOFFICE_SHARED_CACHE_DIR ?? "")'], { encoding: 'utf8' }).trim()
      await record(username + '-host-shared-env', { sharedPath }); assert(sharedPath.startsWith('/dsh-phalanx/'), 'Actual Host must receive the dependency environment')
      // Tool environments are filtered; use the path independently observed in this Host.
      const probe = 'const fs=require("node:fs"),p=process.argv[1]; if(!p)process.exit(2); const f=p+"/9.4.0-develop/web-apps/apps/api/documents/api.js"; if(!fs.statSync(f).isFile())process.exit(3); let blocked=false; try{fs.writeFileSync(p+"/member-write-probe","forbidden")}catch(e){blocked=e.code==="EROFS"||e.code==="EACCES"} if(!blocked)process.exit(4); const crypto=require("node:crypto"),tree=crypto.createHash("sha256");const files=fs.readdirSync(p,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>require("node:path").relative(p,require("node:path").join(e.parentPath,e.name))).sort();for(const name of files){tree.update(name+"\\0");tree.update(crypto.createHash("sha256").update(fs.readFileSync(p+"/"+name)).digest())} console.log(JSON.stringify({shared:p,readonly:true,files:files.length,treeSha256:tree.digest("hex"),apiSha256:require("node:crypto").createHash("sha256").update(fs.readFileSync(f)).digest("hex")}))'
      const readonly = await session.bash('node -e ' + quote(probe) + ' ' + quote(sharedPath), 120_000, username)
      await record(username + '-readonly', readonly); assert(readonly.exitCode === 0, 'Member shared mount must be read-only')
      const metadata = JSON.parse(readonly.stdout.text.trim().split('\n').at(-1)!)
      assert(metadata.files === expectedFiles.length && metadata.treeSha256 === expectedTreeSha256, 'Shared SDK must exactly match every signed core-file checksum')
      sharedIdentities.push(metadata.shared + ':' + metadata.treeSha256)
      sharedChecks.push({ username, check: async () => {
        const after = await session.bash('node -e ' + quote(probe) + ' ' + quote(sharedPath), 120_000, username)
        await record(username + '-shared-after-fallback', after); assert(after.exitCode === 0)
        assert(JSON.parse(after.stdout.text.trim().split('\n').at(-1)!).treeSha256 === expectedTreeSha256, 'Fallback must not change the shared tree')
      } })
      const hostLog = () => {
        const cli = process.env.DSH_PHALANX_CONTAINER_RUNTIME ?? 'podman'
        const names = execFileSync(cli, ['ps', '--filter', 'label=dsh-phalanx.community-root=' + sha(Buffer.from(session.root)), '--filter', 'label=dsh-phalanx.user=' + username, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
        assert(names.length === 1, 'Identify exactly this member Host for log observation')
        const result = spawnSync(cli, ['logs', names[0]!], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
        assert(result.status === 0, 'Read the actual member Host log')
        return { stdout: result.stdout, stderr: result.stderr }
      }
      hostReaders.set(username, hostLog)
      const priorHostLog = hostLog()
      let coreHostLog: { stdout: string, stderr: string } | undefined
      let coreCacheFiles: string[] | undefined
      for (const extension of (username === 'member' ? ['xlsx', 'pptx', 'docx'] : ['docx', 'xlsx', 'pptx'])) {
        const document = join(workspace, 'shared-editor.' + extension)
        const page = await browser.newPage({ locale: 'en', deviceScaleFactor: username === 'member-b' ? 2 : 1, viewport: { width: 1600, height: 1000 } }); page.setDefaultTimeout(30_000)
        const responses: { path: string, status: number }[] = []
        page.on('response', response => { const url = new URL(response.url()); if (url.pathname.includes('onlyoffice')) responses.push({ path: url.pathname, status: response.status() }) })
        try {
          await observeDocumentReady(page)
          await signInCommunity(page, session.origin, username, password)
          await selectCommunityWorkspace(page.context(), page, session.origin, instanceWorkspacePath(workspace, true), true)
          await startCommunitySession(page)
          const expand = page.locator('[data-sidebar-right-expand]'); if (await expand.isVisible()) await expand.click()
          await page.locator('[data-sidebar-right-guide-entry="files"]').click()
          await page.locator('[data-files-state="tree"]').waitFor()
          await page.locator('[data-files-entry="file"]').filter({ hasText: 'shared-editor.' + extension }).getByRole('button').click()
          const renderer = page.locator('[data-document-preview="dsh-onlyoffice:document"]')
          if (await renderer.count() === 0) { await page.locator('[data-document-viewer-menu]').click(); await page.getByRole('menuitem', { name: 'OnlyOffice document', exact: true }).click() }
          await renderer.waitFor()
          const wrapper = renderer.locator('.onlyoffice-container[data-onlyoffice-container-id]'), instanceId = await wrapper.getAttribute('data-onlyoffice-container-id')
          assert(instanceId)
          phase = username + '-' + extension + '-document-ready'
          await expect.poll(() => page.evaluate(id => (window as unknown as { officeReady: string[] }).officeReady.includes(id), instanceId), { timeout: 180_000 }).toBe(true)
          const editor = page.frames().find(frame => frame.name() === 'frameEditor' && new URL(frame.url()).searchParams.get('frameEditorId') === instanceId)
          assert(editor, 'Current editor iframe must be identified')
          await record(username + '-' + extension + '-editor-dom', await editor.locator('body').evaluate(body => ({ text: (body.textContent ?? '').slice(0, 12000), ids: [...body.querySelectorAll('[id]')].map(element => ({ id: element.id, tag: element.tagName })).filter(row => /save|viewer|area_id|input|textarea/iu.test(row.id)) })))
          if (username === 'member' && extension === 'docx') {
            coreHostLog = hostLog(); coreCacheFiles = await cacheFiles()
            assert.deepEqual(coreCacheFiles, [], 'Core first-open SDK requests must leave the member cache empty')
            phase = 'native-edit-save'
            const beforeHash = sha(await readFile(document)), marker = 'SAVED_NATIVE_' + input.runId.replaceAll('-', '')
            const viewer = editor.locator('#id_viewer_overlay')
            await viewer.click({ position: { x: 250, y: 180 } })
            await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.type(marker)
            const saved = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/dsh-onlyoffice/save') && response.status() === 200, { timeout: 120_000 })
            await page.keyboard.press('Control+s'); await saved
            await renderer.getByRole('status').filter({ hasText: 'Saved back to the original file.' }).waitFor({ timeout: 120_000 })
            const afterHash = sha(await readFile(document))
            const xml = execFileSync('python3', ['-c', 'import sys,zipfile,xml.etree.ElementTree as E; z=zipfile.ZipFile(sys.argv[1]); r=E.fromstring(z.read("word/document.xml")); print("".join(r.itertext()))', document], { encoding: 'utf8' })
            assert(beforeHash !== afterHash && xml.includes(marker), 'Native edit must be saved into the original DOCX')
            await record('native-save', { beforeHash, afterHash, marker, nativeTextConfirmed: true })
          }
          await wrapper.screenshot({ path: join(results, username + '-' + extension + '-editor.png') })
          await record(username + '-' + extension + '-responses', responses)
        } catch (error) {
          await page.screenshot({ path: join(results, username + '-' + extension + '-failure.png'), fullPage: true }).catch(() => {})
          throw error
        } finally { await page.close() }
      }
      coreCacheFiles ??= await cacheFiles()
      assert.deepEqual(coreCacheFiles, [], 'Core first-open SDK requests must leave the member asset cache empty')
      if (username === 'member-b') {
        const after = await session.bash('node -e ' + quote(probe) + ' ' + quote(sharedPath), 120_000, username)
        await record('shared-after-open', after); assert(after.exitCode === 0)
        assert(JSON.parse(after.stdout.text.trim().split('\n').at(-1)!).treeSha256 === metadata.treeSha256, 'Shared SDK must remain unchanged after both opens')
      }
      const log = await until(async () => readFile(join(cache, '.requests.log'), 'utf8'), value => value.includes('/sdk/onlyoffice/'), 10_000)
      await writeFile(join(results, username + '-requests.log'), log)
      const completeHostLog = coreHostLog ?? hostLog()
      assert(completeHostLog.stdout.startsWith(priorHostLog.stdout) && completeHostLog.stderr.startsWith(priorHostLog.stderr), 'Host log changed identity during the member open')
      const sdkLog = (completeHostLog.stdout.slice(priorHostLog.stdout.length) + '\n' + completeHostLog.stderr.slice(priorHostLog.stderr.length)).split('\n').filter(line => line.includes('[dsh-onlyoffice]'))
      await record(username + '-host-sdk-log', sdkLog)
      const sharedHits = sdkLog.filter(line => line.includes('shared cache hit ')).length
      const misses = sdkLog.filter(line => /cache miss |mirror fail |cached https?:/u.test(line))
      // These optional spellcheck files do not exist in the pinned upstream SDK.
      // Failed attempts are recorded, never described as zero upstream requests.
      const missingDictionaries = ['dictionaries/en_US/en_US.aff', 'dictionaries/en_US/en_US.dic']
      const unexpected = misses.filter(line => /cached https?:/u.test(line) || !missingDictionaries.some(path => line.includes('/' + path)))
      const paths = sdkLog.filter(line => line.includes('shared cache hit ')).map(line => line.split('shared cache hit ')[1]!)
      assert(sharedHits > 0 && paths.every(path => expectedFiles.some((row: { path: string }) => row.path === path)), 'Actual shared hits must belong to the signed SDK core')
      assert(unexpected.length === 0, 'Declared core files must never miss or download upstream; only absent optional dictionaries may fail')
      await record(username + '-shared', { shared: metadata, memberCacheFiles: coreCacheFiles, beforeNativeEdit: !!coreHostLog,
        sharedHits, coreResponsesFromShared: true, effectiveAssetDownloads: 0, upstreamFetchAttempts: misses.filter(line => line.includes('cache miss ')).length,
        unavailableOptionalDictionaryAttempts: misses })
    }
    assert(sharedIdentities[0] === sharedIdentities[1], 'Both members must use the same shared artifact')
    phase = 'member-b-fallback'
    const relative = 'web-apps/apps/documenteditor/main/locale/fr.json'
    assert(!expectedFiles.some((row: { path: string }) => row.path === '9.4.0-develop/' + relative), 'Fallback asset must not be preseeded')
    const memberCache = join(session.root, 'users/member-b/home/.dsh/onlyoffice-sdk/9.4.0-develop', relative)
    await assert.rejects(readFile(memberCache), { code: 'ENOENT' })
    const readHostLog = hostReaders.get('member-b')!, beforeFallback = readHostLog()
    const memberCookie = await session.enter('member-b')
    const response = await fetch(communityEntryUrl(session.origin, memberCookie) + 'dsh-onlyoffice/sdk/onlyoffice/9.4.0-develop/' + relative, { headers: { cookie: memberCookie } })
    assert(response.status === 200, 'A non-preseeded SDK file must fall back through the actual member Host')
    const fallbackBytes = Buffer.from(await response.arrayBuffer())
    assert(sha(await readFile(memberCache)) === sha(fallbackBytes), 'Fallback must write the file into the member cache')
    const afterFallback = readHostLog()
    assert(afterFallback.stdout.startsWith(beforeFallback.stdout) && afterFallback.stderr.startsWith(beforeFallback.stderr), 'Fallback Host identity changed')
    const fallbackLog = afterFallback.stdout.slice(beforeFallback.stdout.length) + '\n' + afterFallback.stderr.slice(beforeFallback.stderr.length)
    assert(fallbackLog.includes('[dsh-onlyoffice] cache miss '), 'Observe a real upstream miss independently of core first-open assertions')
    await record('member-b-fallback', { path: relative, bytes: fallbackBytes.length, sha256: sha(fallbackBytes), storedInMemberCache: true, coreFirstOpenAssertionsCompletedBeforeThisRequest: true })
    await sharedChecks.find(row => row.username === 'member-b')!.check()
    await record('result', { status: 'passed', contentHash: input.contentHash, plugin, sharedIdentities })
  } catch (error) {
    await record('failure', { phase, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined,
      installations: await session.api('suites').catch(() => undefined), dependencies: await session.api('runtime-dependencies').catch(() => undefined) })
    throw error
  } finally {
    try { await browser?.close() } finally {
      try { await session.stop() } finally { await closeMirror() }
    }
  }
}, 1_800_000)

async function observeDocumentReady(page: Page) {
  await page.addInitScript(() => {
    const host = window as unknown as { officeReady: string[] }; host.officeReady = []
    window.addEventListener('message', event => {
      let data = event.data; try { if (typeof data === 'string') data = JSON.parse(data) } catch { return }
      if (data?.event !== 'onDocumentReady') return
      const frame = [...document.querySelectorAll<HTMLIFrameElement>('iframe[name="frameEditor"]')].find(frame => frame.contentWindow === event.source)
      const id = frame && new URL(frame.src, location.href).searchParams.get('frameEditorId')
      if (id && id === data.frameEditorId) host.officeReady.push(id)
    })
  })
}
