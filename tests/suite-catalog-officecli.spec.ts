import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { suiteCatalogAdapterWrappers, validateSuiteCatalogAdapters } from '../src/domain/suite-catalog-adapters.js'
import { suiteRuntimeDependencyDefinition, type SuiteCatalogRuntimeDependencyItem, type SuiteCatalogSuiteEntry } from '../src/domain/suite-catalog.js'
import { readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { createCatalogSigningKey, signCatalog } from './fixtures/suite-catalog-signing.js'
import { legacyOfficecliPrepareCommands, onlineCatalogEntries } from './fixtures/suite-catalog-online.js'

const key = createCatalogSigningKey()
const read = readSuiteCatalog(signCatalog(onlineCatalogEntries, key).bytes, { trustedKeys: [key], platformVersion: '0.1.19' })
if (read.status !== 'ok') throw new Error('fixture catalog was rejected')
const officecli = read.entries.find(row => row.entry.id === 'officecli')!.entry as SuiteCatalogSuiteEntry
const document = onlineCatalogEntries.find(row => row.id === 'officecli')!
if (document.kind !== 'suite') throw new Error('unexpected kind')
const declaredItem = document.items.find((item): item is Extract<typeof item, { kind: 'runtime-dependency' }> => item.kind === 'runtime-dependency')!
const adapterCheck = validateSuiteCatalogAdapters(document.adapters, [declaredItem])
if (!adapterCheck.okay) throw new Error(`${adapterCheck.code}: ${adapterCheck.detail}`)
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('generates exactly the 0.1.18 OfficeCLI preparation: fixed environment wrapper execs the real binary', () => {
  const tool = officecli.items.find((item): item is SuiteCatalogRuntimeDependencyItem => item.kind === 'runtime-dependency')!
  for (const architecture of ['amd64', 'arm64'] as const) {
    expect(suiteRuntimeDependencyDefinition(tool, architecture)!.prepareCommand).toBe(legacyOfficecliPrepareCommands[architecture])
  }
  expect(tool).toMatchObject({ name: 'office-tools', pathDirectories: ['bin'], checkCommand: 'officecli --version', commands: ['officecli'] })
  expect(document.adapters).toEqual([{ name: 'fixed-environment', params: { item: 'office-tools', command: 'officecli', environment: { OFFICECLI_SKIP_UPDATE: '1' } } }])
  expect(officecli.dependencies).toEqual([])
})

it('runs the generated wrapper, passing the fixed environment and every argument to the real entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'officecli-wrapper-')); roots.push(root)
  const wrapper = suiteCatalogAdapterWrappers(declaredItem, adapterCheck.adapters)[0]!
  await mkdir(join(root, 'bin'), { recursive: true }); await mkdir(join(root, 'lib'), { recursive: true })
  await writeFile(join(root, wrapper.path), `${wrapper.lines.join('\n')}\n`, { mode: 0o755 }); await chmod(join(root, wrapper.path), 0o755)
  // The real officecli binary is the only thing the wrapper executes; it reports the environment it received.
  await writeFile(join(root, 'lib/officecli'), '#!/bin/sh\nprintf \'skip=%s args=%s\\n\' "${OFFICECLI_SKIP_UPDATE:-}" "$*"\n', { mode: 0o755 })
  await chmod(join(root, 'lib/officecli'), 0o755)
  const result = spawnSync(join(root, 'bin/officecli'), ['--version', 'read', 'report.xlsx'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe('skip=1 args=--version read report.xlsx')
  expect(wrapper.lines).toEqual(['#!/bin/sh', 'export OFFICECLI_SKIP_UPDATE=1', 'exec "$(dirname "$(readlink -f "$0")")/../lib/officecli" "$@"'])
})

it('keeps the OfficeCLI skill and pack declarations across the migration', () => {
  expect(officecli.items.map(item => item.kind)).toEqual(['runtime-dependency', 'skill', 'skill-pack'])
  const skill = officecli.items.find(item => item.kind === 'skill')!
  expect(skill).toMatchObject({ source: { type: 'git', url: 'https://github.com/iOfficeAI/OfficeCLI', commit: 'b65272a18aef891941451705ff93e8a287f3eb72', path: 'skills' }, runtimeDependency: 'office-tools' })
  if (skill.kind === 'skill') expect(skill.names).toHaveLength(11)
  const pack = officecli.items.find(item => item.kind === 'skill-pack')!
  expect(pack).toMatchObject({ name: 'officecli-suite' })
})
