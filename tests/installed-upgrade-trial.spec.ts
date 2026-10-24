import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { retainedExecutionTrial } from './support/installed-upgrade-trial.js'

it.each([200, 503])('retains redacted HTTP %s trial diagnostics before rejecting the failed execution', async status => {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-trial-evidence-'))
  try {
    const path = join(root, 'trials.jsonl'), sensitive = 'fixture-private-value'
    const result = { exitCode: 125, stdout: '', stderr: 'fixture failure ' + sensitive, truncated: false }
    const api = { get: async () => undefined, post: async () => ({ status: () => status, json: async () => result }) }
    await expect(retainedExecutionTrial(api, 'baseline', path, text => text.replaceAll(sensitive, '[redacted]'))).rejects.toThrow()
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain(sensitive)
    expect(JSON.parse(raw)).toEqual({ phase: 'baseline', httpStatus: status, result: { ...result, stderr: 'fixture failure [redacted]' } })
  } finally { await rm(root, { recursive: true, force: true }) }
})
