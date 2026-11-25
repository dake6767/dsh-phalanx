import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { trackedEvidenceInputs } from '../scripts/fast-check-inputs.mjs'
import {
  evidenceFileGroups,
  evidenceInputDigest,
  fastCheckConfigurationDigest,
  resolveBrowserMaxWorkers,
  resolveValidationMaxWorkers,
  verifyBrowserReportCompleteness,
} from '../scripts/fast-check-policy.mjs'

describe('tracked validation inputs', () => {
  let root: string | undefined
  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true })
      root = undefined
    }
  })

  it('reads Git content and mode while leaving docs and unrelated tests out of a focused key', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-phalanx-validation-inputs-'))
    execFileSync('git', ['init', '-q', root])
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'tests'))
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'src', 'app.ts'), 'product')
    await writeFile(join(root, 'tests', 'a.e2e.ts'), 'test a')
    await writeFile(join(root, 'tests', 'b.e2e.ts'), 'test b')
    await writeFile(join(root, 'docs', 'design.md'), 'docs a')
    execFileSync('git', ['-C', root, 'add', '.'])
    const first = trackedEvidenceInputs(root)
    await writeFile(join(root, 'docs', 'design.md'), 'docs b')
    execFileSync('git', ['-C', root, 'add', '.'])
    expect(trackedEvidenceInputs(root)).toEqual(first)
    await writeFile(join(root, 'tests', 'b.e2e.ts'), 'test b changed')
    execFileSync('git', ['-C', root, 'add', '.'])
    const changedTest = trackedEvidenceInputs(root)
    expect(changedTest.tests['tests/a.e2e.ts']).toBe(first.tests['tests/a.e2e.ts'])
    expect(changedTest.tests['tests/b.e2e.ts']).not.toBe(first.tests['tests/b.e2e.ts'])
    await chmod(join(root, 'src', 'app.ts'), 0o755)
    execFileSync('git', ['-C', root, 'add', '.'])
    expect(trackedEvidenceInputs(root).productDigest).not.toBe(first.productDigest)
  })

  it('excludes releases/notes/*.md and releases/acceptance/* without excluding non-doc release files', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-phalanx-validation-releases-'))
    execFileSync('git', ['init', '-q', root])
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'releases', 'notes'), { recursive: true })
    await mkdir(join(root, 'releases', 'acceptance'), { recursive: true })
    await writeFile(join(root, 'src', 'app.ts'), 'product')
    await writeFile(join(root, 'release-policy.json'), '{"v":1}')
    await writeFile(join(root, 'releases', 'notes', 'v0.1.42.md'), 'notes v1')
    await writeFile(join(root, 'releases', 'acceptance', 'v0.1.42.md'), 'acceptance v1')
    execFileSync('git', ['-C', root, 'add', '.'])
    const first = trackedEvidenceInputs(root)

    await writeFile(join(root, 'releases', 'notes', 'v0.1.42.md'), 'notes v2')
    await writeFile(join(root, 'releases', 'acceptance', 'v0.1.42.md'), 'acceptance v2')
    await writeFile(join(root, 'releases', 'acceptance', 'receipt.json'), '{"ok":true}')
    execFileSync('git', ['-C', root, 'add', '.'])
    expect(trackedEvidenceInputs(root)).toEqual(first)

    const groups = evidenceFileGroups([
      'releases/notes/v0.1.42.md',
      'releases/notes/nested/file.md',
      'releases/acceptance/v0.1.42.md',
      'releases/acceptance/sub/receipt.json',
      'releases/manifest.json',
      'release-policy.json',
    ])
    expect(groups.product).toEqual(['release-policy.json', 'releases/manifest.json', 'releases/notes/nested/file.md'])

    await writeFile(join(root, 'release-policy.json'), '{"v":2}')
    execFileSync('git', ['-C', root, 'add', '.'])
    expect(trackedEvidenceInputs(root).productDigest).not.toBe(first.productDigest)
  })

  it('resolves safe validation worker counts for <=16 GiB hosts and explicit overrides', () => {
    const gib16 = 16 * 2 ** 30
    const gib32 = 32 * 2 ** 30
    expect(resolveValidationMaxWorkers(undefined, gib16)).toBe('2')
    expect(resolveValidationMaxWorkers('', 8 * 2 ** 30)).toBe('2')
    expect(resolveValidationMaxWorkers(undefined, gib32)).toBe('default')
    expect(resolveValidationMaxWorkers('1', gib16)).toBe('1')
    expect(resolveValidationMaxWorkers(' 4 ', gib16)).toBe('4')
    expect(() => resolveValidationMaxWorkers('   ', gib16)).toThrow()
    expect(() => resolveValidationMaxWorkers('0', gib16)).toThrow()
    expect(() => resolveValidationMaxWorkers('-1', gib16)).toThrow()
    expect(() => resolveValidationMaxWorkers('1.5', gib16)).toThrow()
    expect(() => resolveValidationMaxWorkers('99999999999999999999', gib16)).toThrow()
    expect(() => resolveValidationMaxWorkers('abc', gib16)).toThrow()
    expect(() => resolveValidationMaxWorkers(undefined, 0)).toThrow()
    expect(() => resolveValidationMaxWorkers(undefined, Number.NaN)).toThrow()

    expect(resolveBrowserMaxWorkers(undefined)).toBe('2')
    expect(resolveBrowserMaxWorkers('')).toBe('2')
    expect(resolveBrowserMaxWorkers('1')).toBe('1')
    expect(resolveBrowserMaxWorkers(' 3 ')).toBe('3')
    expect(() => resolveBrowserMaxWorkers('   ')).toThrow()
    expect(() => resolveBrowserMaxWorkers('0')).toThrow()
    expect(() => resolveBrowserMaxWorkers('99999999999999999999')).toThrow()

    const baseCfg = { nodeVersion: 'v24.0.0', platform: 'darwin', arch: 'arm64' }
    const cfg2 = fastCheckConfigurationDigest({ ...baseCfg, maxWorkers: '2' })
    const cfg4 = fastCheckConfigurationDigest({ ...baseCfg, maxWorkers: '4' })
    const cfgDefault = fastCheckConfigurationDigest({ ...baseCfg, maxWorkers: 'default' })
    expect(cfg2).not.toBe(cfg4)
    expect(cfg2).not.toBe(cfgDefault)

    const sampleInputs = {
      productDigest: 'p1',
      imageId: 'controlled-browser-no-image',
      runnerDigest: 'r1',
      configDigest: cfg2,
      sharedTestDigest: 's1',
      tests: { 'tests/a.e2e.ts': 'a1', 'tests/b.e2e.ts': 'b1' },
    }
    const aDigest1 = evidenceInputDigest(sampleInputs, ['tests/a.e2e.ts'])
    const bDigest1 = evidenceInputDigest(sampleInputs, ['tests/b.e2e.ts'])
    const aDigest2 = evidenceInputDigest({ ...sampleInputs, tests: { 'tests/a.e2e.ts': 'a1', 'tests/b.e2e.ts': 'b2' } }, ['tests/a.e2e.ts'])
    const aDigestCfgChanged = evidenceInputDigest({ ...sampleInputs, configDigest: cfg4 }, ['tests/a.e2e.ts'])
    expect(aDigest2).toBe(aDigest1)
    expect(aDigestCfgChanged).not.toBe(aDigest1)
    expect(bDigest1).not.toBe(aDigest1)
  })

  it('verifies browser JSON report completeness before persisting cache entries', () => {
    const fakeRoot = '/repo'
    const expected = ['tests/a.e2e.ts', 'tests/b.e2e.ts']
    expect(
      verifyBrowserReportCompleteness(
        {
          success: true,
          numRuntimeErrorTestSuites: 0,
          testResults: [
            { name: '/repo/tests/a.e2e.ts', status: 'passed' },
            { name: '/repo/tests/b.e2e.ts', status: 'passed' },
          ],
        },
        expected,
        fakeRoot,
      ).complete,
    ).toBe(true)

    expect(
      verifyBrowserReportCompleteness(
        {
          success: true,
          numRuntimeErrorTestSuites: 0,
          testResults: [{ name: '/repo/tests/a.e2e.ts', status: 'passed' }],
        },
        expected,
        fakeRoot,
      ).complete,
    ).toBe(false)

    expect(
      verifyBrowserReportCompleteness(
        {
          success: true,
          numRuntimeErrorTestSuites: 1,
          testResults: [
            { name: '/repo/tests/a.e2e.ts', status: 'passed' },
            { name: '/repo/tests/b.e2e.ts', status: 'passed' },
          ],
        },
        expected,
        fakeRoot,
      ).complete,
    ).toBe(false)

    expect(
      verifyBrowserReportCompleteness(
        {
          success: true,
          numRuntimeErrorTestSuites: 0,
          testResults: [
            { name: '/repo/tests/a.e2e.ts', status: 'passed' },
            { name: '/repo/tests/b.e2e.ts', status: 'failed' },
          ],
        },
        expected,
        fakeRoot,
      ).complete,
    ).toBe(false)
  })
})
