import { expect, it } from 'vitest'
import { NativeInstallAuthority } from '../src/adapters/native-install-authority.js'
import { nativeInstallVerifierModule, NATIVE_PLATFORM_INSTALL_PATH, NATIVE_PLATFORM_SETTINGS_PATH } from '../src/dsh/native-plugin-install.js'

it('authorizes one exact platform install for the bound member and launch, then refuses the same proof', async () => {
  const now = 100000
  const authority = new NativeInstallAuthority(
    () => now,
    () => 'fixture-nonce',
  )
  const module = await import('data:text/javascript;base64,' + Buffer.from(nativeInstallVerifierModule).toString('base64'))
  const verifier = module.createVerifier(authority.publicKey, 'member', 'fixture-launch', () => now)
  const body = JSON.stringify({ type: 'client-request', method: 'pluginManager/installBundle', payload: { args: { spec: '/fixture/plugin.tgz' } } })
  const authorization = authority.authorize({ userId: 'member', resourceKey: 'fixture-launch' }, body)
  expect(verifier.check(authorization, 'POST', NATIVE_PLATFORM_INSTALL_PATH, body)).toEqual({ ok: true })
  expect(verifier.check(authorization, 'POST', NATIVE_PLATFORM_INSTALL_PATH, body)).toMatchObject({ ok: false, reason: 'replay' })
})

it.each([
  ['body', 'member', 'fixture-launch', 'POST', NATIVE_PLATFORM_INSTALL_PATH, 'altered'],
  ['member', 'other-member', 'fixture-launch', 'POST', NATIVE_PLATFORM_INSTALL_PATH, 'original'],
  ['generation', 'member', 'other-launch', 'POST', NATIVE_PLATFORM_INSTALL_PATH, 'original'],
  ['method', 'member', 'fixture-launch', 'GET', NATIVE_PLATFORM_INSTALL_PATH, 'original'],
  ['path', 'member', 'fixture-launch', 'POST', '/api/another-operation', 'original'],
])('refuses a proof used for a different %s', async (_kind, subject, generation, method, path, body) => {
  const authority = new NativeInstallAuthority(
    () => 100000,
    () => 'fixture-nonce',
  )
  const module = await import('data:text/javascript;base64,' + Buffer.from(nativeInstallVerifierModule).toString('base64'))
  const verifier = module.createVerifier(authority.publicKey, subject, generation, () => 100000)
  const authorization = authority.authorize({ userId: 'member', resourceKey: 'fixture-launch' }, 'original')
  expect(verifier.check(authorization, method, path, body)).toMatchObject({ ok: false, reason: 'target' })
})

it('rejects expired and implausibly future grants using an injected clock', async () => {
  let now = 100000
  const authority = new NativeInstallAuthority(
    () => now,
    () => 'fixture-nonce',
  )
  const module = await import('data:text/javascript;base64,' + Buffer.from(nativeInstallVerifierModule).toString('base64'))
  const verifier = module.createVerifier(authority.publicKey, 'member', 'fixture-launch', () => now)
  const authorization = authority.authorize({ userId: 'member', resourceKey: 'fixture-launch' }, 'body')
  now += 30000
  expect(verifier.check(authorization, 'POST', NATIVE_PLATFORM_INSTALL_PATH, 'body')).toMatchObject({ ok: false, reason: 'expired' })
  now = 99999
  expect(verifier.check(authorization, 'POST', NATIVE_PLATFORM_INSTALL_PATH, 'body')).toMatchObject({ ok: false, reason: 'expired' })
})

it('does not accept signatures from another platform key or reuse a grant after key rotation', async () => {
  const first = new NativeInstallAuthority(
    () => 100000,
    () => 'fixture-nonce',
  )
  const second = new NativeInstallAuthority(
    () => 100000,
    () => 'fixture-nonce',
  )
  const module = await import('data:text/javascript;base64,' + Buffer.from(nativeInstallVerifierModule).toString('base64'))
  const verifier = module.createVerifier(second.publicKey, 'member', 'fixture-launch', () => 100000)
  expect(
    verifier.check(first.authorize({ userId: 'member', resourceKey: 'fixture-launch' }, 'body'), 'POST', NATIVE_PLATFORM_INSTALL_PATH, 'body'),
  ).toMatchObject({ ok: false, reason: 'signature' })
})

it.each([undefined, {}, { proof: '.', signature: 'invalid' }, { proof: 'a'.repeat(4097), signature: 'a'.repeat(86) }])(
  'refuses malformed authorization without throwing',
  async authorization => {
    const authority = new NativeInstallAuthority()
    const module = await import('data:text/javascript;base64,' + Buffer.from(nativeInstallVerifierModule).toString('base64'))
    const verifier = module.createVerifier(authority.publicKey, 'member', 'fixture-launch')
    expect(verifier.check(authorization, 'POST', NATIVE_PLATFORM_INSTALL_PATH, 'body')).toMatchObject({ ok: false, reason: 'proof' })
  },
)

it('requires a captured launch before creating platform authorization', () => {
  expect(() => new NativeInstallAuthority().authorize({ userId: 'member' }, 'body')).toThrow('captured member launch')
})

it('scopes signed settings requests to their own path and carrier', async () => {
  const authority = new NativeInstallAuthority()
  const module = await import('data:text/javascript;base64,' + Buffer.from(nativeInstallVerifierModule).toString('base64'))
  const verifier = module.createVerifier(authority.publicKey, 'member', 'fixture-launch')
  const authorization = authority.authorize({ userId: 'member', resourceKey: 'fixture-launch' }, 'settings', NATIVE_PLATFORM_SETTINGS_PATH)
  expect(verifier.check(authorization, 'POST', NATIVE_PLATFORM_INSTALL_PATH, 'settings')).toMatchObject({ ok: false, reason: 'target' })
  expect(verifier.check(authorization, 'POST', NATIVE_PLATFORM_SETTINGS_PATH, 'settings')).toEqual({ ok: true })
})
