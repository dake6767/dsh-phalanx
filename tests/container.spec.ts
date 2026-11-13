import { expect, it, vi } from 'vitest'
import { buildCommunityContainerLaunchCommand, parseManagedContainers, parsePublishedPort, rootlessContainerUser } from '../src/dsh/container.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'

const RUNTIME_FIXTURE: CommunityRuntimeConfig = {
  command: 'node',
  args: [],
  dataRoot: '/fixture/data',
  defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://api.example.test' } },
  container: { runtime: 'podman', image: 'fixture', internalPort: 4180, gatewayPort: 3081 },
}

it('keeps the rootless CLI home separate from the community container home', () => {
  const plan = buildCommunityContainerLaunchCommand({
    config: RUNTIME_FIXTURE,
    userId: 'alice',
    spaceId: 'a'.repeat(32),
    hostname: 'fixture-alice',
    ownership: 'owned-root',
    runtimeHome: '/fixture/alice/home',
    workspace: '/fixture/alice/workspace',
    publicAuthority: 'example.test',
    gatewayUrl: 'http://127.0.0.1:3081/_dsh-phalanx/model',
    environment: {
      HOME: '/fixture/alice/home',
      DSH_HOME: '/fixture/alice/home/.dsh',
      XDG_RUNTIME_DIR: '/host/runtime',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/host/bus',
      DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN: 'opaque-fixture',
    },
  })
  expect(plan.passthroughEnvironment.HOME).toBeUndefined()
  expect(plan.passthroughEnvironment.XDG_RUNTIME_DIR).toBeUndefined()
  expect(plan.passthroughEnvironment.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
  expect(plan.args).toContain('--http-proxy=false')
  expect(plan.args).toContain('dsh-phalanx.space=' + 'a'.repeat(32))
  expect(plan.args).toContain('HOME=/dsh-phalanx/home')
  expect(plan.passthroughEnvironment.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN).toBe('opaque-fixture')
  expect(plan.args).not.toContain('DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN=opaque-fixture')
  expect(plan.args.slice(plan.args.indexOf('fixture') + 1, plan.args.indexOf('fixture') + 4)).toEqual([
    '/usr/local/bin/node',
    '/usr/local/lib/dsh-phalanx/member-credentials.mjs',
    'node',
  ])
})

it('rejects a privileged container identity and restores process-scoped identity probes', () => {
  const uid = vi.spyOn(process, 'getuid').mockReturnValue(0)
  try {
    expect(() => rootlessContainerUser()).toThrow('non-root')
  } finally {
    uid.mockRestore()
  }
})

it('uses the explicitly selected resource target', () => {
  const plan = buildCommunityContainerLaunchCommand({
    config: RUNTIME_FIXTURE,
    resourceLimits: { cpus: null, memoryMiB: null, pids: null },
    userId: 'alice',
    spaceId: 'a'.repeat(32),
    hostname: 'fixture-alice',
    ownership: 'owned-root',
    runtimeHome: '/fixture/alice/home',
    workspace: '/fixture/alice/workspace',
    publicAuthority: 'example.test',
    gatewayUrl: 'http://127.0.0.1:3081/_dsh-phalanx/model',
    environment: {},
  })
  expect(plan.args.slice(plan.args.indexOf('--cpus'), plan.args.indexOf('--cpus') + 8)).toEqual([
    '--cpus',
    '0',
    '--memory',
    '0',
    '--memory-swap',
    '-1',
    '--pids-limit',
    '-1',
  ])
})

it('parses only valid host loopback mappings and complete container ownership records', () => {
  expect(parsePublishedPort('127.0.0.1:4242\n')).toBe(4242)
  expect(() => parsePublishedPort('0.0.0.0:4242')).toThrow('loopback')
  expect(() => parsePublishedPort('127.0.0.1:0')).toThrow('invalid')
  expect(parseManagedContainers('[{"Names":["owned"],"State":"running","Labels":{"dsh-phalanx.user":"alice"}}]')).toEqual([
    { name: 'owned', running: true, labels: { 'dsh-phalanx.user': 'alice' } },
  ])
  expect(parseManagedContainers('{"Names":["first"]}\n{"Name":"second"}')).toHaveLength(2)
  expect(() => parseManagedContainers('[{}]')).toThrow('without a name')
})

it('mounts a resource-only member dependency tree read-only without a skills provider', async () => {
  const { prepareMemberDependencyMounts } = await import('../src/adapters/member-skills.js')
  const { mkdtemp, rm } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'resource-mount-'))
  try {
    const config = { ...RUNTIME_FIXTURE, dataRoot: root },
      volumes = await prepareMemberDependencyMounts(config, 'space', true)
    const launch = buildCommunityContainerLaunchCommand({
      config,
      userId: 'alice',
      spaceId: 'a'.repeat(32),
      hostname: 'fixture-alice',
      ownership: 'owned-root',
      runtimeHome: join(root, 'home'),
      workspace: join(root, 'workspace'),
      publicAuthority: 'example.test',
      gatewayUrl: 'http://127.0.0.1:3081/_dsh-phalanx/model',
      environment: {},
      dependencyVolumes: volumes,
    })
    expect(volumes).toHaveLength(2)
    for (const volume of volumes) expect(launch.args).toContain(`${volume.host}:${volume.mounted}:ro`)
    expect(launch.args.some(arg => arg.includes('overlay.json'))).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('mounts the member native feature patch read-only and applies it after expert and member patches', () => {
  const plan = buildCommunityContainerLaunchCommand({
    config: { ...RUNTIME_FIXTURE, patches: ['/fixture/custom.yml'] },
    userId: 'alice',
    spaceId: 'a'.repeat(32),
    hostname: 'fixture-alice',
    ownership: 'owned-root',
    runtimeHome: '/fixture/alice/home',
    workspace: '/fixture/alice/workspace',
    publicAuthority: 'example.test',
    gatewayUrl: 'http://127.0.0.1:3081/_dsh-phalanx/model',
    environment: {},
    memberExperts: { patch: '/dsh-phalanx/experts/generation-one/overlay.json', volumes: [{ host: '/fixture/experts', mounted: '/dsh-phalanx/experts' }] },
    memberNativeFeatures: {
      patch: '/dsh-phalanx/native-features/generation-two/overlay.json',
      volumes: [{ host: '/fixture/native', mounted: '/dsh-phalanx/native-features' }],
    },
  })
  expect(plan.args).toContain('/fixture/native:/dsh-phalanx/native-features:ro')
  const expert = plan.args.indexOf('/dsh-phalanx/experts/generation-one/overlay.json')
  const native = plan.args.indexOf('/dsh-phalanx/native-features/generation-two/overlay.json')
  expect(expert).toBeGreaterThan(0)
  expect(native).toBeGreaterThan(expert)
})

it('dumps the same composed profile in a transient container without web app arguments or published ports', () => {
  const plan = buildCommunityContainerLaunchCommand({
    config: RUNTIME_FIXTURE,
    mode: 'config-dump',
    userId: 'alice',
    spaceId: 'a'.repeat(32),
    hostname: 'fixture-alice',
    ownership: 'owned-root',
    runtimeHome: '/fixture/alice/home',
    workspace: '/fixture/alice/workspace',
    publicAuthority: 'example.test',
    gatewayUrl: 'http://127.0.0.1:3081/_dsh-phalanx/model',
    environment: {},
    memberExperts: { patch: '/fixture/expert.yml', volumes: [] },
  })
  expect(plan.args).toContain('--rm')
  expect(plan.args).toContain('--dump-config')
  expect(plan.args).toContain('/fixture/expert.yml')
  for (const argument of ['--detach', '--publish', '--host', '--port', '--no-open', '--trusted-host', '--public-url']) expect(plan.args).not.toContain(argument)
})

it('preserves confined loopback forwarding when pasta exposes the explicit legacy mapping option', () => {
  const input = {
    config: RUNTIME_FIXTURE,
    hostLoopbackToNamespaceLoopback: true,
    userId: 'alice',
    spaceId: 'a'.repeat(32),
    hostname: 'fixture-alice',
    ownership: 'owned-root',
    runtimeHome: '/fixture/alice/home',
    workspace: '/fixture/alice/workspace',
    publicAuthority: 'example.test',
    gatewayUrl: 'http://127.0.0.1:3081',
    environment: {},
  }
  const plan = buildCommunityContainerLaunchCommand(input)
  expect(plan.args[plan.args.indexOf('--network') + 1]).toBe('pasta:-4,-T,3081,--no-udp,--no-icmp,-o,127.0.0.1,--host-lo-to-ns-lo')
  expect(plan.args[plan.args.indexOf('--host') + 1]).toBe('127.0.0.1')
  expect(plan.args[plan.args.indexOf('--publish') + 1]).toBe('127.0.0.1::4180')
  expect(plan.args).toContain('--userns=keep-id')
  const old = buildCommunityContainerLaunchCommand({ ...input, hostLoopbackToNamespaceLoopback: false })
  expect(old.args[old.args.indexOf('--network') + 1]).toBe('pasta:-4,-T,3081,--no-udp,--no-icmp,-o,127.0.0.1')
  const dump = buildCommunityContainerLaunchCommand({ ...input, mode: 'config-dump' })
  expect(dump.args[dump.args.indexOf('--network') + 1]).toBe('pasta:-4,-T,3081,--no-udp,--no-icmp,-o,127.0.0.1,--host-lo-to-ns-lo')
  expect(dump.args).not.toContain('--publish')
})
