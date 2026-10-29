import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('recovers an interleaved receipt from its immutable guest file without rerunning cases', () => {
  const result = spawnSync('python3', ['tests/fixtures/development-receipt.py'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
})

it('returns after lock acquisition, rejects a concurrent run and retains the finished receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-background-'))
  try {
    const entry = join(root, 'scripts/dev/linux.py'),
      state = join(root, 'state')
    await mkdir(join(root, 'scripts/dev'), { recursive: true })
    await copyFile(resolve('scripts/dev/linux.py'), entry)
    await writeFile(
      join(root, 'scripts/dev/vm.sh'),
      `#!/bin/bash
set -eu
if ! mkdir "$DSH_PHALANX_VALIDATION_STATE_ROOT/lock" 2>/dev/null; then echo 'occupied by existing operation'; exit 1; fi
trap 'rmdir "$DSH_PHALANX_VALIDATION_STATE_ROOT/lock"' EXIT
printf '%s\\n' "$$" > "$DSH_PHALANX_VM_READY_FILE"
sleep 2
printf '%s\\n' 'Linux acceptance receipt: {"runId":"123","status":"passed","files":[]}'
`,
    )
    const invoke = (...args: string[]) =>
      spawnSync('python3', [entry, ...args], { encoding: 'utf8', env: { ...process.env, DSH_PHALANX_VALIDATION_STATE_ROOT: state } })
    const started = invoke('start', '--files', 'tests/sample.e2e.ts')
    expect(started.status, started.stderr).toBe(0)
    const first = JSON.parse(started.stdout)
    expect(first.operationPid).toBeGreaterThan(0)
    const second = invoke('start', '--full')
    expect(second.status).toBe(1)
    const rejected = JSON.parse(second.stdout)
    expect(await readFile(rejected.log, 'utf8')).toContain('occupied')
    let finished
    for (let n = 0; n < 50; n++) {
      finished = JSON.parse(invoke('status', first.runId).stdout)
      if (finished.status === 'passed') break
      await new Promise(done => setTimeout(done, 100))
    }
    expect(finished.status).toBe('passed')
    expect(finished.acceptance.runId).toBe('123')
    expect(finished.arguments).toEqual(['--files', 'tests/sample.e2e.ts'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it('uses complete trees to distinguish Harness reuse from Deliverable rebuilds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-plan-'))
  try {
    const tree = (path: string, sha: string) => ({ truncated: false, tree: [{ path, sha: sha.repeat(40), mode: '100644', type: 'blob' }] })
    const before = join(root, 'before.json'),
      after = join(root, 'after.json')
    const invoke = () => spawnSync(process.execPath, [resolve('scripts/validation/development-plan.mjs'), before, after], { encoding: 'utf8' })
    for (const [file, rebuild] of [
      ['tests/sample.e2e.ts', false],
      ['src/example.ts', true],
      ['scripts/validation/t4-stages.json', true],
    ] as const) {
      await writeFile(before, JSON.stringify(tree(file, 'a')))
      await writeFile(after, JSON.stringify(tree(file, 'b')))
      expect(JSON.parse(invoke().stdout).rebuild).toBe(rebuild)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('revalidates retained file reports instead of trusting a passing execution summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-combined-'))
  try {
    const selection = JSON.parse(await readFile(resolve('scripts/validation/t2-selection.json'), 'utf8'))
    const file = selection.regular[0],
      count = selection.regularFileCases[file]
    const report = {
      success: true,
      numFailedTests: 0,
      numPassedTests: count,
      numPendingTests: 0,
      testResults: [{ name: '/prior/source/' + file, status: 'passed', assertionResults: Array.from({ length: count }, () => ({ status: 'passed' })) }],
    }
    const reportPath = join(root, 'first-report.json'),
      summary = join(root, 'summary.json')
    await writeFile(reportPath, JSON.stringify(report))
    await writeFile(summary, JSON.stringify({ expectedFiles: [file], files: [{ file, status: 'passed', report: reportPath }] }))
    const invoke = () => spawnSync(process.execPath, [resolve('scripts/validation/verify-development-results.mjs'), summary], { encoding: 'utf8' })
    expect(invoke().status).toBe(0)
    report.testResults[0]!.assertionResults[0]!.status = 'skipped'
    await writeFile(reportPath, JSON.stringify(report))
    expect(invoke().status).toBe(1)
    report.testResults[0]!.assertionResults[0]!.status = 'passed'
    await writeFile(reportPath, JSON.stringify(report))
    await writeFile(summary, JSON.stringify({ expectedFiles: [file, selection.regular[1]], files: [{ file, status: 'passed', report: reportPath }] }))
    expect(invoke().status).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('binds failed-file reruns to immutable bytes, provider reset and one persistent budget', () => {
  const result = spawnSync('python3', ['tests/fixtures/development-acceptance.py'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
})

it('invalidates retained file inputs for shared Harness changes but not another e2e file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-file-inputs-'))
  try {
    const tree = {
      truncated: false,
      tree: ['tests/a.e2e.ts', 'tests/b.e2e.ts', 'tests/support/shared.ts'].map(path => ({ path, mode: '100644', type: 'blob', sha: 'a'.repeat(40) })),
    }
    const path = join(root, 'tree.json')
    const plan = () => JSON.parse(spawnSync(process.execPath, [resolve('scripts/validation/development-plan.mjs'), path, path], { encoding: 'utf8' }).stdout)
    await writeFile(path, JSON.stringify(tree))
    const before = plan().fileInputs
    tree.tree[1]!.sha = 'b'.repeat(40)
    await writeFile(path, JSON.stringify(tree))
    const isolated = plan().fileInputs
    expect(isolated['tests/a.e2e.ts']).toBe(before['tests/a.e2e.ts'])
    expect(isolated['tests/b.e2e.ts']).not.toBe(before['tests/b.e2e.ts'])
    tree.tree[2]!.sha = 'b'.repeat(40)
    await writeFile(path, JSON.stringify(tree))
    expect(plan().fileInputs['tests/a.e2e.ts']).not.toBe(before['tests/a.e2e.ts'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('continues to the next regular file when a preceding file fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-file-order-'))
  try {
    const scripts = join(root, 'scripts/validation')
    await mkdir(scripts, { recursive: true })
    for (const name of ['t2.mjs', 't2-plan.mjs', 't2-selection.json', 'verify-linux-results.mjs'])
      await copyFile(resolve('scripts/validation', name), join(scripts, name))
    await writeFile(join(scripts, 'check-tiers.mjs'), '')
    await writeFile(join(scripts, 't2-shards.mjs'), 'export function record(){}')
    await writeFile(
      join(scripts, 'file-runner.mjs'),
      `import {mkdirSync,writeFileSync,appendFileSync,readFileSync} from 'node:fs';
export const fileIndex=(file,inventory)=>inventory.indexOf(file);
export const mergeReports=paths=>JSON.parse(readFileSync(paths[0],'utf8'));
export async function runFile({file,directory}) {
mkdirSync(directory,{recursive:true});appendFileSync('effects',file+'\\n');
const report=directory+'/report.json';writeFileSync(report,JSON.stringify({success:false,numFailedTests:1,numPassedTests:0,numPendingTests:0,testResults:[{name:file,status:'failed',assertionResults:[{title:'failed',status:'failed'}]}]}));writeFileSync(directory+'/output.log','');
return {file,directory,report,status:'failed',elapsedMs:1};}`,
    )
    const selection = JSON.parse(await readFile(join(scripts, 't2-selection.json'), 'utf8'))
    const script = join(scripts, 't2.mjs')
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `Object.defineProperty(process,'platform',{value:'linux'});process.getuid=()=>1000;process.argv=[process.execPath,${JSON.stringify(script)},'--files',${JSON.stringify(selection.regular.slice(0, 2).join(','))},${JSON.stringify(join(root, 'results'))}];await import(${JSON.stringify(new URL(`file://${script}`).href)});`,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          DSH_PHALANX_LINUX_FILE_RETRY: 'manual',
          DSH_PHALANX_CONTAINER_IMAGE: 'fixture',
          DSH_PHALANX_PRECHECK_IMAGE: 'fixture',
          DSH_PHALANX_INSTALL_ROOT: 'fixture',
          DSH_PHALANX_CANDIDATE_SHA: 'fixture',
        },
      },
    )
    expect(result.status).toBe(1)
    expect((await readFile(join(root, 'effects'), 'utf8')).trim().split('\n')).toEqual(selection.regular.slice(0, 2))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('queries a read-only root fixture for foreign-UID port ownership', () => {
  const result = spawnSync('python3', ['tests/fixtures/development-port-owners.py'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
})

it('reads a complete owned snapshot tree through the guest Git boundary', () => {
  const result = spawnSync('python3', ['tests/fixtures/development-source-tree.py'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
})

it('passes a scoped apt lock timeout to browser dependency preparation', () => {
  const result = spawnSync('python3', ['tests/fixtures/development-browser-deps.py'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
})

it('preserves a never-onboarded deployment before a rebuild and leaves an onboarded one in place', () => {
  const result = spawnSync('python3', ['tests/fixtures/development-uninitialized-rebuild.py'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
})

it('keeps every run receipt and only the latest failed run file trees', () => {
  const result = spawnSync('python3', ['tests/fixtures/development-result-retention.py'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
})

it('restores built source assets from the verified bundle after Harness activation', () => {
  const result = spawnSync('python3', ['tests/fixtures/development-build-assets.py'], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
})
