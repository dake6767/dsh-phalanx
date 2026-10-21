import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HostPreparationCache } from '../src/adapters/host-preparation-cache.js'
it('coalesces preparation, reuses complete outputs and invalidates changed files or inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preparation-')), source = join(root, 'source'), output = join(root, 'output'), cache = new HostPreparationCache()
  let calls = 0
  try {
    await writeFile(source, 'one')
    const run = (version: number) => cache.prepare('member', version, [source], [output], async () => { calls++; await writeFile(output, String(calls)); return calls }, () => true)
    expect(await Promise.all([run(0), run(0)])).toEqual([1, 1]); expect(calls).toBe(1)
    await writeFile(source, 'two-changed'); await run(0); expect(calls).toBe(2)
    await rm(output); await run(0); expect(calls).toBe(3)
    await run(1); expect(calls).toBe(4)
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('never remembers failed or incomplete preparation as reusable', async () => {
  const cache = new HostPreparationCache()
  let calls = 0
  const run = () => cache.prepare('member', 0, [], [], async () => { calls++; if (calls === 1) throw Error('failed'); return { complete: calls > 2 } }, value => value.complete)
  await expect(run()).rejects.toThrow('failed')
  expect(await run()).toEqual({ complete: false }); expect(await run()).toEqual({ complete: true }); await run()
  expect(calls).toBe(3)
})
