import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { expect, it } from 'vitest'

it.each([true, false])('reruns only failed Linux cases and preserves the retry budget (persistent failure: %s)', async persistent => {
  const root = await mkdtemp(join(tmpdir(), 't2-retries-'))
  try {
    await symlink(resolve('node_modules'), join(root, 'node_modules'))
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(join(root, 'vitest.e2e.config.ts'), 'export default { test: { include: ["*.e2e.ts"] } }')
    await writeFile(join(root, 'sample.e2e.ts'), `
      import { it, expect } from 'vitest'
      import { appendFileSync, existsSync, readFileSync } from 'node:fs'
      it('passed sibling', () => { appendFileSync('effects', 'passed\\n') })
      it('failed [case] (exact)', () => {
        const prior = existsSync('effects') ? readFileSync('effects', 'utf8') : ''
        appendFileSync('effects', 'retry\\n')
        expect(prior.split('retry\\n').length - 1).toBeGreaterThan(0)
      })
      it('persistent failure', () => { appendFileSync('effects', 'persistent\\n'); expect(${persistent}).toBe(false) })
    `)
    const initial = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.e2e.config.ts', '--reporter=json', '--outputFile=linux.json'], { cwd: root, encoding: 'utf8' })
    expect(initial.status).toBe(1)
    const original = await readFile(join(root, 'linux.json'), 'utf8')
    const result = spawnSync(process.execPath, [resolve('scripts/validation/retry-linux-cases.mjs'), join(root, 'linux.json')], { cwd: root, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(persistent ? 1 : 0)
    expect(await readFile(join(root, 'effects'), 'utf8')).toBe(persistent ? 'passed\nretry\npersistent\nretry\npersistent\npersistent\n' : 'passed\nretry\npersistent\nretry\n')
    expect(await readFile(join(root, 'linux.json'), 'utf8')).toBe(original)
    const confirmed = JSON.parse(await readFile(join(root, 'linux-confirmed.json'), 'utf8'))
    expect(confirmed.numPassedTests).toBe(persistent ? 2 : 3)
    expect(confirmed.numFailedTests).toBe(persistent ? 1 : 0)
    const receipt = JSON.parse(await readFile(join(root, 'linux-retries.json'), 'utf8'))
    expect(receipt.attempts.map((row: { status: string }) => row.status)).toEqual(persistent ? ['passed', 'failed', 'failed'] : ['passed'])
    // Reinvoking cannot reset the same failure's retry budget.
    const again = spawnSync(process.execPath, [resolve('scripts/validation/retry-linux-cases.mjs'), join(root, 'linux.json')], { cwd: root, encoding: 'utf8' })
    expect(again.status).toBe(1)
    expect(await readFile(join(root, 'effects'), 'utf8')).toBe(persistent ? 'passed\nretry\npersistent\nretry\npersistent\npersistent\n' : 'passed\nretry\npersistent\nretry\n')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

it('confirms controlled browser failures without requiring a running container engine or the first Linux port range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-retry-'))
  const occupied = createServer()
  await new Promise<void>((done, fail) => {
    occupied.once('error', error => { if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') done(); else fail(error) })
    occupied.listen(20007, '127.0.0.1', done)
  })
  try {
    await symlink(resolve('node_modules'), join(root, 'node_modules'))
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(join(root, 'vitest.e2e.config.ts'), 'export default {test:{include:["*.e2e.ts"]}}')
    await writeFile(join(root, 'sample.e2e.ts'), "import {it,expect} from 'vitest';import {existsSync} from 'node:fs';it('controlled',()=>expect(existsSync('ready')).toBe(true))")
    const initial = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.e2e.config.ts', '--reporter=json', '--outputFile=browser.json'], { cwd: root, encoding: 'utf8' })
    expect(initial.status).toBe(1)
    await writeFile(join(root, 'ready'), '')
    const runtime = join(root, 'podman')
    await writeFile(runtime, '#!/bin/sh\nprintf called >> "'+join(root, 'container-calls')+'"\nexit 71\n', { mode: 0o700 })
    const result = spawnSync(process.execPath, [resolve('scripts/validation/retry-linux-cases.mjs'), join(root, 'browser.json'), '--without-containers'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, DSH_PHALANX_CONTAINER_RUNTIME: runtime },
    })
    expect(result.status, result.stderr).toBe(0)
    await expect(readFile(join(root, 'container-calls'), 'utf8')).rejects.toThrow()
    const report = JSON.parse(await readFile(join(root, 'browser-confirmed.json'), 'utf8'))
    expect(report.numPassedTests).toBe(1)
  } finally {
    if (occupied.listening) await new Promise<void>(done => occupied.close(() => done()))
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
