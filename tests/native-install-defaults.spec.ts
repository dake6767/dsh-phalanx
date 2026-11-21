import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { canonicalJson } from '../src/domain/suite-catalog-document.js'
import { NativeInstallAuthority } from '../src/adapters/native-install-authority.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { platformPluginContainerPath } from '../src/dsh/community-platform-plugin.js'
import { NATIVE_PLATFORM_INSTALL_PATH } from '../src/dsh/native-plugin-install.js'
import { nativePluginPolicyModule } from '../src/dsh/native-plugin-policy.js'
import { pluginArtifactPreparation } from '../src/dsh/plugin-preparation.js'
import { DSH_CONTAINER_HOME, DSH_CONTAINER_PROFILE, dshHomePath } from '../src/dsh/profile-layout.js'

it('resolves a bundle provider from the defaulted entry file in the prepared artifact', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-default-precheck-')))
  try {
    const control = join(root, 'control')
    const work = join(root, 'work')
    const runtime = join(root, 'runtime')
    const profile = join(work, 'home/.dsh/profiles/web')
    const modules = join(profile, 'node_modules')
    const plugin = join(modules, 'fixture-defaults')
    const provider = join(modules, 'fixture-provider')
    const artifact = join(work, 'prepared/revision')
    const fixtureYaml = join(runtime, 'node_modules/js-yaml')
    const require = createRequire(import.meta.url)
    await Promise.all([control, plugin, provider, fixtureYaml, join(runtime, 'apps/cli')].map(directory => mkdir(directory, { recursive: true })))
    const patch = [{ insert: [{ id: 'owned', name: 'fixture-defaults', config: { fromPackage: true } }] }]
    const files = {
      [join(control, 'input.json')]: JSON.stringify({
        packageName: 'fixture-defaults',
        version: '1.0.0',
        runtimeRevision: 'revision',
        installDefaults: { owned: { writable: true } },
      }),
      [join(control, 'prepare.mjs')]: pluginArtifactPreparation
        .replaceAll('/prepare/', work + '/')
        .replaceAll('/control/', control + '/')
        .replaceAll('/opt/dsh/', runtime + '/')
        .replace('async error => { await writeFile', 'async error => { console.error(error); await writeFile'),
      [join(work, 'identity.json')]: '{}',
      [join(profile, 'package.json')]: JSON.stringify({ dsh: { profile: { bundles: ['fixture-defaults'] } } }),
      [join(profile, 'cordis.patch.yml')]: '[]\n',
      [join(plugin, 'package.json')]: JSON.stringify({ name: 'fixture-defaults', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      [join(plugin, 'cordis.patch.yml')]: JSON.stringify(patch),
      [join(plugin, 'index.js')]: '',
      [join(provider, 'index.js')]: '',
      [join(fixtureYaml, 'index.js')]:
        `module.exports = { load: require(${JSON.stringify(require.resolve('yaml'))}).parse, JSON_SCHEMA: { extend() {} }, Type: class {} }`,
    }
    await Promise.all(Object.entries(files).map(([path, contents]) => writeFile(path, contents)))
    await execFileText(process.execPath, [join(control, 'prepare.mjs'), 'inspect'])

    // The offline DSH process mounts the prepared artifact at /artifact.
    const precheck = JSON.parse(await readFile(join(artifact, 'native-defaults/check.json'), 'utf8'))
    const include: string = precheck[0].insert[0].config.path
    expect(include).toMatch(/^\/artifact\/native-defaults\//u)
    const includeFile = include.replace('/artifact/', artifact + '/')
    expect(createRequire(includeFile).resolve('fixture-provider')).toBe(join(artifact, 'node_modules/fixture-provider/index.js'))
    expect(JSON.parse(await readFile(includeFile, 'utf8'))[0].config).toEqual({ fromPackage: true, writable: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['fresh', 'update', 'renamed-home', 'renamed-home-without-defaults', 'restore', 'resume', 'stale', 'personal'] as const)(
  'delivers a signed defaults profile before activation (%s)',
  async scenario => {
    const profile = await mkdtemp(join(tmpdir(), 'native-install-defaults-'))
    const rowKey = Symbol.for(profile)
    const state = { homeRow: 'home-owned' }
    Reflect.set(globalThis, rowKey, state)
    try {
      const packageName = 'fixture-defaults'
      const modules = join(profile, 'node_modules', packageName)
      const archives = join(profile, '.phalanx-market')
      const home = join(profile, 'member-home')
      const homePath = join(home, 'cordis.patch.yml')
      await mkdir(modules, { recursive: true })
      await mkdir(archives)
      await mkdir(home)
      await writeFile(join(modules, 'index.js'), '')
      const archive = async (version: string) => {
        const hash = createHash('sha512').update(version).digest()
        const spec = join(archives, hash.toString('hex') + '.tgz')
        await writeFile(spec, version)
        return { spec, version, integrity: 'sha512-' + hash.toString('base64') }
      }
      const previous = await archive('1.0.0')
      const next = await archive('2.0.0')
      const patchPath = join(profile, 'cordis.patch.yml')
      const renamedHome = scenario === 'renamed-home' || scenario === 'renamed-home-without-defaults'
      const patch =
        '# member choice\n- id: owned\n  config: { mode: readonly, nested: { count: 0 }, values: [], blank: null }\n- id: unrelated\n  config: { enabled: false }\n' +
        (renamedHome ? '' : '- id: home-owned\n  config: { lower: true }\n')
      const homePatch = '# home settings\n- id: home-owned\n  config: { member: 0 }\n- id: home-other\n  config: { retain: true }\n'
      await writeFile(patchPath, patch)
      await writeFile(homePath, homePatch)
      const identity = { userId: 'member', resourceKey: 'launch' }
      const authority = new NativeInstallAuthority()
      const defaults = {
        owned: { mode: 'writable', nested: { count: 8, note: 'sample' }, values: ['default'], blank: { missing: true }, added: true },
        second: { mixed: [null, false, 5, 'word', { fine: 3 }] },
        'home-owned': { member: 8, verified: true },
      }
      const packageRows = [
        { rowId: 'owned', moduleName: packageName },
        { rowId: 'second', moduleName: packageName },
        { rowId: 'home-owned', moduleName: packageName },
      ]
      const twin = (row: (typeof packageRows)[number]) => ({ id: row.rowId, name: row.moduleName, config: { factory: 12 } })
      const startingCopy = scenario === 'resume' || scenario === 'stale' || scenario === 'personal'
      const replacing = scenario === 'update' || renamedHome
      let active = replacing ? previous : startingCopy ? next : undefined
      let enabled = replacing
      const markers = {
        owned: '28ca914e-a85d-447a-b2e0-441a4e566b2d',
        home: 'd6febaf0-f069-4e51-8926-13745fe495cd',
        second: '8b5e4018-04cb-445d-b6cc-f3567217821c',
      }
      const note = (marker: string) => ' # [phalanx-install-defaults:' + marker + ']'
      const intentPath = next.spec + '.install-defaults.json'
      const fingerprint = createHash('sha256').update(canonicalJson(defaults)).digest('hex')
      if (scenario === 'resume' || scenario === 'stale')
        await writeFile(
          intentPath,
          JSON.stringify({
            packageName,
            version: next.version,
            integrity: next.integrity,
            defaults: scenario === 'resume' ? fingerprint : 'a'.repeat(64),
            configured: false,
            ...(scenario === 'stale'
              ? {
                  effects: [
                    {
                      layer: 'profile',
                      rowId: 'owned',
                      moduleName: packageName,
                      marker: markers.owned,
                      created: false,
                      additions: [
                        { keys: ['added'], value: 'true\n' },
                        { keys: ['nested', 'note'], value: 'sample\n' },
                      ],
                    },
                    {
                      layer: 'home',
                      rowId: 'home-owned',
                      moduleName: packageName,
                      marker: markers.home,
                      created: false,
                      additions: [{ keys: ['verified'], value: 'true\n' }],
                    },
                    {
                      layer: 'profile',
                      rowId: 'second',
                      moduleName: packageName,
                      marker: markers.second,
                      created: true,
                      additions: [{ keys: [], value: '{factory: 12, mixed: [null, false, 5, word, {fine: 3}]}\n' }],
                    },
                  ],
                }
              : {}),
          }),
        )
      if (scenario === 'stale') {
        await writeFile(
          patchPath,
          patch
            .replace('- id: owned', '- id: owned' + note(markers.owned))
            .replace('count: 0', 'count: 4, note: member')
            .replace('blank: null', 'blank: null, added: true') +
            '- id: owned\n  config: { added: true, newer: member override }\n- id: second' +
            note(markers.second) +
            '\n  name: ' +
            packageName +
            '\n  config: { factory: 12, mixed: [null, false, 5, word, { fine: 3 }] }\n',
        )
        await writeFile(
          homePath,
          homePatch.replace('- id: home-owned', '- id: home-owned' + note(markers.home)).replace('member: 0', 'member: 5, verified: true'),
        )
      }
      let freshInstallations = 0
      const lock = async (value: typeof next) => {
        const spec = 'file:' + value.spec
        await writeFile(
          join(profile, 'pnpm-lock.yaml'),
          JSON.stringify({
            importers: { '.': { dependencies: { [packageName]: { specifier: spec, version: spec } } } },
            packages: { [packageName + '@' + spec]: { resolution: { integrity: value.integrity } } },
          }),
        )
      }
      if (active) await lock(active)
      const code = nativePluginPolicyModule({
        subject: identity.userId,
        generation: identity.resourceKey,
        allowInstall: true,
        publicKey: authority.publicKey,
      })
        .replaceAll(DSH_CONTAINER_PROFILE, profile)
        .replaceAll(dshHomePath(DSH_CONTAINER_HOME), home)
        .replaceAll(platformPluginContainerPath + '/yaml/dist/index.js', import.meta.resolve('yaml'))
        .replaceAll(
          'await loadDshProfileWriter(require, pathToFileURL)',
          '({withFileLock: async (_path, operation) => operation(), writeFileAtomic: writeFile})',
        )
        .replace(
          "await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)",
          `({
        resolveBundleDir: () => ${JSON.stringify(modules)},
        readProfileManifest: () => ({dsh: {bundle: {}}}),
        bundlePatchPaths: () => ['bundle'],
        loadOverlayPatches: (_bin, path) => path === 'bundle' ? [
          {insert: [${JSON.stringify(twin(packageRows[0]!))},
            {...${JSON.stringify(twin(packageRows[2]!))},id:globalThis[Symbol.for(${JSON.stringify(profile)})].homeRow}]},
          {id: 'host-group', insert: ${JSON.stringify([twin(packageRows[1]!)])}}
        ] : [],
        readBundlePatches: () => [{insert:[{id:'host-group',name:'host',group:true,config:[]}]}],
        composeEntries: ([base,bundle]) => [...bundle[0].insert,
          ...(base[0]?.insert[0]?.id === 'host-group' ? [{...base[0].insert[0],config:bundle[1].insert}] : [])]
      })`,
        )
      const plugin = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
      const routes = new Map<string, (request: Request) => Promise<Response>>()
      let observed: unknown, observedHome: unknown
      plugin.apply({
        profileContext: { dir: profile, patchPath, home, overlays: [] },
        connection: {
          browserPeer: {},
          fetch: { register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => routes.set(route.path, route.fetch) },
        },
        settings: { describe: () => [] },
        typertGateway: {
          async invoke({ method, args }: { method: string; args: { spec?: string; options?: { enabled: boolean } } }) {
            if (method === 'listBundles')
              return active
                ? [
                    {
                      name: packageName,
                      source: 'file:' + active.spec,
                      version: active.version,
                      installed: true,
                      removable: true,
                      enabled,
                      // The current native bundle inventory omits entries inserted into a host group.
                      rows: [packageRows[0], { ...packageRows[2], rowId: state.homeRow }],
                    },
                  ]
                : []
            if (method === 'installBundle') {
              if (renamedHome && args.spec === previous.spec) {
                active = previous
                state.homeRow = 'home-owned'
                enabled = false
                await lock(previous)
                return { application: 'applied', bundle: packageName }
              }
              if (args.spec !== next.spec) return { application: 'failed' }
              expect(args.options?.enabled).toBe(false)
              if (!replacing) expect(args.options).toHaveProperty('expected', { name: packageName, version: next.version })
              expect(await readFile(patchPath, 'utf8')).toBe(patch)
              freshInstallations++
              if (renamedHome) state.homeRow = 'home-renamed'
              active = next
              enabled = false
              await lock(next)
              return { application: 'applied', bundle: packageName }
            }
            if (method === 'removeBundle') {
              active = undefined
              enabled = false
              return { application: 'applied' }
            }
            if (method === 'setBundleEnabled') {
              observed = parse(await readFile(patchPath, 'utf8'))
              observedHome = parse(await readFile(homePath, 'utf8'))
              if (scenario === 'restore') {
                expect(JSON.parse(await readFile(intentPath, 'utf8'))).toMatchObject({
                  configured: true,
                  effects: [
                    {
                      rowId: 'owned',
                      layer: 'profile',
                      additions: [
                        { keys: ['nested', 'note'], value: 'sample\n' },
                        { keys: ['added'], value: 'true\n' },
                      ],
                    },
                    { rowId: 'second', layer: 'profile', created: true, additions: [{ keys: [], value: expect.stringContaining('factory: 12') }] },
                    { rowId: 'home-owned', layer: 'home', additions: [{ keys: ['verified'], value: 'true\n' }] },
                  ],
                })
                return { application: 'failed' }
              }
              enabled = true
              return { application: 'restart-required' }
            }
            throw new Error('Unexpected native RPC ' + method)
          },
        },
      })
      const body = JSON.stringify({
        type: 'client-request',
        rpcId: 'fixture',
        method: 'pluginManager/installBundle',
        payload: {
          args: {
            spec: next.spec,
            options: { requestId: 'once' },
            ...(scenario === 'renamed-home-without-defaults'
              ? {}
              : {
                  installDefaults: { packageName, version: next.version, integrity: next.integrity, entries: defaults },
                }),
            ...(replacing ? { replacement: { packageName, previous: { ...previous, enabled: true }, next, authorizationUrl: 'data:,allowed' } } : {}),
          },
        },
      })
      const request = async (path: string, signed: boolean) => {
        const auth = signed ? authority.authorize(identity, body) : undefined
        const response = await routes.get(path)!(
          new Request('http://member.example' + path, {
            method: 'POST',
            body,
            headers: auth ? { 'x-phalanx-install-proof': auth.proof, 'x-phalanx-install-signature': auth.signature } : {},
          }),
        )
        return (await response.json()).result
      }
      expect(await request(NATIVE_PLATFORM_INSTALL_PATH, false)).toMatchObject({ ok: false })
      expect(freshInstallations).toBe(0)
      const browserRpc = async (method: string, args: object = {}) => {
        const path = '/api/pluginManager/' + method
        const response = await routes.get(path)!(
          new Request('http://member.example' + path, {
            method: 'POST',
            body: JSON.stringify({ type: 'client-request', rpcId: 'browser', method: 'pluginManager/' + method, payload: { args } }),
          }),
        )
        return (await response.json()).result
      }
      if (scenario === 'personal') {
        expect((await browserRpc('listBundles')).value[0]).not.toHaveProperty('installDefaultsPending')
        expect(await request(NATIVE_PLATFORM_INSTALL_PATH, true)).toMatchObject({ ok: true, value: { error: { code: 'install-defaults-target-changed' } } })
        expect(freshInstallations).toBe(0)
        expect(active).toEqual(next)
        expect(await readFile(patchPath, 'utf8')).toBe(patch)
        expect(await readFile(homePath, 'utf8')).toBe(homePatch)
        return
      }
      if (scenario === 'stale') {
        expect((await browserRpc('listBundles')).value[0]).toHaveProperty('installDefaultsPending', 'a'.repeat(64))
        expect(await request(NATIVE_PLATFORM_INSTALL_PATH, true)).toMatchObject({ ok: true, value: { error: { code: 'install-defaults-target-changed' } } })
        expect(await browserRpc('removeBundle', { name: packageName })).toMatchObject({ ok: true, value: { application: 'applied' } })
        await expect(readFile(intentPath)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(active).toBeUndefined()
        expect(parse(await readFile(patchPath, 'utf8'))).toEqual([
          { id: 'owned', config: { mode: 'readonly', nested: { count: 4, note: 'member' }, values: [], blank: null } },
          { id: 'unrelated', config: { enabled: false } },
          { id: 'home-owned', config: { lower: true } },
          { id: 'owned', config: { added: true, newer: 'member override' } },
        ])
        expect(parse(await readFile(homePath, 'utf8'))).toEqual([
          { id: 'home-owned', config: { member: 5 } },
          { id: 'home-other', config: { retain: true } },
        ])
        return
      }
      if (scenario === 'resume') {
        expect((await browserRpc('listBundles')).value[0]).toHaveProperty('installDefaultsPending', fingerprint)
        expect(await browserRpc('setBundleEnabled', { name: packageName, enabled: true })).toMatchObject({ ok: false })
      }
      if (renamedHome) {
        expect(await request(NATIVE_PLATFORM_INSTALL_PATH, true)).toMatchObject({
          ok: true,
          value: { replacement: 'restored', reason: 'settings-incompatible' },
        })
        expect(active).toEqual(previous)
        expect(enabled).toBe(true)
        expect(await readFile(patchPath, 'utf8')).toBe(patch)
        expect(await readFile(homePath, 'utf8')).toBe(homePatch)
        return
      }
      const outcome =
        scenario === 'restore'
          ? { ok: true, value: { error: { code: 'install-defaults-activation-failed' } } }
          : { ok: true, value: { application: 'restart-required' } }
      expect(await request(NATIVE_PLATFORM_INSTALL_PATH, true)).toMatchObject(outcome)
      expect(await request(NATIVE_PLATFORM_INSTALL_PATH, true)).toMatchObject(outcome)
      expect(freshInstallations).toBe(scenario === 'resume' ? 0 : 1)
      await expect(readFile(intentPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(observed).toEqual([
        { id: 'owned', config: { mode: 'readonly', nested: { count: 0, note: 'sample' }, values: [], blank: null, added: true } },
        { id: 'unrelated', config: { enabled: false } },
        { id: 'home-owned', config: { lower: true } },
        { id: 'second', name: packageName, config: { factory: 12, mixed: [null, false, 5, 'word', { fine: 3 }] } },
      ])
      expect(observedHome).toEqual([
        { id: 'home-owned', config: { member: 0, verified: true } },
        { id: 'home-other', config: { retain: true } },
      ])
      expect(await readFile(patchPath, 'utf8')).toContain('# member choice')
      expect(await readFile(patchPath, 'utf8')).not.toContain('phalanx-install-defaults:')
      expect(await readFile(homePath, 'utf8')).not.toContain('phalanx-install-defaults:')
      expect(await readFile(homePath, 'utf8')).toContain('# home settings')
      if (scenario === 'restore') {
        expect(active).toBeUndefined()
        expect(await readFile(patchPath, 'utf8')).toBe(patch)
        expect(await readFile(homePath, 'utf8')).toBe(homePatch)
      }
    } finally {
      Reflect.deleteProperty(globalThis, rowKey)
      await rm(profile, { recursive: true, force: true })
    }
  },
)
