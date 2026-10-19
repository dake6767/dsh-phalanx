import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { changedFields, classifyStages, type StageResult, type StageTable } from '../scripts/validation/t4-stages.mjs'

const table = JSON.parse(readFileSync('scripts/validation/t4-stages.json', 'utf8')) as StageTable
const run = (...changes: Parameters<typeof classifyStages>[0]) => {
  const result = classifyStages(changes, table)
  return Object.fromEntries(result.stages.map(stage => [stage.id, stage.run]))
}

it('keeps the stage table consistent with the tracked T4 entry tests', () => {
  expect(new Set(table.stages.map(stage => stage.id)).size).toBe(table.stages.length)
  const entries = table.stages.flatMap(stage => stage.entries)
  expect(entries.filter(file => !/^\/\/ Validation: [^;]*\bT4\b/u.test(readFileSync(file, 'utf8')))).toEqual([])
})

it('reads changed JSON fields as dotted paths, without descending into arrays', () => {
  expect(changedFields({ version: '0.1.18', name: 'x' }, { version: '0.1.19', name: 'x' })).toEqual(['version'])
  expect(changedFields({ a: { b: 1, c: [1] } }, { a: { b: 1, c: [2] }, d: true })).toEqual(['a.c', 'd'])
  expect(changedFields(undefined, { a: 1 })).toEqual([''])
})

it('runs only the always-on smoke when the diff is version metadata', () => {
  const versionOnly = run(
    { path: 'package.json', fields: ['version'] },
    { path: 'release-policy.json', fields: ['compatibility.source.min', 'compatibility.source.maxExclusive', 'acceptancePolicy.ticket'] },
  )
  expect(versionOnly).toEqual({ smoke: true, fullUpgrade: false, offlineTransport: false, native: false, https: false, cleanInstall: false })
})

it('treats other policy fields as installer and upgrade behavior', () => {
  const result = run({ path: 'release-policy.json', fields: ['compatibility.sourceDshRevisions'] })
  expect(result).toMatchObject({ fullUpgrade: true, cleanInstall: true, native: false })
})

it('separates the DSH revision from the clean-install Node runtime', () => {
  expect(run({ path: 'runtime-versions.json', fields: ['dsh.revision'] })).toMatchObject({ fullUpgrade: true, native: true, cleanInstall: false })
  expect(run({ path: 'runtime-versions.json', fields: ['nodeLinuxAmd64.sha256'] })).toMatchObject({ cleanInstall: true })
})

it('triggers the installer stages and offline transport on installer changes', () => {
  expect(run({ path: 'scripts/install/installer_release.py' })).toMatchObject({ cleanInstall: true, offlineTransport: true, fullUpgrade: true, https: true, native: false })
})

it('reruns only the stages whose entry tests import a changed harness file', () => {
  const closures = { cleanInstall: ['tests/installer-ubuntu.e2e.ts', 'tests/support/acceptance-progress.ts'], fullUpgrade: ['tests/installed-system-upgrade.e2e.ts', 'tests/support/acceptance-progress.ts'] }
  const own = classifyStages([{ path: 'tests/installer-ubuntu.e2e.ts' }], table, closures)
  expect(Object.fromEntries(own.stages.map(stage => [stage.id, stage.run]))).toMatchObject({ cleanInstall: true, native: false, fullUpgrade: false })
  expect(own.stages.find(stage => stage.id === 'cleanInstall')?.reasons).toEqual([{ path: 'tests/installer-ubuntu.e2e.ts', kind: 'harness' }])
  const shared = classifyStages([{ path: 'tests/support/acceptance-progress.ts' }], table, closures)
  expect(Object.fromEntries(shared.stages.map(stage => [stage.id, stage.run]))).toMatchObject({ cleanInstall: true, fullUpgrade: true, native: false })
  // Harness outside every T4 import closure (T3 scripts, CI steps, unit specs) needs no T4 stage.
  expect(classifyStages([{ path: 'scripts/dev/vm.sh' }, { path: 'tests/t2-host.spec.ts' }, { path: '.github/workflows/ci.yml' }], table, closures).stages
    .filter(stage => stage.run).map(stage => stage.id)).toEqual(['smoke'])
})

it('conservatively triggers every stage for an unlisted path and reports it', () => {
  const result = classifyStages([{ path: 'tools/new-thing.sh' }], table)
  expect(result.stages.every(stage => stage.run)).toBe(true)
  expect(result.unlisted).toEqual(['tools/new-thing.sh'])
})

it('ignores documentation and lint-only paths', () => {
  expect(run({ path: 'docs/install.md' }, { path: 'releases/notes/0.1.19.md' }, { path: 'scripts/architecture-eslint.mjs' }))
    .toMatchObject({ smoke: true, fullUpgrade: false, native: false, cleanInstall: false })
})

// Shape of the 0.1.18 → 0.1.19 diff (8cfa66b..5b45ebc, harness base bb220a9) in a disposable repository;
// CI checkouts are shallow, so the real commits cannot be assumed.
it('reads a release-shaped Git diff: deliverables against the tested source, harness against the harness that ran', async () => {
  const root = await mkdtemp(join(tmpdir(), 't4-stages-'))
  try {
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
      return result.stdout.trim()
    }
    const write = async (path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text) }
    const commit = (message: string) => {
      git('add', '.')
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', message)
      return git('rev-parse', 'HEAD')
    }
    git('init', '-q', '-b', 'main')
    const policy = (min: string, ticket: number) => JSON.stringify({ compatibility: { protocol: 3, source: { min, maxExclusive: '0.1.' + (Number(min.split('.')[2]) + 1) }, sourceDshRevisions: ['a'] }, acceptancePolicy: { ticket, checks: ['ci'] } })
    await write('package.json', JSON.stringify({ name: 'dsh-phalanx', version: '0.1.18', type: 'module' }))
    await write('release-policy.json', policy('0.1.17', 13))
    await write('runtime-versions.json', JSON.stringify({ node: '24.21.0', dsh: { revision: '1517a4d' } }))
    await write('scripts/install/installer.py', 'install\n')
    await write('src/inbound/public-server.ts', 'export const server = 1\n')
    await write('tests/installer-ubuntu.e2e.ts', "import { model } from './fixtures/community-model.js'\nvoid model\n")
    await write('tests/fixtures/community-model.ts', 'export const model = 1\n')
    await write('tests/installed-system-upgrade.e2e.ts', 'export {}\n')
    const formal = commit('formal 0.1.18')
    await write('tests/fixtures/community-model.ts', 'export const model = 2\n')
    const harness = commit('clean-install harness that ran')
    await write('package.json', JSON.stringify({ name: 'dsh-phalanx', version: '0.1.19', type: 'module' }))
    await write('release-policy.json', policy('0.1.18', 11))
    await write('runtime-versions.json', JSON.stringify({ node: '24.21.0', dsh: { revision: '687f282' } }))
    await write('src/inbound/public-server.ts', 'export const server = 2\n')
    await write('docs/install.md', 'notes\n')
    const candidate = commit('candidate 0.1.19')
    const classify = (...extra: string[]) => {
      const result = spawnSync(process.execPath, [resolve('scripts/validation/t4-stages.mjs'), formal, candidate, ...extra], { cwd: root, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout) as StageResult & { harnessBase: string }
    }
    const runs = (report: StageResult) => Object.fromEntries(report.stages.map(stage => [stage.id, stage.run]))
    const reran = classify('--harness-base', formal)
    expect(reran.harnessBase).toBe(formal)
    expect(reran.stages.find(stage => stage.id === 'cleanInstall')?.reasons).toEqual([{ path: 'tests/fixtures/community-model.ts', kind: 'harness' }])
    const exact = classify('--harness-base', harness)
    expect(exact.unlisted).toEqual([])
    expect(runs(exact)).toEqual({ smoke: true, fullUpgrade: true, offlineTransport: false, native: true, https: true, cleanInstall: false })
    // Version and source-interval bumps drop out; only the DSH revision drives the upgrade stage.
    expect(exact.stages.find(stage => stage.id === 'fullUpgrade')?.reasons).toEqual([
      { path: 'runtime-versions.json', kind: 'deliverable', pattern: 'runtime-versions.json', fields: ['dsh.revision'] },
    ])
  } finally { await rm(root, { recursive: true, force: true }) }
})
