import { effectiveUserDataRoot } from '../src/domain/storage-layout.js'
// Explicit credentialed catalog acceptance; never included in the credential-free inventories.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { it } from 'vitest'
import { readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { officialSuiteCatalogKeys } from '../src/domain/suite-catalog-keys.js'
import { openOfficeSession, until } from './fixtures/office-session.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
it('installs the signed presentation entry and creates editable member decks with delegated images and without configured images', async () => {
  const inputPath = process.env.DSH_PHALANX_PPT_MASTER_INPUT
  assert(inputPath, 'Pass the private owned acceptance input explicitly')
  const input = JSON.parse(await readFile(inputPath, 'utf8')) as {
    root: string
    runId: string
    credentialFile: string
    catalogFile: string
    contentHash: string
  }
  const owner = JSON.parse(await readFile(join(input.root, 'OWNER.json'), 'utf8'))
  assert(owner.runId === input.runId && owner.uid === process.getuid!(), 'Acceptance root ownership mismatch')
  assertPinnedDshRevision(runtimeSettings)
  assert(runtimeSettings.containerImage, 'Use the actual member instance image')
  await mkdir(join(input.root, 'results'), { recursive: true, mode: 0o700 })
  let secret = '',
    exposed = false
  const mask = (value: string) => {
    if (secret && value.includes(secret)) {
      exposed = true
      value = value.replaceAll(secret, '{credential}')
    }
    return value.replace(/(https?:\/\/)[^/\s@"']+@/gu, '$1{credential}@')
  }
  const record = async (name: string, value: unknown) =>
    writeFile(
      join(input.root, 'results', name + '.json'),
      JSON.stringify(value, (_key, item: unknown) => (typeof item === 'string' ? mask(item) : item), 2) + '\n',
    )
  const catalogBytes = await readFile(input.catalogFile)
  const signed = readSuiteCatalog(catalogBytes, { trustedKeys: officialSuiteCatalogKeys, platformVersion: '0.1.24' })
  assert(
    signed.status === 'ok' && signed.entries.some(row => row.entry.id === 'ppt-master' && row.contentHash === input.contentHash && !row.unavailableReason),
    'Published signed catalog identity mismatch',
  )
  // Mirror the exact published bytes; the application still verifies the official signature.
  const mirror = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(catalogBytes)
  })
  await new Promise<void>(resolve => mirror.listen(0, '127.0.0.1', resolve))
  const address = mirror.address()
  assert(address && typeof address !== 'string', 'Catalog mirror did not listen')
  const closeMirror = () =>
    new Promise<void>((resolve, reject) => {
      mirror.closeAllConnections()
      mirror.close(error => (error ? reject(error) : resolve()))
    })
  const session = await openOfficeSession(input, `http://127.0.0.1:${address.port}/catalog.json`).catch(async error => {
    await closeMirror()
    throw error
  })
  const skill = '/dsh-phalanx/member-skills/live/ppt-master',
    project = '/dsh-phalanx/workspace/ppt-catalog'
  let configured = false
  try {
    const catalog = await session.api('suites'),
      entry = catalog.entries.find((row: { id: string }) => row.id === 'ppt-master')
    assert(
      entry?.available && entry.version === signed.entries.find(row => row.entry.id === 'ppt-master')?.entry.version,
      'Expected signed catalog entry identity unavailable',
    )
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ locale: 'en' })
      page.setDefaultTimeout(30_000)
      await signInCommunity(page, session.origin, 'admin', 'office-facts-fixture-password', true)
      await page.goto(session.origin + '/admin/skills?tab=catalog')
      const card = page.locator('.plugin-library-card').filter({ has: page.getByRole('button', { name: 'View catalog entry PPT Master', exact: true }) })
      await card.getByRole('button', { name: 'Install', exact: true }).click()
      await page.getByRole('dialog', { name: 'PPT Master', exact: true }).getByRole('button', { name: 'Install entry', exact: true }).click()
      await card.getByText('Installed', { exact: true }).first().waitFor({ timeout: 900_000 })
    } finally {
      await browser.close()
    }
    const execution = await session.api('skills/execution?name=ppt-master')
    assert(
      execution.enabled === false && execution.variables.every((row: { configured: boolean }) => !row.configured),
      'Skipping the wizard must keep execution disabled',
    )
    await record('installed-skipped', {
      entry,
      execution,
      installation: (await session.api('suites')).installations.find((row: { id: string }) => row.id === entry.id),
    })
    const grantPath = `groups/${session.group.id}/skills`,
      grant = await session.api(grantPath)
    await session.api(grantPath, { action: 'save', names: [], packs: ['ppt-master-tools'], revision: grant.revision, confirmed: true })
    const command = async (label: string, line: string) => {
      const result = await session.bash(line, 120_000)
      await record(label, result)
      assert(result.exitCode === 0, 'Member command failed: ' + label)
      return result
    }
    await command(
      'member-environment',
      'mkdir -p ' +
        quote(project) +
        ' && OPENAI_API_KEY=member-owned OPENAI_BASE_URL=https://member.example.test python3 -c ' +
        quote(
          'import os,sys,fitz,pptx,edge_tts,requests; assert os.environ["OPENAI_API_KEY"]=="member-owned"; assert os.environ["OPENAI_BASE_URL"]=="https://member.example.test"; print("MEMBER_ENV_AND_LIBRARIES_OK")',
        ),
    )
    const unavailable = await session.bash(
      'cd ' + quote(project) + ' && python3 ' + quote(skill + '/scripts/image_gen.py') + ' test --image_size 512px -o images',
    )
    await record('unconfigured-image', unavailable)
    assert(
      unavailable.exitCode === 125 && (unavailable.stderr.text + unavailable.stdout.text).includes('DSH_PHALANX_EXECUTION[disabled]'),
      'Unconfigured script must return the platform unavailable result',
    )

    const render = async (name: string, withImage: boolean) => {
      const projectName = name + '_20261024',
        deck = project + '/' + projectName
      await command(
        name + '-initialize',
        'python3 ' + quote(skill + '/scripts/project_manager.py') + ' init ' + quote(projectName) + ' --quick-generate --dir ' + quote(project),
      )
      const host = join(effectiveUserDataRoot({ dataRoot: session.root }), 'member/workspace/ppt-catalog', projectName)
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1280" height="720" viewBox="0 0 1280 720" lang="en"><rect width="1280" height="720" fill="#FFFFFF"/><text x="80" y="120" font-family="Arial" font-size="40" fill="#102A43">Editable presentation</text><text x="80" y="200" font-family="Arial" font-size="28" fill="#334E68">A member project built from text.</text>' +
        (withImage
          ? '<image x="800" y="260" width="320" height="320" xlink:href="../illustration.png"/>'
          : '<rect x="800" y="260" width="320" height="320" fill="#3B82F6"/>') +
        '</svg>'
      await writeFile(join(host, 'svg_output/slide_01.svg'), svg)
      if (withImage)
        await command(
          'prepare-image-for-deck',
          'cd ' +
            quote(project) +
            ' && python3 -c ' +
            quote(
              'from pathlib import Path; from PIL import Image; p=next(p for p in Path("images").glob("illustration.*") if p.suffix.lower() in [".png",".jpg",".jpeg",".webp"]); Image.open(p).save("' +
                projectName +
                '/illustration.png")',
            ),
        )
      await command(
        name + '-quality',
        'python3 ' + quote(skill + '/scripts/svg_quality_checker.py') + ' ' + quote(deck) + ' --quick-generate --canonical-authoring --stage final --json',
      )
      await command(
        name + '-export',
        'python3 ' + quote(skill + '/scripts/svg_to_pptx.py') + ' ' + quote(deck) + ' --quick-generate --no-notes -o ' + quote(deck + '/presentation.pptx'),
      )
      await command(
        name + '-editability',
        'cd ' +
          quote(deck) +
          ' && python3 -c ' +
          quote(
            'from pptx import Presentation; from pathlib import Path; import json,hashlib; p=Presentation("presentation.pptx"); texts=[s for page in p.slides for s in page.shapes if s.has_text_frame]; assert any("Editable presentation" in s.text for s in texts); assert ' +
              (withImage
                ? 'any(s.shape_type == 13 for page in p.slides for s in page.shapes)'
                : 'not any(s.shape_type == 13 for page in p.slides for s in page.shapes)') +
              '; texts[0].text="Edited native text"; p.save("edited.pptx"); assert any(s.has_text_frame and "Edited native text" in s.text for page in Presentation("edited.pptx").slides for s in page.shapes); print(json.dumps({"slides":len(p.slides),"nativeTextEditable":True,"sha256":hashlib.sha256(Path("presentation.pptx").read_bytes()).hexdigest()}))',
          ),
      )
    }
    await render('no-image', false)
    await command(
      'local-edge-narration',
      'cd ' +
        quote(project) +
        ' && python3 -m edge_tts --proxy "$HTTPS_PROXY" --voice en-US-AriaNeural --text ' +
        quote('This is an editable member presentation.') +
        ' --write-media edge-narration.mp3 && test -s edge-narration.mp3',
    )
    await command(
      'local-image-search',
      'cd ' +
        quote(project) +
        ' && python3 ' +
        quote(skill + '/scripts/image_search.py') +
        ' ' +
        quote('blue sky') +
        ' --provider wikimedia --filename library-image.jpg --slide 01_cover -o library-images',
    )
    const keyInfo = await lstat(input.credentialFile)
    assert(
      keyInfo.isFile() && !keyInfo.isSymbolicLink() && keyInfo.uid === process.getuid!() && (keyInfo.mode & 0o777) === 0o600,
      'Credential must be an owned 0600 original-derived copy',
    )
    secret = (await readFile(input.credentialFile, 'utf8')).trim()
    assert(secret, 'Empty credential input')
    const settings = await session.api('execution/settings')
    assert(
      settings.limits.timeoutSeconds === 120 && settings.limits.memoryMiB === 512 && settings.limits.cpus === 1 && settings.limits.pids === 64,
      'Retain the existing execution limits',
    )
    configured = true
    await session.api('suites', { action: 'credentials', id: 'ppt-master', credentials: { IMAGE_BACKEND: 'minimax', MINIMAX_API_KEY: secret } })
    const ready = await until(
      () => session.api('skills/execution?name=ppt-master'),
      row => (row.enabled && row.preparation?.stage === 'ready') || row.preparation?.stage === 'failed',
    )
    assert(
      ready.enabled && ready.preparation?.stage === 'ready' && !JSON.stringify(ready).includes(secret),
      'One provider must enable execution without exposing its credential',
    )
    const protectedCloud = await command(
      'protected-cloud-option',
      'python3 ' + quote(skill + '/scripts/cloud_notes_to_audio.py') + ' ' + quote(project) + ' --minimax-b=https://member.example.test --provider minimax',
    )
    assert(
      protectedCloud.stdout.text.includes('Credentials are configured by the platform'),
      'The signed cloud template must refuse endpoint overrides before a provider call',
    )
    await writeFile(
      join(effectiveUserDataRoot({ dataRoot: session.root }), 'member/workspace/ppt-catalog/.env'),
      'MINIMAX_BASE_URL=https://member.example.test\n',
    )
    await command(
      'delegated-image',
      'cd ' +
        quote(project) +
        ' && python3 ' +
        quote(skill + '/scripts/image_gen.py') +
        ' ' +
        quote('A simple blue circle on white, no text') +
        ' --image_size 512px --aspect_ratio 1:1 -o images -f illustration',
    )
    await render('with-image', true)
    const records = (await session.api('usage-records?username=member&capability=skill:ppt-master')).items
    assert(
      records.some(
        (row: { outcome: string; capability: { operation: string } }) => row.outcome === 'succeeded' && row.capability.operation === 'ppt-master-image',
      ),
      'Missing successful image usage record',
    )
    await record('usage', records)
    await command(
      'credential-isolation',
      'python3 -c ' +
        quote('import os,json; assert not os.environ.get("MINIMAX_API_KEY"); assert not os.environ.get("IMAGE_BACKEND"); print("PLATFORM_CREDENTIALS_ABSENT")'),
    )
    assert(!exposed, 'A response exposed the platform credential')
    await record('result', {
      status: 'passed',
      signedCatalogSha256: createHash('sha256').update(catalogBytes).digest('hex'),
      catalogContentHash: input.contentHash,
      imageBackend: 'minimax',
      imageModel: 'image-01',
      imageSize: '512px',
      limits: settings.limits,
      nativeEditableDecks: ['no-image_20261024/presentation.pptx', 'with-image_20261024/presentation.pptx'],
      realEdgeNarration: true,
      realImageSearch: true,
    })
  } catch (error) {
    throw new Error(mask(error instanceof Error ? error.message : String(error)))
  } finally {
    try {
      if (configured) await session.api('suites', { action: 'credentials', id: 'ppt-master', credentials: { IMAGE_BACKEND: '', MINIMAX_API_KEY: '' } })
    } finally {
      try {
        await session.stop()
      } finally {
        await closeMirror()
      }
    }
  }
}, 1_800_000)
