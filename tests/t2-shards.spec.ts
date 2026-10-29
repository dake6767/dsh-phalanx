import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import selection from '../scripts/validation/t2-selection.json' with { type: 'json' }

it('requires every planned shard and validates the complete frozen result set before handing off an artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 't2-shards-'))
  try {
    const plan = JSON.parse(spawnSync(process.execPath, ['scripts/validation/t2-plan.mjs'], { encoding: 'utf8' }).stdout)
    const identity = {
      sourceCommit: 'a'.repeat(40),
      runId: '123',
      runAttempt: '1',
      manifestSha256: 'b'.repeat(64),
      archiveSha256: 'c'.repeat(64),
      platformSha256: 'd'.repeat(64),
    }
    await writeFile(join(root, 'identity.json'), JSON.stringify(identity))
    await writeFile(join(root, 'plan.json'), JSON.stringify(plan))
    const invoke = () =>
      spawnSync(process.execPath, ['scripts/validation/t2-shards.mjs', 'verify', root, join(root, 'identity.json'), join(root, 'plan.json')], {
        encoding: 'utf8',
      })
    const receipts = []
    for (const shard of plan.shards) {
      const dir = join(root, String(shard.index))
      await mkdir(dir)
      await writeFile(join(dir, 'cleanup.json'), JSON.stringify({ result: 'passed', errors: [] }))
      const tests = shard.files.map((file: string) => ({
        name: '/source/' + file,
        assertionResults: Array.from({ length: selection.regularFileCases[file as keyof typeof selection.regularFileCases] }, () => ({ status: 'passed' })),
      }))
      await writeFile(
        join(dir, 'linux.json'),
        JSON.stringify({ success: true, numFailedTests: 0, numPendingTests: 0, numPassedTests: shard.cases, testResults: tests }),
      )
      const receipt = {
        ...shard,
        identity,
        inventoryHash: plan.inventoryHash,
        regularReport: 'linux.json',
      }
      receipts.push(receipt)
      await writeFile(join(dir, 'shard.json'), JSON.stringify(receipt))
      if (shard.index < 4) expect(invoke().status).not.toBe(0)
    }
    const passed = invoke()
    expect(passed.status, passed.stderr).toBe(0)
    for (const identityKey of Object.keys(identity)) {
      const bad = structuredClone(receipts[0]!)
      bad.identity[identityKey as keyof typeof identity] = 'wrong'
      await writeFile(join(root, '1/shard.json'), JSON.stringify(bad))
      expect(invoke().status).not.toBe(0)
    }
    await writeFile(join(root, '1/shard.json'), JSON.stringify(receipts[0]))
    for (const patch of [{ index: 2 }, { files: ['tests/installed-candidate.e2e.ts'] }, { regularReport: null }, { inventoryHash: 'wrong' }]) {
      await writeFile(join(root, '1/shard.json'), JSON.stringify({ ...receipts[0], ...patch }))
      expect(invoke().status).not.toBe(0)
    }
    await writeFile(join(root, '1/shard.json'), JSON.stringify(receipts[0]))
    await writeFile(join(root, '1/cleanup.json'), JSON.stringify({ result: 'failed', errors: ['cleanup failed'] }))
    expect(invoke().status).not.toBe(0)
    await writeFile(join(root, '1/cleanup.json'), JSON.stringify({ result: 'passed', errors: [] }))
    const report = JSON.parse(await readFile(join(root, '2/linux.json'), 'utf8'))
    report.testResults[0].assertionResults[0].status = 'skipped'
    await writeFile(join(root, '2/linux.json'), JSON.stringify(report))
    expect(invoke().status).not.toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
