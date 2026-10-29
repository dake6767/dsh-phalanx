import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('confirms only a failed quick case with its original configuration and keeps an exclusive retry ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quick-case-confirmation-'))
  try {
    await mkdir(join(root, 'tests'))
    await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'dir')
    await writeFile(join(root, 'vitest.config.ts'), 'export default { test: { include: ["tests/*.spec.ts"] } }\n')
    await writeFile(
      join(root, 'tests/example.spec.ts'),
      `import { it } from 'vitest'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
it('needs one confirmation', () => { if (!existsSync('once')) { writeFileSync('once', ''); throw Error('first failure') } })
it('already passed', () => appendFileSync('passed-count', 'x'))
`,
    )
    const report = join(root, 'first.json')
    const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
    const first = spawnSync(process.execPath, [vitest, 'run', '--maxWorkers=1', '--reporter=json', '--outputFile=' + report], { cwd: root, encoding: 'utf8' })
    expect(first.status, first.stderr).toBe(1)
    const retry = fileURLToPath(new URL('../scripts/validation/retry-linux-cases.mjs', import.meta.url))
    execFileSync(process.execPath, [retry, report, '--unit'], { cwd: root, stdio: 'pipe' })
    const ledger = JSON.parse(await readFile(join(root, 'first-retries.json'), 'utf8'))
    expect(ledger.attempts).toMatchObject([{ fullName: 'needs one confirmation', attempt: 1, status: 'passed' }])
    expect(await readFile(join(root, 'passed-count'), 'utf8')).toBe('x')
    expect(JSON.parse(await readFile(join(root, 'first-confirmed.json'), 'utf8'))).toMatchObject({ success: true, numPassedTests: 2, numFailedTests: 0 })
    expect(JSON.parse(await readFile(report, 'utf8'))).toMatchObject({ success: false, numFailedTests: 1 })
    const repeated = spawnSync(process.execPath, [retry, report, '--unit'], { cwd: root, encoding: 'utf8' })
    expect(repeated.status).toBe(1)
    expect(JSON.parse(await readFile(join(root, 'first-retries.json'), 'utf8')).attempts).toHaveLength(1)
    await writeFile(
      join(root, 'tests/example.spec.ts'),
      `import { it } from 'vitest'
it('remains failed', () => { throw Error('persistent failure') })
`,
    )
    const persistentReport = join(root, 'persistent.json')
    expect(spawnSync(process.execPath, [vitest, 'run', '--maxWorkers=1', '--reporter=json', '--outputFile=' + persistentReport], { cwd: root }).status).toBe(1)
    expect(spawnSync(process.execPath, [retry, persistentReport, '--unit'], { cwd: root }).status).toBe(1)
    const persistent = JSON.parse(await readFile(join(root, 'persistent-retries.json'), 'utf8'))
    expect(persistent.attempts).toMatchObject([
      { attempt: 1, status: 'failed' },
      { attempt: 2, status: 'failed' },
    ])
    expect(JSON.parse(await readFile(join(root, 'persistent-confirmed.json'), 'utf8'))).toMatchObject({ success: false, numFailedTests: 1 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
