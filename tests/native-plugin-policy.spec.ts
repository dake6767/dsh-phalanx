import { expect, it } from 'vitest'
import { nativePluginPolicyModule } from '../src/dsh/native-plugin-policy.js'

it('refuses member installs and never-enabled optional bundles while preserving existing bundle operations and native validation', async () => {
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const calls: string[] = []
  const module = await import(
    'data:text/javascript;base64,' + Buffer.from(nativePluginPolicyModule({ subject: 'member', generation: 'launch', allowInstall: false })).toString('base64')
  )
  module.apply({
    connection: {
      browserPeer: {},
      fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => routes.set(route.path, route.fetch) },
    },
    settings: { describe: () => [{ ns: 'locale', value: { preference: 'zh' } }] },
    typertGateway: {
      invoke: async (input: { method: string }) => {
        calls.push(input.method)
        return input.method === 'listBundles'
          ? [
              { name: 'existing', official: true, optional: true, enabled: false, installed: true },
              { name: 'never', official: true, optional: true, enabled: false, installed: false },
              { name: '@deepseek-ai/dsh-experimental-plugin-market-bundle' },
            ]
          : { application: 'applied' }
      },
    },
  })
  const call = async (method: string, args: object) => {
    const handler = routes.get('/api/pluginManager/' + method)!
    const response = await handler(
      new Request('http://native.example/api/pluginManager/' + method, {
        method: 'POST',
        body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: 'pluginManager/' + method, payload: { args } }),
      }),
    )
    return response.json()
  }
  expect(await call('installBundle', { spec: 'fixture-package' })).toMatchObject({
    result: { ok: false, error: { code: 'remote-access/denied', message: '平台已禁用自行添加插件，请联系管理员' } },
  })
  expect(await call('setBundleEnabled', { name: 'never', enabled: true })).toMatchObject({ result: { ok: false, error: { code: 'remote-access/denied' } } })
  expect(await call('setBundleEnabled', { name: 'existing', enabled: true })).toMatchObject({ result: { ok: true } })
  expect(await call('setBundleEnabled', { name: 'never', enabled: false })).toMatchObject({ result: { ok: true } })
  expect((await call('listBundles', {})).result.value).toHaveLength(2)
  expect(calls).not.toContain('installBundle')
  expect(routes.has('/api/phalanx/native-plugins/install')).toBe(false)
})

it('accepts one signed platform installation while refusing cookie-only access and exact replay in the generated member policy', async () => {
  const { NativeInstallAuthority } = await import('../src/adapters/native-install-authority.js')
  const authority = new NativeInstallAuthority()
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  let installations = 0
  const module = await import(
    'data:text/javascript;base64,' +
      Buffer.from(nativePluginPolicyModule({ subject: 'member', generation: 'launch', allowInstall: false, publicKey: authority.publicKey })).toString('base64')
  )
  module.apply({
    connection: {
      browserPeer: {},
      fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => routes.set(route.path, route.fetch) },
    },
    settings: { describe: () => [] },
    typertGateway: {
      invoke: async () => {
        installations++
        return { application: 'applied' }
      },
    },
  })
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'fixture',
    method: 'pluginManager/installBundle',
    payload: { args: { spec: '/fixture/plugin.tgz' } },
  })
  const authorization = authority.authorize({ userId: 'member', resourceKey: 'launch' }, body)
  const path = '/api/phalanx/native-plugins/install'
  const call = async (headers: Record<string, string>) =>
    (await routes.get(path)!(new Request('http://native.example' + path, { method: 'POST', headers, body }))).json()
  expect(await call({ cookie: 'native=fixture' })).toMatchObject({ result: { ok: false, error: { code: 'remote-access/denied' } } })
  const headers = { 'x-phalanx-install-proof': authorization.proof, 'x-phalanx-install-signature': authorization.signature }
  expect(await call(headers)).toMatchObject({ result: { ok: true, value: { application: 'applied' } } })
  expect(await call(headers)).toMatchObject({ result: { ok: false, error: { code: 'remote-access/denied', details: { reason: 'platform-install-replay' } } } })
  expect(installations).toBe(1)
})

it.each(['activation-failed', 'target-archive-changed', 'partial-removal', 'moved-alias', 'renamed-alias', 'renamed-key-alias'] as const)(
  'continues a signed replacement after disconnect and restores the old dependency only once after %s',
  async failure => {
    const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createHash } = await import('node:crypto')
    const { DSH_CONTAINER_PROFILE } = await import('../src/dsh/profile-layout.js')
    const { platformPluginContainerPath } = await import('../src/dsh/community-platform-plugin.js')
    const { NativeInstallAuthority } = await import('../src/adapters/native-install-authority.js')
    const { NATIVE_PLATFORM_INSTALL_PATH } = await import('../src/dsh/native-plugin-install.js')
    const profile = await mkdtemp(join(tmpdir(), 'native-update-policy-'))
    let entered!: () => void, release!: () => void
    const removing = new Promise<void>(resolve => {
      entered = resolve
    })
    const allowRemoval = new Promise<void>(resolve => {
      release = resolve
    })
    try {
      const archiveDirectory = join(profile, '.phalanx-market')
      await mkdir(archiveDirectory)
      const archive = async (content: string, version: string) => {
        const hash = createHash('sha512').update(content).digest()
        const path = join(archiveDirectory, hash.toString('hex') + '.tgz')
        await writeFile(path, content)
        return { path, version, integrity: 'sha512-' + hash.toString('base64') }
      }
      const previous = await archive('old checked content', '1.0.0')
      const next = await archive('new checked content', '2.0.0')
      const packageName = '@fixture/update'
      const first = '- id: first\n  config: { value: &same { id: own, config: { setting: 1 } } }\n'
      const second = '- id: second\n  config: { value: &same { id: own, config: { setting: 2 } } }\n'
      const alias = '- *same\n'
      const renamesModule = failure === 'renamed-alias' || failure === 'renamed-key-alias'
      const patch =
        failure === 'moved-alias'
          ? first + alias + second
          : failure === 'renamed-alias'
            ? first.replace('id: own,', 'id: own, name: ' + JSON.stringify(packageName) + ',') + alias
            : failure === 'renamed-key-alias'
              ? '- id: first\n  config: { key: &idkey id }\n- ? *idkey\n  : own\n  name: ' + JSON.stringify(packageName) + '\n  config: { setting: 1 }\n'
              : '[]\n'
      await writeFile(join(profile, 'cordis.patch.yml'), patch)
      const lock = async (value: typeof previous, integrity = value.integrity) => {
        const spec = 'file:' + value.path
        await writeFile(
          join(profile, 'pnpm-lock.yaml'),
          JSON.stringify({
            importers: { '.': { dependencies: { [packageName]: { specifier: spec, version: spec } } } },
            packages: { [packageName + '@' + spec]: { resolution: { integrity } } },
          }),
        )
      }
      await lock(previous)
      let active: { archive: typeof previous; enabled: boolean } | undefined = { archive: previous, enabled: true }
      let removeCount = 0,
        restoreCount = 0,
        enableCount = 0
      const authority = new NativeInstallAuthority()
      const routes = new Map<string, (request: Request) => Promise<Response>>()
      const code = nativePluginPolicyModule({ subject: 'member', generation: 'launch', allowInstall: false, publicKey: authority.publicKey })
        .replaceAll(DSH_CONTAINER_PROFILE, profile)
        .replaceAll(platformPluginContainerPath + '/yaml/dist/index.js', import.meta.resolve('yaml'))
      const testCode = code.replace(
        'await loadDshProfileWriter(require, pathToFileURL)',
        '({withFileLock: async (_path, operation) => await operation(), writeFileAtomic: writeFile})',
      )
      const plugin = await import('data:text/javascript;base64,' + Buffer.from(testCode).toString('base64'))
      plugin.apply({
        connection: {
          browserPeer: {},
          fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => routes.set(route.path, route.fetch) },
        },
        settings: { describe: () => [] },
        typertGateway: {
          invoke: async ({ method, args, signal }: { method: string; args: { spec?: string; options?: { enabled: boolean } }; signal: AbortSignal }) => {
            if (method === 'listBundles')
              return active
                ? [
                    {
                      name: packageName,
                      source: 'file:' + active.archive.path,
                      version: active.archive.version,
                      installed: true,
                      removable: true,
                      enabled: active.enabled,
                      rows: [{ rowId: 'own', moduleName: renamesModule && active.archive === next ? packageName + '/new' : packageName }],
                    },
                  ]
                : []
            if (method === 'removeBundle') {
              removeCount++
              if (removeCount === 1) {
                entered()
                await allowRemoval
                expect(signal.aborted).toBe(false)
                if (failure === 'target-archive-changed') {
                  await writeFile(next.path, 'changed in flight')
                  await writeFile(previous.path, 'changed after backup')
                }
                if (failure === 'partial-removal' || failure === 'moved-alias') {
                  active = { archive: previous, enabled: false }
                  if (failure === 'partial-removal') await lock(previous, next.integrity)
                  else await writeFile(join(profile, 'cordis.patch.yml'), first + second + alias)
                  return { application: 'failed' }
                }
              }
              active = undefined
              return { application: 'applied' }
            }
            if (method === 'installBundle') {
              const target = args.spec === next.path ? next : previous
              if (target === previous) {
                // The native gateway accepts omission of an optional field, but rejects an explicit undefined wire value.
                expect(args.options).not.toHaveProperty('requestId')
                restoreCount++
              }
              await lock(target)
              active = { archive: target, enabled: args.options!.enabled }
              return { application: target === previous && failure === 'target-archive-changed' ? 'restart-required' : 'applied', bundle: packageName }
            }
            if (method === 'setBundleEnabled') {
              enableCount++
              if (active?.archive === previous) {
                active.enabled = true
                return { application: 'applied' }
              }
              return { application: 'failed', error: { code: 'activation-failed' } }
            }
            throw new Error('Unexpected RPC: ' + method)
          },
        },
      })
      const body = JSON.stringify({
        type: 'client-request',
        rpcId: 'fixture',
        method: 'pluginManager/installBundle',
        payload: {
          args: {
            spec: next.path,
            replacement: {
              packageName,
              authorizationUrl: 'data:,permitted',
              previous: { version: previous.version, integrity: previous.integrity, enabled: true },
              next,
            },
            options: { registry: 'https://registry.example', requestId: 'update-once' },
          },
        },
      })
      const call = async (signal?: AbortSignal) => {
        const authorization = authority.authorize({ userId: 'member', resourceKey: 'launch' }, body)
        return (
          await routes.get(NATIVE_PLATFORM_INSTALL_PATH)!(
            new Request('http://native.example' + NATIVE_PLATFORM_INSTALL_PATH, {
              method: 'POST',
              body,
              ...(signal ? { signal } : {}),
              headers: { 'x-phalanx-install-proof': authorization.proof, 'x-phalanx-install-signature': authorization.signature },
            }),
          )
        ).json()
      }
      const controller = new AbortController()
      const original = call(controller.signal)
      // If validation refuses the operation, fail here with the returned diagnostic instead of hanging on the gate.
      expect(await Promise.race([removing.then(() => 'removing'), original])).toBe('removing')
      controller.abort()
      const replay = call()
      release()
      if (failure === 'partial-removal' || failure === 'moved-alias') {
        const reason = failure === 'partial-removal' ? 'previous-copy-not-confirmed' : 'settings-alias-conflict'
        const outcome = { result: { ok: true, value: { replacement: 'restore-failed', reason: 'remove-failed/' + reason } } }
        expect(await original).toMatchObject(outcome)
        expect(await replay).toMatchObject(outcome)
        expect(enableCount).toBe(0)
        expect(active?.enabled).toBe(false)
        expect((await readdir(archiveDirectory)).filter(name => name.startsWith('recovery-'))).toHaveLength(1)
        return
      }
      const outcome = {
        result: {
          ok: true,
          value: {
            replacement: 'restored',
            reason: renamesModule ? 'settings-incompatible' : failure,
            ...(failure === 'target-archive-changed' ? { restartRequired: true } : {}),
          },
        },
      }
      expect(await original).toMatchObject(outcome)
      expect(await replay).toMatchObject(outcome)
      expect(removeCount).toBe(failure === 'target-archive-changed' ? 1 : 2)
      if (renamesModule) expect(enableCount).toBe(1)
      expect(restoreCount).toBe(1)
      expect(active).toEqual({ archive: previous, enabled: true })
      expect(await readFile(previous.path, 'utf8')).toBe('old checked content')
      expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(patch)
      expect((await readdir(archiveDirectory)).filter(name => name.startsWith('recovery-'))).toEqual([])
    } finally {
      release()
      await rm(profile, { recursive: true, force: true })
    }
  },
)
