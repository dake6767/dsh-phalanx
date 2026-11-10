import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { FileInitialModelDefaults } from '../src/adapters/initial-model-defaults.js'

it('accepts partial 0600 suggestions without changing the deployer file, and rejects unsafe or invalid input', () => {
  const root = mkdtempSync(join(tmpdir(), 'initial-model-defaults-'))
  try {
    const path = join(root, 'model.json'),
      reader = new FileInitialModelDefaults(path)
    expect(reader.read()).toEqual({ status: 'absent' })
    const content = JSON.stringify({ name: 'Suggested', apiKey: 'fictional-preset-key' })
    writeFileSync(path, content, { mode: 0o600 })
    expect(reader.read()).toEqual({ status: 'ready', values: { name: 'Suggested', apiKey: 'fictional-preset-key' } })
    expect(readFileSync(path, 'utf8')).toBe(content)
    chmodSync(path, 0o644)
    expect(reader.read()).toEqual({ status: 'invalid' })
    chmodSync(path, 0o600)
    const link = join(root, 'link.json')
    symlinkSync(path, link)
    expect(new FileInitialModelDefaults(link).read()).toEqual({ status: 'invalid' })
    expect(new FileInitialModelDefaults(root).read()).toEqual({ status: 'invalid' })
    for (const value of [
      'not JSON fictional-preset-key',
      JSON.stringify({ apiFormat: 'unknown' }),
      JSON.stringify({ baseUrl: 'https://name:secret@example.test' }),
      JSON.stringify({ unknown: 'field' }),
      ' '.repeat(16385),
    ]) {
      writeFileSync(path, value)
      expect(reader.read()).toEqual({ status: 'invalid' })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
