import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withSuiteCatalogContentHash, type SuiteCatalogDocumentEntry, type SuiteCatalogDownload, type SuiteCatalogItem } from '../../src/domain/suite-catalog-document.js'
import type { SuiteCatalogEntry } from '../../src/domain/suite-catalog.js'
import type { DownloadSourceSelection } from '../../src/domain/download-source.js'
import type { TrustedSuiteCatalogKey } from '../../src/domain/suite-catalog-signature.js'
import { createCatalogSigningKey, signCatalog, type CatalogSigningKey } from './suite-catalog-signing.js'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const strictVersion = (version: string): string => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ? version
  : `${version.split('.').filter(part => /^\d+$/u.test(part)).concat(['0', '0']).slice(0, 3).join('.')}`
/** The declarative check keeps commands and arguments as data; fixtures only use plain tokens. */
const check = (command: string | undefined): { command: string, args?: string[] } | undefined => {
  if (!command) return undefined
  const [name, ...args] = command.split(' ')
  return args.length ? { command: name!, args } : { command: name! }
}
const sealAll = (entries: readonly SuiteCatalogDocumentEntry[]): SuiteCatalogDocumentEntry[] => entries.map(entry => withSuiteCatalogContentHash(entry as never))

export interface SuiteCatalogServerFixture {
  readonly address: string
  readonly trustedKeys: readonly TrustedSuiteCatalogKey[]
  readonly downloadSources: DownloadSourceSelection
  /** Number of catalog document requests, so a test can prove an action did not touch the service. */
  requests(): number
  /** Makes the catalog endpoint answer HTTP 503 without closing the fixture. */
  fail(enabled: boolean): void
  /** Replaces the served document, e.g. to publish an update or changed content for the same version. */
  publish(entries: readonly SuiteCatalogDocumentEntry[]): void
  close(): Promise<void>
}

interface ServedCatalog {
  readonly fixture: SuiteCatalogServerFixture
  readonly key: CatalogSigningKey
  setBytes(bytes: Uint8Array): void
}

async function serve(entries: readonly SuiteCatalogDocumentEntry[], artifacts: ReadonlyMap<string, Buffer>): Promise<ServedCatalog> {
  const key = createCatalogSigningKey()
  let current = signCatalog(entries, key).bytes, failed = false, catalogRequests = 0
  const server: Server = createServer((request, response) => {
    const path = request.url ?? '/'
    if (path === '/catalog.json') {
      catalogRequests++
      if (failed) { response.writeHead(503); response.end(); return }
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': current.length }); response.end(current); return
    }
    const artifact = artifacts.get(decodeURIComponent(path.slice(1)))
    if (artifact) { response.writeHead(200, { 'content-length': artifact.length }); response.end(artifact); return }
    response.writeHead(404); response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The catalog fixture did not listen')
  const base = `http://127.0.0.1:${address.port}`
  return {
    key,
    setBytes(bytes) { current = Buffer.from(bytes) },
    fixture: {
      address: `${base}/catalog.json`,
      trustedKeys: [key],
      downloadSources: { preset: 'official', overrides: { githubAssets: `${base}/`, browser: `${base}/`, browserChromiumArm64: `${base}/` } },
      requests: () => catalogRequests,
      fail(enabled) { failed = enabled },
      publish(next) { current = signCatalog(sealAll(next), key).bytes },
      close: async () => { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) },
    },
  }
}

/**
 * Converts a 0.1.18-shaped fixture suite into the declarative online document, building each runtime artifact once.
 * Existing suite e2e keeps running on the real signed-catalog path instead of a test-only entry shortcut.
 */
export async function legacySuiteCatalogFixture(presets: readonly SuiteCatalogEntry[], extra: readonly SuiteCatalogDocumentEntry[] = []): Promise<SuiteCatalogServerFixture> {
  const artifacts = new Map<string, Buffer>()
  const entries: SuiteCatalogDocumentEntry[] = []
  for (const preset of presets) {
    const items: SuiteCatalogItem[] = []
    for (const item of preset.items) {
      if (item.kind !== 'runtime-dependency') { items.push(item as SuiteCatalogItem); continue }
      const built: [('amd64' | 'arm64'), string, string][] = []
      for (const architecture of ['amd64', 'arm64'] as const) {
        if (item.prepareCommands[architecture] === undefined) continue
        // A synthetic artifact with the declared layout; the real download commands and byte equivalence live in domain tests.
        const directory = await mkdtemp(join(tmpdir(), 'suite-catalog-artifact-'))
        try {
          const directories = item.pathDirectories.length ? [...item.pathDirectories] : ['bin']
          for (const subdirectory of directories) await mkdir(join(directory, subdirectory), { recursive: true })
          const primary = directories[0]!
          for (const command of item.commands.length ? item.commands : [item.name]) {
            const target = join(directory, primary, command)
            await writeFile(target, `#!/bin/sh\nprintf '%s\\n' "${command} fixture"\n`, { mode: 0o755 })
          }
          const archive = join(await mkdtemp(join(tmpdir(), 'suite-catalog-archive-')), 'artifact.tar.gz')
          execFileSync('tar', ['czf', archive, '-C', directory, ...await readdir(directory)])
          const bytes = await readFile(archive)
          const url = `https://github.com/dsh-phalanx-fixtures/${preset.id}/releases/download/v1/${item.name}-{arch}.tar.gz`.replaceAll('{arch}', architecture)
          artifacts.set(url, bytes)
          built.push([architecture, url, sha256(bytes)])
        } finally { await rm(directory, { recursive: true, force: true }) }
      }
      const parsed = check(item.checkCommand)
      const template = `https://github.com/dsh-phalanx-fixtures/${preset.id}/releases/download/v1/${item.name}-{arch}.tar.gz`
      // A partial architecture uses an explicit per-arch map: a single templated URL promises both architectures.
      const url = built.length === 2 ? template : Object.fromEntries(built.map(([architecture, artifactUrl]) => [architecture, artifactUrl]))
      items.push({
        kind: 'runtime-dependency', name: item.name, paths: [...item.pathDirectories], commands: [...item.commands], ...(parsed ? { check: parsed } : {}),
        downloads: [{ source: 'github-assets', url, sha256: Object.fromEntries(built.map(([architecture, , digest]) => [architecture, digest])),
          target: `${item.name}.tar.gz`, extract: { format: 'tar' } }],
      })
    }
    const common = { id: preset.id, version: strictVersion(preset.version), engines: { platform: '>=0.1.18' }, adapters: [] as string[],
      title: preset.title, description: preset.description, source: preset.source, items }
    entries.push(withSuiteCatalogContentHash(preset.category === 'suite'
      ? { kind: 'suite', ...common, identity: preset.identity, dependencies: [...preset.dependencies] }
      : { kind: 'dependency', ...common }))
  }
  return (await serve([...extra, ...entries], artifacts)).fixture
}

/** Serves explicit declarative entries with their downloaded artifacts, hashing the artifacts the tests built. */
export async function documentSuiteCatalogFixture(entries: readonly SuiteCatalogDocumentEntry[], artifacts: ReadonlyMap<string, Buffer>): Promise<SuiteCatalogServerFixture> {
  const servedArtifacts = new Map(artifacts)
  return (await serve(entries.map(entry => rewriteDocumentEntry(entry, servedArtifacts)), servedArtifacts)).fixture
}

/** Serves fixed bytes with a chosen trust list, for signature and format rejection scenarios. */
export async function rawSuiteCatalogFixture(bytes: Uint8Array, trustedKeys?: readonly TrustedSuiteCatalogKey[]): Promise<SuiteCatalogServerFixture> {
  const served = await serve([], new Map())
  served.setBytes(bytes)
  return { ...served.fixture, ...(trustedKeys ? { trustedKeys } : {}) }
}

export async function signedBytes(entries: readonly SuiteCatalogDocumentEntry[], key: CatalogSigningKey): Promise<Uint8Array> {
  return signCatalog(entries, key).bytes
}

export function throwawaySigningKey(): CatalogSigningKey { return createCatalogSigningKey('untrusted-catalog-key') }

function rewriteDocumentEntry(entry: SuiteCatalogDocumentEntry, artifacts: ReadonlyMap<string, Buffer>): SuiteCatalogDocumentEntry {
  if (entry.kind !== 'suite' && entry.kind !== 'dependency') return entry
  const items = entry.items.map(item => {
    if (item.kind !== 'runtime-dependency') return item
    const downloads = item.downloads.map(download => {
      if (download.source === 'npm' || download.source === 'pypi') return download
      const sha256ByArch: Partial<Record<'amd64' | 'arm64', string>> = {}
      for (const architecture of ['amd64', 'arm64'] as const) {
        const rawUrl = typeof download.url === 'string'
          ? download.url.replaceAll('{arch}', architecture).replaceAll('{nodeArch}', architecture === 'amd64' ? 'x64' : 'arm64')
          : download.url?.[architecture]
        if (rawUrl === undefined) continue
        const artifact = artifacts.get(rawUrl)
        if (artifact) sha256ByArch[architecture] = sha256(artifact)
      }
      return { ...download, sha256: sha256ByArch } satisfies SuiteCatalogDownload
    })
    return { ...item, downloads }
  })
  return withSuiteCatalogContentHash({ ...entry, items } as never)
}

/** Small executables the four declarative fixtures need; the platform installs them like real downloads. */
export async function buildBaseFieldArtifacts(): Promise<Map<string, Buffer>> {
  const root = await mkdtemp(join(tmpdir(), 'suite-catalog-base-fields-'))
  const artifacts = new Map<string, Buffer>()
  const script = (name: string): string => `#!/bin/sh\nprintf '%s\\n' "${name} fixture"\n`
  const tar = async (files: Readonly<Record<string, string>>): Promise<Buffer> => {
    const directory = join(root, `tar-${artifacts.size}`)
    for (const [path, body] of Object.entries(files)) {
      const target = join(directory, path)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, body, { mode: 0o755 })
    }
    const archive = join(root, `archive-${artifacts.size}.tar.gz`)
    execFileSync('tar', ['czf', archive, '-C', directory, ...await readdir(directory)])
    return readFile(archive)
  }
  const zip = async (files: Readonly<Record<string, string>>): Promise<Buffer> => {
    const directory = join(root, `zip-${artifacts.size}`)
    for (const [path, body] of Object.entries(files)) {
      const target = join(directory, path)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, body, { mode: 0o755 })
    }
    const archive = join(root, `archive-${artifacts.size}.zip`)
    execFileSync('zip', ['-qry', archive, '.'], { cwd: directory })
    return readFile(archive)
  }
  // The real release archives keep `pandoc-<version>/bin/pandoc`; --strip-components=2 extracts that binary into bin/.
  artifacts.set('https://github.com/jgm/pandoc/releases/download/3.12.1/pandoc-3.12.1-linux-amd64.tar.gz', await tar({ 'pandoc-3.12.1/bin/pandoc': script('pandoc') }))
  artifacts.set('https://github.com/jgm/pandoc/releases/download/3.12.1/pandoc-3.12.1-linux-arm64.tar.gz', await tar({ 'pandoc-3.12.1/bin/pandoc': script('pandoc') }))
  for (const architecture of ['x64', 'arm64'] as const) {
    artifacts.set(`https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-${architecture}`, Buffer.from(script('ffmpeg')))
    artifacts.set(`https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-linux-${architecture}`, Buffer.from(script('ffprobe')))
  }
  artifacts.set('builds/cft/153.0.8010.12/linux64/chrome-headless-shell-linux64.zip', await zip({ 'chrome-headless-shell-linux64/chrome-headless-shell': script('chromium') }))
  artifacts.set('builds/chromium/1243/chromium-headless-shell-linux-arm64.zip', await zip({ 'chrome-linux/headless_shell': script('chromium') }))
  return artifacts
}
