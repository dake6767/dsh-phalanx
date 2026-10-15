import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('makes the actual pinned pnpm CLI use the selected build registry', () => {
  for (const [preset, registry] of [['official', 'https://registry.npmjs.org/'], ['mainland', 'https://registry.npmmirror.com/']]) {
    const actual = execFileSync('python3', ['scripts/download-sources.py', '--preset', preset!, '--', 'corepack', 'pnpm', 'config', 'get', 'registry'], { encoding: 'utf8' }).trim()
    expect(actual).toBe(registry)
  }
})
