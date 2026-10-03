import { describe, expect, it } from 'vitest'
import { execFileText } from '../src/adapters/runtime-command.js'

describe('command output from partial schema projections', () => {
  it('keeps stdout only for an explicitly accepted nonzero exit', async () => {
    const args = ['-e', 'process.stdout.write("{\\"partial\\":true}"); process.exit(1)']
    await expect(execFileText(process.execPath, args)).rejects.toThrow()
    await expect(execFileText(process.execPath, args, { acceptedExitCodes: [1] }))
      .resolves.toBe('{"partial":true}')
  })
})
