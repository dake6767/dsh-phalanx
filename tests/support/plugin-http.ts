import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { readBootstrapCredential } from '../../src/adapters/bootstrap-credential.js'
import { declaredRuntimeRevision } from '../../src/adapters/runtime-revision.js'
import type { PluginCandidate } from '../../src/domain/plugin-library.js'
import type { Clock } from '../../src/ports/clock.js'
import type { CommunityApplication } from '../../src/ports/community-application.js'
import { cleanupOwned, removeCommunityFixture } from '../fixtures/owned-cleanup.js'
import { createCommunityApplication } from './community-application.js'
import { fakeGithub, hostPluginSourcePacker } from './plugin-github.js'
import { execFileText } from '../../src/adapters/runtime-command.js'

/** One administrator application with a fake npm registry and an in-process preparer. */
let app: CommunityApplication | undefined, registry: Server | undefined, root: string | undefined
export async function stopPluginHttpApplication(): Promise<void> {
  const current = app
  app = undefined
  await current?.stop()
}
export function cleanupPluginHttpFixture(): Promise<void> {
  return cleanupOwned(
    async () => stopPluginHttpApplication(),
    async () => {
      if (registry) await new Promise<void>((resolve, reject) => registry!.close(error => (error ? reject(error) : resolve())))
      registry = undefined
    },
    async () => {
      if (root) await removeCommunityFixture(root)
      root = undefined
    },
  )
}

export async function pluginHttpFixture(
  options: { clock?: Clock; metadataUnavailable?: boolean; beforePrepare?: (input: PluginCandidate, signal: AbortSignal) => Promise<void> } = {},
) {
  const requests: string[] = [],
    preparations: PluginCandidate[] = []
  let latest = '1.0.0',
    metadataUnavailable = options.metadataUnavailable,
    metadataOverride: unknown = undefined
  let integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64'),
    uploadedPackage = 'uploaded-plugin'
  const github = fakeGithub()
  registry = createServer(async (request, response) => {
    if (await github.handle(request, response)) return
    requests.push(request.url!)
    if (metadataUnavailable) {
      response.writeHead(503)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    const name = decodeURIComponent(request.url!.slice('/registry/'.length))
    response.end(
      JSON.stringify(
        metadataOverride !== undefined
          ? metadataOverride
          : {
              name,
              'dist-tags': { latest },
              versions: {
                '1.0.0': { name, version: '1.0.0', dist: { integrity } },
                '2.0.0': { name, version: '2.0.0', dist: { integrity } },
              },
            },
      ),
    )
  })
  await new Promise<void>(resolve => registry!.listen(0, '127.0.0.1', resolve))
  const address = registry.address()
  if (!address || typeof address === 'string') throw Error('Missing registry fixture address')
  root = await mkdtemp(join(tmpdir(), 'plugin-intake-http-'))
  app = createCommunityApplication(
    {
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'plugin-intake-fictional-session-secret',
      downloadSources: {
        preset: 'official',
        overrides: {
          npm: `http://127.0.0.1:${address.port}/registry`,
          githubApi: `http://127.0.0.1:${address.port}/gh-api/`,
          githubAssets: `http://127.0.0.1:${address.port}/gh-assets/`,
        },
      },
      runtime: {
        command: '/unavailable-dsh',
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
      },
    },
    {
      ...(options.clock ? { clock: options.clock } : {}),
      pluginArchiveInspector: {
        inspect: async archive => (archive.includes('/incoming/') && (await packedIdentity(archive))) || { packageName: uploadedPackage, version: '1.0.0' },
      },
      pluginSourcePacker: hostPluginSourcePacker,
      pluginPreparer: {
        prepare: async (input, progress, signal) => {
          preparations.push(input)
          await progress('prechecking')
          await options.beforePrepare?.(input, signal)
          return {
            packageName: input.packageName,
            version: input.version,
            integrity: input.upload?.integrity ?? integrity,
            artifact: '/private/plugin-intake-artifact',
            runtimeRevision: declaredRuntimeRevision(),
            title: 'Reports',
            description: 'Reports fixture',
            dependencies: {},
            bundlePatch: '[]',
          }
        },
      },
    },
  )
  const origin = await app.start()
  const bootstrap = await fetch(origin + '/bootstrap', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }),
  })
  expect(bootstrap.status).toBe(303)
  const cookie = bootstrap.headers
    .getSetCookie()
    .map(value => value.split(';')[0])
    .join('; ')
  const request = (path: string, body?: unknown) =>
    fetch(origin + '/admin/api/' + path, {
      headers: { cookie, origin, 'content-type': 'application/json' },
      ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
    })
  const get = async (path: string) => {
    const response = await request(path)
    expect(response.status).toBe(200)
    return response.json()
  }
  const dataRoot = root
  return {
    github,
    dataRoot,
    requests,
    preparations,
    integrity,
    request,
    get,
    origin,
    cookie,
    setMetadata: (value: unknown) => {
      metadataOverride = value
    },
    setMetadataUnavailable: (value: boolean) => {
      metadataUnavailable = value
    },
    setIntegrity: (value: string) => {
      integrity = value
    },
    setLatest: (version: string) => {
      latest = version
    },
    setUploadedPackage: (name: string) => {
      uploadedPackage = name
    },
    upload: (replacing?: string) =>
      fetch(origin + '/admin/api/plugins/upload', {
        method: 'POST',
        headers: {
          cookie,
          origin,
          'content-type': 'application/gzip',
          'x-plugin-filename': 'fixture.tgz',
          ...(replacing ? { 'x-plugin-replace-package': replacing } : {}),
        },
        body: Buffer.from('uploaded-archive-fixture'),
      }),
  }
}

/** Reads an npm pack archive's identity; the uploaded-bytes fixture is not a tar archive and keeps its configured identity. */
async function packedIdentity(archive: string): Promise<{ packageName: string; version: string } | undefined> {
  try {
    const manifest = JSON.parse(await execFileText('tar', ['-xzOf', archive, 'package/package.json'], { timeout: 30_000 })) as { name: string; version: string }
    return { packageName: manifest.name, version: manifest.version }
  } catch {
    return undefined
  }
}
