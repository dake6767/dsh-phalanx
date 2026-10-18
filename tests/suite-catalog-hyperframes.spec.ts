import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { suiteRuntimeDependencyDefinition, type SuiteCatalogRuntimeDependencyItem, type SuiteCatalogSkillItem, type SuiteCatalogSkillPackItem, type SuiteCatalogSuiteEntry } from '../src/domain/suite-catalog.js'
import { suiteCatalogAdapterWrappers } from '../src/domain/suite-catalog-adapters.js'
import { documentEntry, documentRuntimeItem, fixtureCatalog, fixtureEntry, validatedAdapters, writeGeneratedWrapper } from './fixtures/suite-catalog-converted.js'

const hyperframes = fixtureEntry('hyperframes') as SuiteCatalogSuiteEntry
const tool = hyperframes.items.find((item): item is SuiteCatalogRuntimeDependencyItem => item.kind === 'runtime-dependency')!
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const nodeDirectory = dirname(process.execPath)
const systemPath = ['/usr/local/bin', '/usr/bin', '/bin'].join(':')

it('declares the 0.1.18 HyperFrames wrapper behavior as data: refusal, environment, shared Chromium and npx interception', () => {
  const document = documentEntry('hyperframes')
  if (document.kind !== 'suite') throw new Error('unexpected kind')
  expect(document.dependencies).toEqual(['ffmpeg', 'chromium'])
  // Rendering is local; the card shows the shared dependencies, not a network service address.
  expect(document.serviceAddresses).toEqual([])
  expect(tool).toMatchObject({ name: 'hyperframes-tools', pathDirectories: ['bin'], checkCommand: 'hyperframes --version', commands: ['hyperframes', 'npx'] })
  const skills = hyperframes.items.find((item): item is SuiteCatalogSkillItem => item.kind === 'skill')!
  expect(skills.source).toEqual({ type: 'git', url: 'https://github.com/heygen-com/hyperframes', commit: '35b17c3fe6cdf7e40d252f1d813b0a2cecec6a94', path: 'skills' })
  expect(skills.names).toHaveLength(14)
  expect(skills.catalogDependencies).toEqual(['ffmpeg', 'chromium'])
  const pack = hyperframes.items.find((item): item is SuiteCatalogSkillPackItem => item.kind === 'skill-pack')!
  expect(pack.skills).toEqual(skills.names)
  expect(pack.note).toContain('Do not run `npx hyperframes skills update`')
})

it('generates the accepted wrapper semantics and never identifies itself with a grep comment', () => {
  const prepare = suiteRuntimeDependencyDefinition(tool, 'amd64')!.prepareCommand
  expect(prepare).toContain('npm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund hyperframes@0.8.167')
  expect(prepare).toContain('export HYPERFRAMES_NO_TELEMETRY=1')
  expect(prepare).toContain('HYPERFRAMES_BROWSER_PATH')
  expect(prepare).toContain('command -v chromium-headless-shell')
  expect(prepare).toContain('exec node "$(dirname "$(readlink -f "$0")")/../node_modules/hyperframes/bin/hyperframes.mjs" "$@"')
  expect(prepare).toContain('skills|upgrade) printf')
  expect(prepare).toContain('HyperFrames skills and CLI are provided by the platform; this command is disabled.')
  const npx = suiteCatalogAdapterWrappers(documentRuntimeItem('hyperframes', 'hyperframes-tools'), validatedAdapters('hyperframes', 'hyperframes-tools')).find(wrapper => wrapper.command === 'npx')!
  expect(npx.lines.join('\n')).toContain('self="$(readlink -f "$0")"')
  expect(npx.lines.join('\n')).toContain('!= "$self"')
  expect(npx.lines.join('\n')).not.toContain('grep')
  // Chromium still arrives through the declarative browser download source.
  const chromium = fixtureCatalog().find(entry => entry.id === 'chromium')!.items[0] as SuiteCatalogRuntimeDependencyItem
  expect(suiteRuntimeDependencyDefinition(chromium, 'amd64')!.prepareCommand).toContain('${PLAYWRIGHT_DOWNLOAD_HOST:-https://cdn.playwright.dev}/builds/cft/153.0.8010.12/')
  expect(suiteRuntimeDependencyDefinition(chromium, 'arm64')!.prepareCommand).toContain('${PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST:-https://cdn.playwright.dev}/builds/chromium/1243/')
})

interface Prepared { readonly root: string, readonly hyperframes: string, readonly npx: string, readonly chromium: string }

async function prepared(): Promise<Prepared> {
  const root = await mkdtemp(join(tmpdir(), 'hyperframes-wrapper-')); roots.push(root)
  await mkdir(join(root, 'node_modules/hyperframes/bin'), { recursive: true })
  await mkdir(join(root, 'chromium/bin'), { recursive: true })
  await writeFile(join(root, 'node_modules/hyperframes/bin/hyperframes.mjs'),
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), browser: process.env.HYPERFRAMES_BROWSER_PATH ?? null, telemetry: process.env.HYPERFRAMES_NO_TELEMETRY ?? null, doNotTrack: process.env.DO_NOT_TRACK ?? null, noUpdate: process.env.HYPERFRAMES_NO_UPDATE_CHECK ?? null, skipSkills: process.env.HYPERFRAMES_SKIP_SKILLS ?? null }))\n',
    { mode: 0o755 })
  const chromium = join(root, 'chromium/bin/chromium-headless-shell')
  await writeFile(chromium, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await chmod(chromium, 0o755)
  const hyperframesWrapper = await writeGeneratedWrapper(root, 'hyperframes', 'hyperframes-tools', 'hyperframes')
  const npxWrapper = await writeGeneratedWrapper(root, 'hyperframes', 'hyperframes-tools', 'npx')
  return { root, hyperframes: hyperframesWrapper.path, npx: npxWrapper.path, chromium }
}

const run = (command: string, args: readonly string[], path: readonly string[]) =>
  spawnSync(command, [...args], { encoding: 'utf8', env: { ...process.env, PATH: path.join(':') } })

it('links the shared Chromium path, exports the fixed environment and keeps --version usable without a browser', async () => {
  const { root, hyperframes: wrapper, chromium } = await prepared()
  const bin = join(root, 'bin')
  const withoutBrowser = run(wrapper, ['--version'], [bin, nodeDirectory, systemPath])
  expect(withoutBrowser.status, withoutBrowser.stderr).toBe(0)
  expect(JSON.parse(withoutBrowser.stdout)).toEqual({ argv: ['--version'], browser: null, telemetry: '1', doNotTrack: '1', noUpdate: '1', skipSkills: '1' })

  const missingBrowser = run(wrapper, ['init'], [bin, nodeDirectory, systemPath])
  expect(missingBrowser.status).toBe(1)
  expect(missingBrowser.stderr).toContain('The platform Chromium dependency is unavailable.')

  const withBrowser = run(wrapper, ['init', 'demo'], [bin, join(root, 'chromium/bin'), nodeDirectory, systemPath])
  expect(withBrowser.status, withBrowser.stderr).toBe(0)
  expect(JSON.parse(withBrowser.stdout)).toMatchObject({ argv: ['init', 'demo'], browser: await realpath(chromium), telemetry: '1' })

  for (const subcommand of ['skills', 'upgrade']) {
    const refused = run(wrapper, [subcommand, 'update'], [bin, join(root, 'chromium/bin'), nodeDirectory, systemPath])
    expect(refused.status).toBe(2); expect(refused.stdout).toBe('')
    expect(refused.stderr).toContain('HyperFrames skills and CLI are provided by the platform; this command is disabled.')
  }
})

it('intercepts npx calls for hyperframes and delegates every other package to the real npx', async () => {
  const { root, npx: wrapper } = await prepared()
  const bin = join(root, 'bin')
  const realNpxDirectory = join(root, 'real-npx')
  await mkdir(realNpxDirectory, { recursive: true })
  await writeFile(join(realNpxDirectory, 'npx'), '#!/bin/sh\nprintf \'real-npx:%s\\n\' "$*"\n', { mode: 0o755 })
  const path = [bin, join(root, 'chromium/bin'), realNpxDirectory, nodeDirectory, systemPath]

  // Other packages go to the real npx.
  const other = run(wrapper, ['prettier', '--version'], path)
  expect(other.status, other.stderr).toBe(0)
  expect(other.stdout.trim()).toBe('real-npx:prettier --version')

  // hyperframes package forms route to the platform wrapper; the command word after the package is consumed.
  const routed = (args: readonly string[]) => run(wrapper, args, path)
  expect(routed(['hyperframes', 'skills', 'add']).status).toBe(2)
  expect(routed(['hyperframes', 'skills', 'add']).stderr).toContain('this command is disabled')
  // The reported 0.1.18 regression: a repeated package word after --package is the command word and must be consumed.
  expect(routed(['--package=hyperframes', 'hyperframes', 'skills', 'add']).status).toBe(2)
  expect(routed(['--package=hyperframes', 'hyperframes', 'skills', 'add']).stderr).toContain('this command is disabled')
  for (const [args, expected] of [
    [['hyperframes@0.8.167', '--version'], ['--version']],
    [['--package=hyperframes', 'init'], ['init']],
    [['-p', 'hyperframes', 'lint'], ['lint']],
    [['--yes', 'hyperframes@0.8.160', 'lint'], ['lint']],
  ] as const) {
    const result = routed(args)
    expect(result.status, `${args.join(' ')} ${result.stderr}`).toBe(0)
    expect(JSON.parse(result.stdout).argv, args.join(' ')).toEqual([...expected])
  }
  // npx options before the package are stripped, including the explicit --package form and boolean/offline flags.
  for (const args of [['--package=hyperframes', 'hyperframes', 'lint'], ['-y', '--quiet', 'hyperframes', 'lint'], ['--prefer-offline', 'hyperframes', 'lint']]) {
    const result = routed(args)
    expect(result.status, args.join(' ')).toBe(0)
    expect(JSON.parse(result.stdout).argv, args.join(' ')).toEqual(['lint'])
  }

  // A different wrapper named npx earlier in PATH is a foreign npx: it is executed rather than mistaken for self.
  const otherWrapperDirectory = join(root, 'other-wrapper')
  await mkdir(otherWrapperDirectory, { recursive: true })
  await writeFile(join(otherWrapperDirectory, 'npx'), '#!/bin/sh\nprintf \'other-wrapper:%s\\n\' "$*"\n', { mode: 0o755 })
  const foreign = run(wrapper, ['prettier', '--version'], [bin, otherWrapperDirectory, realNpxDirectory, nodeDirectory, systemPath])
  expect(foreign.stdout.trim()).toBe('other-wrapper:prettier --version')

  // A symlink to ourselves in another PATH directory is skipped, and the real npx is reached.
  const selfLinkDirectory = join(root, 'self-link')
  await mkdir(selfLinkDirectory, { recursive: true })
  await symlink(wrapper, join(selfLinkDirectory, 'npx'))
  const linked = run(wrapper, ['prettier', '--version'], [bin, selfLinkDirectory, realNpxDirectory, nodeDirectory, systemPath])
  expect(linked.stdout.trim()).toBe('real-npx:prettier --version')
  // The routed branch still wins regardless of PATH order.
  expect(run(wrapper, ['hyperframes', '--version'], [bin, otherWrapperDirectory, realNpxDirectory, nodeDirectory, systemPath]).status).toBe(0)
})
