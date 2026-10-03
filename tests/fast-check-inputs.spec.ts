import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { trackedEvidenceInputs } from '../scripts/fast-check-inputs.mjs'

describe('tracked validation inputs', () => {
  let root: string | undefined
  afterEach(async () => { if (root !== undefined) await rm(root, { recursive: true, force: true }) })

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
})
