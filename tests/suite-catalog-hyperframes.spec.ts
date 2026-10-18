import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { suiteCatalog, suiteRuntimeDependencyDefinition, type SuiteCatalogRuntimeDependencyItem, type SuiteCatalogSkillItem, type SuiteCatalogSkillPackItem, type SuiteCatalogSuiteEntry } from '../src/domain/suite-catalog.js'
import { readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { createCatalogSigningKey, signCatalog } from './fixtures/suite-catalog-signing.js'
import { onlineCatalogEntries } from './fixtures/suite-catalog-online.js'

const hyperframes = suiteCatalog.find((entry): entry is SuiteCatalogSuiteEntry => entry.id === 'hyperframes' && entry.category === 'suite')!
const tool = hyperframes.items.find((item): item is SuiteCatalogRuntimeDependencyItem => item.kind === 'runtime-dependency')!
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

/** Runs the catalog preparation with npm stubbed; the stub CLI echoes its argv and the environment the wrapper sets. */
async function prepared() {
  const root = await mkdtemp(join(tmpdir(), 'suite-hyperframes-')); roots.push(root)
  const stubs = join(root, 'stubs'), out = join(root, 'out'), browser = join(root, 'browser')
  await mkdir(stubs); await mkdir(out); await mkdir(browser)
  const cli = "console.log(JSON.stringify({ argv: process.argv.slice(2), browser: process.env.HYPERFRAMES_BROWSER_PATH, telemetry: process.env.HYPERFRAMES_NO_TELEMETRY, skip: process.env.HYPERFRAMES_SKIP_SKILLS, update: process.env.HYPERFRAMES_NO_UPDATE_CHECK }))"
  await writeFile(join(stubs, 'npm'), `#!/bin/sh\nmkdir -p "$RD_OUT/node_modules/hyperframes/bin"\nprintf '%s\\n' '${cli}' > "$RD_OUT/node_modules/hyperframes/bin/hyperframes.mjs"\n`)
  await writeFile(join(stubs, 'npx'), '#!/bin/sh\necho "system npx $*"\n')
  await writeFile(join(browser, 'chromium-headless-shell'), '#!/bin/sh\n')
  for (const file of [join(stubs, 'npm'), join(stubs, 'npx'), join(browser, 'chromium-headless-shell')]) await chmod(file, 0o755)
  const result = spawnSync('/bin/sh', ['-c', suiteRuntimeDependencyDefinition(tool, 'amd64')!.prepareCommand], { cwd: out, env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, RD_OUT: out }, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  const run = (command: string, args: readonly string[], withBrowser = true) => spawnSync(join(out, 'bin', command), args, {
    env: { ...process.env, PATH: [join(out, 'bin'), ...withBrowser ? [browser] : [], stubs, process.env.PATH].join(':') }, encoding: 'utf8' })
  return { run, browser }
}

it('wraps the CLI with the shared Chromium, telemetry and self-updates off', async () => {
  const f = await prepared()
  const result = f.run('hyperframes', ['render', '-o', 'out.mp4'])
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ argv: ['render', '-o', 'out.mp4'], browser: await realpath(join(f.browser, 'chromium-headless-shell')), telemetry: '1', skip: '1', update: '1' })
  const missing = f.run('hyperframes', ['render'], false)
  expect(missing.status).toBe(1); expect(missing.stderr).toContain('Chromium dependency is unavailable')
})

it('refuses skills and upgrade, and routes npx hyperframes to the wrapper while other npx calls pass through', async () => {
  const f = await prepared()
  for (const args of [['skills', 'update', 'general-video'], ['upgrade']]) {
    const refused = f.run('hyperframes', args)
    expect(refused.status).toBe(2); expect(refused.stderr).toContain('provided by the platform')
  }
  expect(f.run('npx', ['-y', 'hyperframes', 'skills', 'update']).status).toBe(2)
  expect(f.run('hyperframes', ['--quiet', 'skills', 'update']).status).toBe(2)
  expect(f.run('npx', ['-p', 'hyperframes', 'hyperframes', 'skills']).status).toBe(2)
  for (const args of [['hyperframes', 'lint'], ['--yes', 'hyperframes@0.8.160', 'lint'], ['-y', '--quiet', 'hyperframes', 'lint'], ['--package=hyperframes', 'hyperframes', 'lint'], ['-p', 'hyperframes@0.8.167', 'hyperframes', 'lint'], ['--prefer-offline', 'hyperframes', 'lint']]) {
    const routed = f.run('npx', args)
    expect(routed.status, routed.stderr).toBe(0)
    // Only the subcommand and its arguments reach the CLI; npx's own flags and the package name are dropped.
    expect(JSON.parse(routed.stdout).argv).toEqual(['lint'])
  }
  const passthrough = f.run('npx', ['-y', 'prettier', '--version'])
  expect(passthrough.stdout.trim()).toBe('system npx -y prettier --version')
  expect(f.run('npx', ['-p', 'typescript', 'tsc', '--version']).stdout.trim()).toBe('system npx -p typescript tsc --version')
})

it('declares the shared dependencies, the first-batch skills and a pack note that forbids self-updates', () => {
  expect(hyperframes.dependencies).toEqual(['ffmpeg', 'chromium'])
  expect(tool.commands).toEqual(['hyperframes', 'npx'])
  const skills = hyperframes.items.find((item): item is SuiteCatalogSkillItem => item.kind === 'skill')!
  expect(skills.source).toEqual({ type: 'git', url: 'https://github.com/heygen-com/hyperframes', commit: '35b17c3fe6cdf7e40d252f1d813b0a2cecec6a94', path: 'skills' })
  expect(skills.names).toHaveLength(14)
  expect(skills.names).not.toEqual(expect.arrayContaining(['embedded-captions']))
  expect(skills.catalogDependencies).toEqual(['ffmpeg', 'chromium'])
  const pack = hyperframes.items.find((item): item is SuiteCatalogSkillPackItem => item.kind === 'skill-pack')!
  expect(pack.skills).toEqual(skills.names)
  expect(pack.note).toContain('Do not run `npx hyperframes skills update`')
  // Chromium moved to the declarative online catalog; its generated browser commands keep the 0.1.18 behavior.
  const key = createCatalogSigningKey()
  const online = readSuiteCatalog(signCatalog(onlineCatalogEntries, key).bytes, { trustedKeys: [key], platformVersion: '0.1.19' })
  if (online.status !== 'ok') throw new Error('fixture catalog was rejected')
  const chromium = online.entries.find(row => row.entry.id === 'chromium')!.entry.items[0] as SuiteCatalogRuntimeDependencyItem
  expect(suiteRuntimeDependencyDefinition(chromium, 'amd64')!.prepareCommand).toContain('${PLAYWRIGHT_DOWNLOAD_HOST:-https://cdn.playwright.dev}/builds/cft/153.0.8010.12/')
  expect(suiteRuntimeDependencyDefinition(chromium, 'arm64')!.prepareCommand).toContain('${PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST:-https://cdn.playwright.dev}/builds/chromium/1243/')
})
