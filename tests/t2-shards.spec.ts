import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import selection from '../scripts/validation/t2-selection.json' with { type: 'json' }

it.each(['amd64', 'arm64'])('requires every %s shard and the complete frozen result set before handing off an artifact', async architecture => {
  const root = await mkdtemp(join(tmpdir(), 't2-shards-'))
  try {
    const plan = JSON.parse(spawnSync(process.execPath, ['scripts/validation/t2-plan.mjs'], { encoding: 'utf8' }).stdout)
    const identity = {
      sourceCommit: 'a'.repeat(40),
      runId: '123',
      runAttempt: '1',
      platform: 'linux/' + architecture,
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

it('binds arm64 shard identity to the native platform and exact prepared archive bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 't2-arm64-identity-'))
  const { createHash } = await import('node:crypto')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const names = ['dsh-phalanx-linux-arm64.tar.gz', 'dsh-phalanx-dsh-linux-arm64.oci.tar']
  const commit = 'b'.repeat(40)
  const digest = 'sha256:' + 'a'.repeat(64)
  const manifest = {
    schema: 1,
    tag: 'v0.1.0-rc.1',
    targetVersion: '0.1.0',
    commit,
    platform: 'linux/arm64',
    runId: '123',
    dshRevision: 'c'.repeat(40),
    toolchain: { node: '24.21.0', pnpm: '11.19.0' },
    image: { name: 'ghcr.io/dake6767/dsh-phalanx', tag: '0.1.0-rc.1', digest, reference: 'ghcr.io/dake6767/dsh-phalanx@' + digest },
    files: Object.fromEntries(names.map(name => [name, hash(name)])),
  }
  const invoke = (platform: string) =>
    spawnSync(process.execPath, ['scripts/validation/t2-shards.mjs', 'identity', root, commit, '123', '1', platform], { encoding: 'utf8' })
  try {
    for (const name of names) await writeFile(join(root, name), name)
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
    const identity = invoke('linux/arm64')
    expect(identity.status, identity.stderr).toBe(0)
    expect(JSON.parse(identity.stdout)).toMatchObject({ platform: 'linux/arm64', sourceCommit: commit, runId: '123', runAttempt: '1' })
    expect(invoke('linux/amd64').status).not.toBe(0)
    await writeFile(join(root, names[0]!), 'changed platform bytes')
    expect(invoke('linux/arm64').status).not.toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
