import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { nativePackageManager } from '../src/dsh/native-package-cache.js'
import { MemberNativePackageCache } from '../src/adapters/member-native-package-cache.js'

const run = promisify(execFile)

it('stages a sealed runtime seed as writable member scratch and leaves the source sealed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sealed-native-seed-'))
  const directory = join(root, 'seed')
  const metadata = join(directory, 'metadata')
  const store = join(directory, 'store/v11')
  const runtime = join(root, 'container')
  let staged: string | undefined
  const plugin = {
    packageName: 'fixture-plugin',
    version: '1.0.0',
    integrity: 'fixture-integrity',
    artifact: 'fixture',
    runtimeRevision: 'runtime',
    title: 'Fixture',
    description: '',
    bundlePatch: '[]',
    dependencies: {},
  }
  try {
    await mkdir(metadata, { recursive: true })
    await mkdir(store, { recursive: true })
    await writeFile(join(metadata, 'registry.jsonl'), 'shared')
    const index = new DatabaseSync(join(store, 'index.db'))
    index.exec('PRAGMA journal_mode=WAL; CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID;')
    index.close()
    await chmod(join(metadata, 'registry.jsonl'), 0o444)
    await chmod(join(store, 'index.db'), 0o444)
    await chmod(metadata, 0o555)
    await chmod(store, 0o555)
    await writeFile(runtime, '#!/bin/sh\nshift\nif [ "$1" = -i ]; then shift; fi\nshift\nexec "$@"\n', { mode: 0o700 })
    const cache = new MemberNativePackageCache(
      { runtime, image: 'fixture', internalPort: 4180, gatewayPort: 18081 },
      {
        list: async () => [
          {
            ...plugin,
            source: { kind: 'npm' },
            current: plugin,
            stage: 'available',
            published: false,
            suiteOrigin: 'suite:fixture',
            suiteResourceBindings: [
              {
                kind: 'native-package-cache',
                dependency: 'seed',
                runtimeDependency: 'seed',
                path: '.',
                version: '1.0.0',
                contentHash: 'a'.repeat(64),
                packages: [{ packageName: 'child', version: '1.0.0' }],
              },
            ],
          },
        ],
      },
      {
        withPrepared: async (_names, operation) =>
          operation([
            {
              id: 'seed',
              identity: 'seed',
              directory,
              mountedPath: directory,
              pathDirectories: [],
              commands: [],
              commandPaths: {},
              bytes: 1,
              isolated: true,
              checks: [],
              log: '',
            },
          ]),
      },
    )
    const instance = { userId: 'member', processId: 1, origin: 'http://localhost', launchUrl: 'http://localhost', containerName: 'fixture' }
    await cache.use(instance, plugin, plugin.integrity, new AbortController().signal, async input => {
      const stage = input!.directory
      staged = stage
      const database = new DatabaseSync(join(stage, 'store/v11/index.db'), { readOnly: true })
      try {
        expect(database.prepare('SELECT key FROM package_index').all()).toEqual([])
      } finally {
        database.close()
      }
      await writeFile(join(stage, 'metadata/registry.jsonl'), 'private')
      await writeFile(join(stage, 'metadata/registry-alias.jsonl'), 'private')
    })
    await expect(stat(staged!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(metadata, 'registry.jsonl'), 'utf8')).toBe('shared')
    expect((await stat(metadata)).mode & 0o777).toBe(0o555)
  } finally {
    await chmod(metadata, 0o755).catch(() => {})
    await chmod(store, 0o755).catch(() => {})
    if (staged) {
      await chmod(join(staged, 'metadata'), 0o755).catch(() => {})
      await chmod(join(staged, 'store/v11'), 0o755).catch(() => {})
      await rm(staged, { force: true, recursive: true })
    }
    await rm(root, { force: true, recursive: true })
  }
})

it('applies signed-operation pins to only the matching native add and restores the workspace on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-pnpm-test-'))
  const generation = randomUUID()
  const handoff = '/tmp/phalanx-native-package-' + createHash('sha256').update(generation).digest('hex').slice(0, 32) + '.json'
  const cache = await mkdtemp('/tmp/phalanx-native-cache-test')
  const spec = '/member/native.tgz'
  const workspace = join(root, 'pnpm-workspace.yaml')
  const wrapper = join(root, 'native-pnpm.mjs')
  const previous = 'overrides:\n  other>child: 1.0.0\n'
  try {
    await mkdir(join(root, 'pnpm-cache/v12'), { recursive: true })
    await writeFile(join(root, 'pnpm-cache/v12/existing.json'), '{}')
    const seedRegistry = join(cache, 'metadata/v12/metadata/https%3A+registry.npmjs.org')
    const currentRegistry = join(root, 'pnpm-cache/v12/metadata/https%3A+registry.npmmirror.com')
    await Promise.all([seedRegistry, currentRegistry].map(path => mkdir(path, { recursive: true })))
    const seed = { name: 'child', versions: { '2.0.0': { name: 'child', version: '2.0.0', dist: { integrity: 'seed-version' } } } }
    const index = Buffer.from(JSON.stringify({ name: seed.name, versions: [['2.0.0', 0, Buffer.byteLength(JSON.stringify(seed.versions['2.0.0']))]] }))
    await writeFile(
      join(seedRegistry, 'child.jsonl'),
      Buffer.concat([Buffer.from('pnpm-meta-v1 2 ' + index.length + '\n{}'), index, Buffer.from(JSON.stringify(seed.versions['2.0.0']))]),
    )
    const current = { name: 'child', versions: { '1.0.0': { name: 'child', version: '1.0.0', dist: { integrity: 'member-version' } } } }
    await writeFile(join(currentRegistry, 'child.jsonl'), '{}\n' + JSON.stringify(current))
    await mkdir(join(cache, 'store/v11/files'), { recursive: true })
    await writeFile(join(cache, 'store/v11/files/seed-object'), 'locked')
    const seedStore = new DatabaseSync(join(cache, 'store/v11/index.db'))
    try {
      seedStore.exec("CREATE TABLE package_index (key TEXT PRIMARY KEY,data BLOB NOT NULL) WITHOUT ROWID; INSERT INTO package_index VALUES ('fixture',x'0102')")
    } finally {
      seedStore.close()
    }
    const yaml = pathToFileURL(createRequire(import.meta.url).resolve('yaml')).href
    await writeFile(wrapper, nativePackageManager(generation, yaml))
    await writeFile(workspace, previous)
    await writeFile(
      join(root, 'pnpm'),
      '#!/bin/sh\nif [ "$1" = store ]; then printf "%s\\n" "$PWD/pnpm-store/v11"; exit 0; fi\nif [ "$1" = cache ]; then printf "%s\\n" "$PWD/pnpm-cache"; exit 0; fi\nif [ "$1" = config ]; then printf "%s\\n" "https://registry.npmmirror.com"; exit 0; fi\nprintf "%s\\n" "${PNPM_CONFIG_OFFLINE-unset}"\ncat pnpm-workspace.yaml\nexit "${FIXTURE_EXIT-0}"\n',
      {
        mode: 0o700,
      },
    )
    await writeFile(
      handoff,
      JSON.stringify({
        spec,
        expires: Date.now() + 30_000,
        cache: { directory: cache, owner: { packageName: 'native', version: '1.0.0' }, packages: [{ packageName: 'child', version: '2.0.0' }] },
      }),
      { flag: 'wx', mode: 0o600 },
    )
    const env = { PATH: root + ':/usr/bin:/bin' }
    const ordinary = await run(process.execPath, [wrapper, 'add', '/member/personal.tgz'], { cwd: root, env })
    expect(ordinary.stdout).toBe('unset\n' + previous)
    await expect(run(process.execPath, [wrapper, 'add', spec], { cwd: root, env: { ...env, FIXTURE_EXIT: '1' } })).rejects.toMatchObject({ code: 1 })
    expect(await readFile(workspace, 'utf8')).toBe(previous)
    const locked = await run(process.execPath, [wrapper, 'add', spec], { cwd: root, env })
    expect(await readFile(join(root, 'pnpm-store/v11/files/seed-object'), 'utf8')).toBe('locked')
    expect(await readFile(join(cache, 'metadata/v12/existing.json'), 'utf8')).toBe('{}')
    const merged = await readFile(join(cache, 'metadata/v12/metadata/https%3A+registry.npmmirror.com/child.jsonl'), 'utf8')
    expect(JSON.parse(merged.split('\n')[1]!).versions).toEqual({ ...seed.versions, ...current.versions })
    expect(await readFile(join(currentRegistry, 'child.jsonl'), 'utf8')).toBe('{}\n' + JSON.stringify(current))
    expect(locked.stdout).toMatch(/^true\noverrides:/u)
    expect(await readFile(workspace, 'utf8')).toContain('native@1.0.0>child: 2.0.0')
    expect(await readFile(workspace, 'utf8')).toContain('other>child: 1.0.0')
  } finally {
    await Promise.all([rm(root, { force: true, recursive: true }), rm(cache, { force: true, recursive: true }), rm(handoff, { force: true })])
  }
})
