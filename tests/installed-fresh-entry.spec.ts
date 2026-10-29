import { expect, it } from 'vitest'
import { freshGateEntry } from './support/installed-fresh-release.js'

it('binds the browser origin and unique member space to the verified installation', () => {
  const nonce = 'a'.repeat(32),
    root = '/var/tmp/candidate-release-gate-' + nonce
  const proof = { publicOrigin: 'http://127.0.0.1:18080', member: 'gate-' + nonce, spaceId: 'b'.repeat(32) }
  expect(freshGateEntry(root, proof.publicOrigin, proof)).toEqual({ origin: proof.publicOrigin, member: proof.member, pathname: '/app/' + proof.spaceId + '/' })
  expect(() => freshGateEntry(root, 'http://127.0.0.1:18081', proof)).toThrow()
  expect(() => freshGateEntry(root, proof.publicOrigin, { ...proof, member: 'milestone-member' })).toThrow()
  expect(() => freshGateEntry(root, proof.publicOrigin, { ...proof, member: 'gate-' + 'c'.repeat(32) })).toThrow()
  expect(() => freshGateEntry(root, proof.publicOrigin, { ...proof, spaceId: '../another-installation' })).toThrow()
})
