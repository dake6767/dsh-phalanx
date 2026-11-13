import { beforeEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { ContainerMemberCredentials } from '../src/adapters/member-credentials.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { waitForMemberContainer } from '../src/adapters/runtime-process.js'
import { MEMBER_CREDENTIAL_COMMAND } from '../src/dsh/container.js'

vi.mock('../src/adapters/runtime-command.js', () => ({
  execFileText: vi.fn(),
  sanitize: (value: string) => value,
  containerClientEnvironment: () => ({ HOME: '/private/host' }),
}))
const exec = vi.mocked(execFileText)
const attributes = { service: 'fixture', account: 'member' }

beforeEach(() => exec.mockReset())

it('writes only to the current carrier and transfers credential data on stdin', async () => {
  exec.mockResolvedValue('true')
  const store = new ContainerMemberCredentials('podman', async () => 'member-carrier')
  await store.store(attributes, 'fictional-fixture-value')
  expect(exec).toHaveBeenCalledWith('podman', ['exec', '-i', 'member-carrier', ...MEMBER_CREDENTIAL_COMMAND, '--access'], {
    input: JSON.stringify({ operation: 'store', attributes: Object.entries(attributes), value: 'fictional-fixture-value' }),
    env: { HOME: '/private/host' },
    timeout: 10_000,
    maxBuffer: 131_072,
  })
})

it('distinguishes a missing credential from a private service failure and suppresses process output', async () => {
  exec.mockResolvedValueOnce('null').mockResolvedValueOnce('"fixture"').mockRejectedValueOnce(new Error('private child output'))
  const store = new ContainerMemberCredentials('podman', async () => 'member-carrier')
  await expect(store.lookup(attributes)).resolves.toBeUndefined()
  await expect(store.lookup(attributes)).resolves.toBe('fixture')
  const failure = await store.lookup(attributes).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    code: 'runtime-credentials-unavailable',
    message: 'The private credential service is unavailable',
  })
  expect(failure).not.toHaveProperty('cause')
})

it('refuses an expired carrier and cancels before spawning', async () => {
  const store = new ContainerMemberCredentials('podman', async () => {
    throw Error('Member instance is no longer registered')
  })
  await expect(store.clear(attributes)).rejects.toMatchObject({ code: 'runtime-credentials-unavailable' })
  await expect(store.lookup(attributes, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
  expect(exec).not.toHaveBeenCalled()
})

it('does not dispatch a credential operation canceled during carrier inspection', async () => {
  const controller = new AbortController()
  const store = new ContainerMemberCredentials('podman', async () => {
    controller.abort()
    return 'member-carrier'
  })
  await expect(store.lookup(attributes, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(exec).not.toHaveBeenCalled()
})

it('maps only a stopped credential supervisor to the credential recovery error', async () => {
  const config = { runtime: 'podman', image: 'fixture', internalPort: 4180, gatewayPort: 3081 }
  const wait = () => waitForMemberContainer(spawn(process.execPath, ['-e', 'process.exit(1)']), 2_000, new AbortController().signal, config, 'member-carrier')
  exec.mockResolvedValueOnce('false 78\n').mockResolvedValueOnce('true 0\n')
  await expect(wait()).rejects.toMatchObject({ code: 'runtime-credentials-unavailable' })
  await expect(wait()).rejects.toThrow('DSH exited before ready')
})
