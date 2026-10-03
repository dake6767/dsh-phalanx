import { expect, it, vi } from 'vitest'
import { buildCommunityContainerLaunchCommand, parseManagedContainers, parsePublishedPort, rootlessContainerUser } from '../src/dsh/container.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'

const RUNTIME_FIXTURE: CommunityRuntimeConfig = { command: 'node', args: [], dataRoot: '/fixture/data',
  defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://api.example.test' } },
  container: { runtime: 'podman', image: 'fixture', internalPort: 4180, gatewayPort: 3081 } }

it('keeps the rootless CLI home separate from the community container home', () => {
  const plan = buildCommunityContainerLaunchCommand({ config: RUNTIME_FIXTURE, userId: 'alice', ownership: 'owned-root',
    runtimeHome: '/fixture/alice/home', workspace: '/fixture/alice/workspace', publicAuthority: 'example.test',
    gatewayUrl: 'http://127.0.0.1:3081/_dsh-phalanx/model', environment: { HOME: '/fixture/alice/home',
      DSH_HOME: '/fixture/alice/home/.dsh', DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN: 'opaque-fixture' } })
  expect(plan.passthroughEnvironment.HOME).toBeUndefined()
  expect(plan.args).toContain('HOME=/dsh-phalanx/home')
  expect(plan.passthroughEnvironment.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN).toBe('opaque-fixture')
  expect(plan.args).not.toContain('DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN=opaque-fixture')
})

it('rejects a privileged container identity and restores process-scoped identity probes', () => {
  const uid = vi.spyOn(process, 'getuid').mockReturnValue(0)
  try { expect(() => rootlessContainerUser()).toThrow('non-root') }
  finally { uid.mockRestore() }
})

it('parses only valid host loopback mappings and complete container ownership records', () => {
  expect(parsePublishedPort('127.0.0.1:4242\n')).toBe(4242)
  expect(() => parsePublishedPort('0.0.0.0:4242')).toThrow('loopback')
  expect(() => parsePublishedPort('127.0.0.1:0')).toThrow('invalid')
  expect(parseManagedContainers('[{"Names":["owned"],"State":"running","Labels":{"dsh-phalanx.user":"alice"}}]'))
    .toEqual([{ name: 'owned', running: true, labels: { 'dsh-phalanx.user': 'alice' } }])
  expect(parseManagedContainers('{"Names":["first"]}\n{"Name":"second"}')).toHaveLength(2)
  expect(() => parseManagedContainers('[{}]')).toThrow('without a name')
})
