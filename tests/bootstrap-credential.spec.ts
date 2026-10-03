import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  consumeBootstrapCredential,
  issueBootstrapCredential,
  readBootstrapCredential,
  verifyBootstrapCredential,
} from '../src/adapters/bootstrap-credential.js'

describe('bootstrap credential', () => {
  let directory: string | undefined

  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  const open = async (): Promise<string> => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-phalanx-bootstrap-'))
    return directory
  }

  it('issues a credential into a 0600 file and verifies it timing-safely', async () => {
    const root = await open()
    const issued = issueBootstrapCredential(root, 1_000_000)
    expect(issued.credential).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(issued.expiresAt).toBe(1_000_000 + 24 * 60 * 60 * 1000)
    const info = await stat(join(root, 'bootstrap-credential'))
    expect(info.mode & 0o777).toBe(0o600)

    expect(readBootstrapCredential(root)).toEqual(issued)
    expect(verifyBootstrapCredential(root, issued.credential, issued.expiresAt - 1)).toBe(true)
    expect(verifyBootstrapCredential(root, issued.credential, issued.expiresAt)).toBe(false)
    expect(verifyBootstrapCredential(root, `${issued.credential}x`, issued.expiresAt - 1)).toBe(false)
    expect(verifyBootstrapCredential(root, 'wrong', issued.expiresAt - 1)).toBe(false)
  })

  it('reissues on every call so earlier credentials stop working', async () => {
    const root = await open()
    const first = issueBootstrapCredential(root, 1)
    const second = issueBootstrapCredential(root, 2)
    expect(second.credential).not.toBe(first.credential)
    expect(verifyBootstrapCredential(root, first.credential)).toBe(false)
    expect(verifyBootstrapCredential(root, second.credential, second.expiresAt - 1)).toBe(true)
  })

  it('vanishes after consumption and is absent before issuance', async () => {
    const root = await open()
    expect(readBootstrapCredential(root)).toBeUndefined()
    expect(verifyBootstrapCredential(root, 'anything')).toBe(false)
    issueBootstrapCredential(root)
    consumeBootstrapCredential(root)
    expect(readBootstrapCredential(root)).toBeUndefined()
    expect(() => consumeBootstrapCredential(root)).not.toThrow()
  })

  it('rejects a corrupted credential file instead of trusting it', async () => {
    const root = await open()
    issueBootstrapCredential(root)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(root, 'bootstrap-credential'), 'not-a-credential\n')
    expect(readBootstrapCredential(root)).toBeUndefined()
    expect(verifyBootstrapCredential(root, 'not-a-credential')).toBe(false)
    writeFileSync(join(root, 'bootstrap-credential'), 'abc 123 extra\n')
    expect(readBootstrapCredential(root)).toBeUndefined()
  })
})
