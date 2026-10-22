import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { changedFields, classifyStages, diffChanges, importClosure, type StageChange, type StageResult, type StageTable } from '../scripts/validation/t4-stages.mjs'

const table = JSON.parse(readFileSync('scripts/validation/t4-stages.json', 'utf8')) as StageTable
const runs = (result: Pick<StageResult, 'stages'>) => Object.fromEntries(result.stages.map(stage => [stage.id, stage.run]))
const run = (...changes: StageChange[]) => runs(classifyStages(changes, table))
const only = (...ids: string[]) => Object.fromEntries(table.stages.map(stage => [stage.id, stage.always === true || ids.includes(stage.id)]))
const every = () => Object.fromEntries(table.stages.map(stage => [stage.id, true]))

it('keeps the stage table consistent with the tracked T4 entry tests', () => {
  expect(new Set(table.stages.map(stage => stage.id)).size).toBe(table.stages.length)
  const entries = table.stages.flatMap(stage => stage.entries)
  expect(entries.filter(file => !/^\/\/ Validation: [^;]*\bT4\b/u.test(readFileSync(file, 'utf8')))).toEqual([])
  expect(Object.values(table.stageHarness).flat().filter(id => id !== '*' && !table.stages.some(stage => stage.id === id))).toEqual([])
})

it('reads changed JSON fields as dotted paths, without descending into arrays', () => {
  expect(changedFields({ version: '0.1.18', name: 'x' }, { version: '0.1.19', name: 'x' })).toEqual(['version'])
  expect(changedFields({ a: { b: 1, c: [1] } }, { a: { b: 1, c: [2] }, d: true })).toEqual(['a.c', 'd'])
  expect(changedFields({ a: { b: 1 } }, { a: 2 })).toEqual(['a'])
  expect(changedFields(undefined, { a: 1 })).toEqual([''])
})

it('runs only the always-on release gate when the diff is version metadata', () => {
  expect(run(
    { path: 'package.json', fields: ['version'] },
    { path: 'release-policy.json', fields: ['compatibility.source.min', 'compatibility.source.maxExclusive', 'acceptancePolicy.ticket'] },
  )).toEqual(only())
  // Metadata never hides a parent replacement or an added/removed field file.
  expect(run({ path: 'release-policy.json', fields: ['compatibility'] })).toMatchObject({ fullUpgrade: true, cleanInstall: true })
  expect(run({ path: 'package.json', fields: [''] })).toEqual(every())
})

it('treats other policy fields as installer and upgrade behavior', () => {
  expect(run({ path: 'release-policy.json', fields: ['compatibility.sourceDshRevisions'] })).toEqual(only('fullUpgrade', 'cleanInstall'))
})

it('separates the DSH revision from every other runtime version for the clean install', () => {
  expect(run({ path: 'runtime-versions.json', fields: ['dsh.revision'] })).toEqual(only('fullUpgrade', 'native'))
  expect(run({ path: 'runtime-versions.json', fields: ['nodeLinuxAmd64.sha256'] })).toMatchObject({ cleanInstall: true })
  expect(run({ path: 'runtime-versions.json', fields: ['python'] })).toMatchObject({ cleanInstall: true })
})

it('triggers every stage for build inputs that shape all delivered bytes', () => {
  for (const path of ['tsconfig.build.json', '.node-version', 'pnpm-lock.yaml', '.github/workflows/candidate.yml', '.github/workflows/linux-t2.yml']) {
    expect(run({ path }), path).toEqual(every())
  }
  expect(run({ path: 'package.json', fields: ['dependencies.ws'] })).toEqual(every())
})

it('routes installer, storage and entry changes to the stages that exercise them', () => {
  expect(run({ path: 'scripts/install/installer_release.py' })).toEqual(only('fullUpgrade', 'offlineTransport', 'https', 'cleanInstall'))
  expect(run({ path: 'scripts/install/installer_storage.py' })).toMatchObject({ offlineTransport: true })
  for (const path of ['src/adapters/community-account-store.ts', 'src/adapters/community-maintenance.ts', 'src/adapters/user-storage-copy.ts', 'src/dsh/web-tools.ts']) {
    expect(run({ path }), path).toMatchObject({ fullUpgrade: true, native: true })
  }
  for (const path of ['src/inbound/platform-session.ts', 'src/inbound/http-entry.ts', 'src/adapters/community-env-config.ts', 'src/composition/community-application.ts']) {
    expect(run({ path }), path).toMatchObject({ https: true, native: true })
  }
  expect(run({ path: 'src/domain/suite-catalog.ts' })).toEqual(only('native'))
})

it('reruns only the stages whose entry tests reference a changed harness file', () => {
  const closures = { cleanInstall: ['tests/installer-ubuntu.e2e.ts', 'tests/support/acceptance-progress.ts'], fullUpgrade: ['tests/installed-system-upgrade.e2e.ts', 'tests/support/acceptance-progress.ts'] }
  const own = classifyStages([{ path: 'tests/installer-ubuntu.e2e.ts' }], table, closures)
  expect(runs(own)).toEqual(only('cleanInstall'))
  expect(own.stages.find(stage => stage.id === 'cleanInstall')?.reasons).toEqual([{ path: 'tests/installer-ubuntu.e2e.ts', kind: 'harness' }])
  // Shared support reaches the installer-only clean install only through its own entry file.
  expect(runs(classifyStages([{ path: 'tests/support/acceptance-progress.ts' }], table, closures))).toEqual(only('fullUpgrade'))
  expect(runs(classifyStages([{ path: 'tests/fixtures/community-native-browser.ts' }], table, { cleanInstall: ['tests/installer-ubuntu.e2e.ts', 'tests/fixtures/community-native-browser.ts'] }))).toEqual(only())
  // Harness outside every T4 closure (T3 scripts, CI steps, unit specs) needs no T4 stage; the E2E runner config is used by all.
  const unused = classifyStages([{ path: 'scripts/dev/vm.sh' }, { path: 'tests/t2-host.spec.ts' }, { path: '.github/workflows/ci.yml' }], table, closures)
  expect(runs(unused)).toEqual(only())
  expect(unused.changes.map(change => change.kind)).toEqual(['harnessUnused', 'harnessUnused', 'harnessUnused'])
  // The upgrade stages boot the formal baseline snapshot; the clean install starts from pristine Ubuntu instead.
  expect(runs(classifyStages([{ path: 'scripts/validation/t4-baseline.mjs' }], table, closures))).toEqual(only('releaseGate', 'fullUpgrade', 'offlineTransport'))
  expect(run({ path: 'vitest.e2e.config.ts' })).toEqual(every())
  // Each promotion adds the previous formal record; the always-on release gate owns the new baseline, nothing else reruns.
  const record = classifyStages([{ path: 'releases/acceptance/0.1.19.json' }, { path: 'releases/notes/0.1.20.md' }], table)
  expect(runs(record)).toEqual(only())
  expect(record.changes.map(change => change.kind)).toEqual(['harness', 'noStage'])
  expect(record.stages.find(stage => stage.id === 'releaseGate')?.reasons).toEqual([{ path: 'releases/acceptance/0.1.19.json', kind: 'harness' }])
})

it('conservatively triggers every stage for an unlisted path and reports each path class', () => {
  const result = classifyStages([{ path: 'tools/new-thing.sh' }, { path: 'docs/install.md' }, { path: 'package.json', fields: ['version'] }], table)
  expect(result.stages.every(stage => stage.run)).toBe(true)
  expect(result.unlisted).toEqual(['tools/new-thing.sh'])
  expect(result.changes).toEqual([
    { path: 'tools/new-thing.sh', kind: 'unlisted' },
    { path: 'docs/install.md', kind: 'noStage' },
    { path: 'package.json', fields: ['version'], kind: 'versionMetadata' },
  ])
})

// Real deliverable diff of formal 0.1.18 (8cfa66b) to the accepted 0.1.19 bytes (5b45ebc), frozen because CI checkouts are shallow.
it('classifies the real 0.1.19 deliverable diff: clean install and offline transport have no deliverable reason', () => {
  const fixture = JSON.parse(readFileSync('tests/fixtures/t4-stages/0.1.19-deliverables.json', 'utf8')) as { changes: StageChange[] }
  const result = classifyStages(fixture.changes, table)
  expect(result.unlisted).toEqual([])
  expect(runs(result)).toEqual(only('fullUpgrade', 'native', 'https'))
  expect(result.stages.find(stage => stage.id === 'fullUpgrade')?.reasons.filter(reason => reason.path === 'runtime-versions.json'))
    .toEqual([{ path: 'runtime-versions.json', kind: 'deliverable', pattern: 'runtime-versions.json', fields: ['dsh.revision'] }])
  expect(result.changes.filter(change => change.kind === 'versionMetadata').map(change => change.path)).toEqual(['package.json', 'release-policy.json'])
})

it('follows imports, re-exports and new URL file references into the harness closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 't4-closure-'))
  try {
    const { write, commit } = repository(root)
    await write('tests/a.e2e.ts', "import { b } from './support/b.js'\nexport * from './support/c.js'\nconst overlay = new URL('./fixtures/overlay.yml', import.meta.url)\nvoid b; void overlay\n")
    await write('tests/support/b.ts', "export const b = await readFile(new URL('../fixtures/probe.mjs', import.meta.url))\n")
    await write('tests/support/c.ts', 'export const c = 1\n')
    await write('tests/fixtures/overlay.yml', 'a: 1\n')
    await write('tests/fixtures/probe.mjs', 'export {}\n')
    await write('tests/fixtures/unused.mjs', 'export {}\n')
    expect(importClosure(['tests/a.e2e.ts'], commit('closure'), root))
      .toEqual(['tests/a.e2e.ts', 'tests/fixtures/overlay.yml', 'tests/fixtures/probe.mjs', 'tests/support/b.ts', 'tests/support/c.ts'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('compares deliverables with the tested source and each stage harness with the harness it ran', async () => {
  const root = await mkdtemp(join(tmpdir(), 't4-stages-'))
  try {
    const { write, commit } = repository(root)
    await write('package.json', JSON.stringify({ name: 'dsh-phalanx', version: '0.1.18', type: 'module' }))
    await write('runtime-versions.json', JSON.stringify({ node: '24.21.0', dsh: { revision: '1517a4d' } }))
    await write('release-policy.json', '{ also not json')
    await write('tests/installer-ubuntu.e2e.ts', "import { model } from './fixtures/community-model.js'\nvoid model\n")
    await write('tests/fixtures/community-model.ts', 'export const model = 1\n')
    await write('tests/installed-system-upgrade.e2e.ts', 'export {}\n')
    const formal = commit('formal')
    await write('tests/fixtures/community-model.ts', 'export const model = 2\n')
    const harness = commit('clean-install harness that ran')
    await write('package.json', JSON.stringify({ name: 'dsh-phalanx', version: '0.1.19', type: 'module' }))
    await write('runtime-versions.json', JSON.stringify({ node: '24.21.0', dsh: { revision: '687f282' } }))
    await write('release-policy.json', '{ not json')
    const candidate = commit('candidate')
    // Unparsable JSON is a whole-file change, never a field named after the parse failure.
    expect(diffChanges(formal, candidate, table, root).find(change => change.path === 'release-policy.json')).toEqual({ path: 'release-policy.json', fields: [''] })
    const classify = (...extra: string[]) => {
      // Run from a subdirectory: the CLI must resolve the repository root itself.
      const result = spawnSync(process.execPath, [resolve('scripts/validation/t4-stages.mjs'), formal, candidate, ...extra], { cwd: join(root, 'tests'), encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout) as StageResult & { harnessBases: Record<string, string> }
    }
    // A fixture imported by the clean-install entry is shared support, not installer behavior.
    expect(classify('--harness-base', formal).stages.find(stage => stage.id === 'cleanInstall')?.reasons.filter(reason => reason.kind === 'harness')).toEqual([])
    const exact = classify('--harness-base', formal, '--harness-base', `cleanInstall=${harness}`)
    expect(exact.harnessBases).toMatchObject({ cleanInstall: harness, native: formal })
    // The unparsable policy reaches every policy-tracked stage.
    expect(runs(exact)).toEqual(only('fullUpgrade', 'native', 'cleanInstall'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

function repository(root: string) {
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q', '-b', 'main')
  return {
    write: async (path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text) },
    commit: (message: string) => {
      git('add', '.')
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', message)
      return git('rev-parse', 'HEAD')
    },
  }
}
