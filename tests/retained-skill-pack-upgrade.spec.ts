import { describe, expect, it } from 'vitest'
import type { CommunitySkillPackLibrary } from '../src/domain/admin-contract.js'
import { assertRetainedSkillPacks } from './support/installed-retained-after.js'

const revision = 'a'.repeat(64)
const pack = {
  name: 'retained-pack',
  description: 'Retained description',
  instructions: 'Retained instructions',
  skills: ['retained-skill'],
  published: true,
  suiteOrigin: 'suite:retained',
  empty: false,
  conflict: false,
  hasPlatformCredential: false,
}
const before: CommunitySkillPackLibrary = {
  revision: '["legacy snapshot"]',
  packs: [{ ...pack, revision: '["legacy snapshot"]' }],
}

describe('retained skill pack upgrade acceptance', () => {
  it('accepts the current token with the original pack facts', () => {
    assertRetainedSkillPacks(before, { revision, packs: [{ ...pack, revision }] })
  })

  it('rejects changed business fields and invalid or inconsistent tokens', () => {
    expect(() => assertRetainedSkillPacks(before, { revision, packs: [{ ...pack, revision, published: false }] })).toThrow()
    expect(() => assertRetainedSkillPacks(before, { revision, packs: [{ ...pack, revision: 'b'.repeat(64) }] })).toThrow()
    expect(() => assertRetainedSkillPacks(before, before)).toThrow()
  })
})
