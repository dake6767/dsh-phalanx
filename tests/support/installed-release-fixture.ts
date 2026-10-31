import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { sha256, verifyDirectory } from '../../scripts/release/integrity.mjs'

type Manifest = {
  tag: string
  targetVersion: string
  runId: string
  commit: string
  dshRevision: string
  files: Record<string, string>
  image: { name: string; digest: string; reference: string }
  acceptancePolicy: { ticket: number; checks: string[] }
  updaterAsset: { name: string; sha256: string }
}

/** Private transport fixture for the installed formal-only Web updater before promotion.
 * Candidate manifest, updater and package bytes stay unchanged. Synthetic formal
 * metadata exists only in memory; it is never publication or acceptance evidence.
 */
export async function installedReleaseFixture(directory: string, candidate: string, tag: string, port = 0, releaseNotes?: string, host = '0.0.0.0') {
  const manifest = (await verifyDirectory(directory, { tag, commit: candidate })) as Manifest
  const manifestBytes = await readFile(join(directory, 'manifest.json'))
  const updater = await readFile(join(directory, 'updater.json'))
  if (manifest.updaterAsset?.name !== 'updater.json') throw Error('Installed update fixture requires the exact verified updater asset')
  const summary = 'Controlled installed-updater transport fixture. Not release acceptance.\n'
  const acceptance = JSON.stringify({
    schema: 1,
    status: 'accepted',
    ticket: manifest.acceptancePolicy.ticket,
    candidate: tag,
    commit: candidate,
    runId: manifest.runId,
    platformSha256: manifest.files['dsh-phalanx-linux-amd64.tar.gz'],
    imageDigest: manifest.image.digest,
    summarySha256: sha256(summary),
    checks: Object.fromEntries(manifest.acceptancePolicy.checks.map(check => [check, 'passed'])),
  })
  const release = JSON.stringify({
    schema: 1,
    version: manifest.targetVersion,
    versions: ['v' + manifest.targetVersion],
    candidate: tag,
    candidateRun: manifest.runId,
    commit: candidate,
    files: manifest.files,
    image: `${manifest.image.name}:${manifest.targetVersion}`,
    imageDigest: manifest.image.digest,
    acceptanceSha256: sha256(acceptance),
    summarySha256: sha256(summary),
    releaseNotes: releaseNotes ?? summary,
  })
  const base = 'https://github.com/dake6767/dsh-phalanx/releases'
  const version = 'v' + manifest.targetVersion
  const metadata = new Map<string, string | Buffer>([
    [`${base}/latest/download/release.json`, release],
    ...Object.entries({
      'release.json': release,
      'acceptance.json': acceptance,
      'acceptance.md': summary,
      'manifest.json': manifestBytes,
      SHA256SUMS: await readFile(join(directory, 'SHA256SUMS')),
      'updater.json': updater,
    }).map(([name, body]): [string, string | Buffer] => [`${base}/download/${version}/${name}`, body]),
    [`https://github.com/dake6767/dsh-phalanx-candidates/releases/download/${tag}/updater.json`, updater],
  ])
  const names = ['manifest.json', 'SHA256SUMS', ...Object.keys(manifest.files), 'acceptance.json', 'acceptance.md', 'release.json', 'updater.json']
  const oldRelease = JSON.stringify({
    tag_name: version,
    draft: false,
    prerelease: false,
    body: summary,
    assets: names.map(name => ({ name, browser_download_url: `${base}/download/${version}/${name}` })),
  })
  for (const suffix of ['latest', 'tags/' + version]) metadata.set('https://api.github.com/repos/dake6767/dsh-phalanx/releases/' + suffix, oldRelease)
  const files = new Map(Object.keys(manifest.files).map(name => [`${base}/download/${version}/${name}`, join(directory, name)]))
  const requests: string[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const url = (request.url ?? '').slice(1)
      requests.push(url)
      if (request.method !== 'GET') {
        response.writeHead(405)
        response.end()
        return
      }
      const body = metadata.get(url),
        path = files.get(url)
      if (body !== undefined) {
        response.writeHead(200, { 'content-length': Buffer.byteLength(body) })
        response.end(body)
        return
      }
      if (path) {
        response.writeHead(200, { 'content-length': (await stat(path)).size })
        await pipeline(createReadStream(path), response)
        return
      }
      response.writeHead(404)
      response.end()
    })().catch(() => response.destroy())
  })
  server.listen(port, host)
  await once(server, 'listening')
  return {
    manifest,
    manifestSha256: sha256(manifestBytes),
    requests,
    port: (server.address() as { port: number }).port,
    async close() {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
