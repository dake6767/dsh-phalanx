import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFileText } from '../../src/adapters/runtime-command.js'
import { packedPlugin } from '../../src/adapters/plugin-source-packer.js'
import { pluginSourcePacking } from '../../src/dsh/plugin-source-pack.js'
import type { PluginSourcePackerPort } from '../../src/ports/plugin-source.js'

/** `head` overrides the default-branch commit the API reports, while the archive stays served for `commit`. */
export type FakeGithubRepository =
  { readonly commit: string; readonly head?: string; readonly files: Readonly<Record<string, string>> } | { readonly status: number }

/** Serves `<prefix>https://api.github.com/...` and `<prefix>https://github.com/.../archive/<sha>.tar.gz` like a GitHub proxy. */
export function fakeGithub() {
  const repositories = new Map<string, FakeGithubRepository>()
  const requests: string[] = []
  let apiStatus: number | undefined, archiveStatus: number | undefined
  const archive = async (repository: string, commit: string, files: Readonly<Record<string, string>>) => {
    const root = await mkdtemp(join(tmpdir(), 'fake-github-'))
    try {
      const top = `${repository.split('/')[1]}-${commit}`
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, top, path)), { recursive: true })
        await writeFile(join(root, top, path), content)
      }
      await execFileText('tar', ['-czf', join(root, 'source.tar.gz'), '-C', root, top], { timeout: 30_000 })
      const { readFile } = await import('node:fs/promises')
      return await readFile(join(root, 'source.tar.gz'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = request.url ?? ''
    const api = /^\/gh-api\/https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/commits\?per_page=1$/u.exec(url)
    const asset = /^\/gh-assets\/https:\/\/github\.com\/([^/]+\/[^/]+)\/archive\/([a-f0-9]{40})\.tar\.gz$/u.exec(url)
    if (!url.startsWith('/gh-api/') && !url.startsWith('/gh-assets/')) return false
    requests.push(url)
    const repository = repositories.get((api?.[1] ?? asset?.[1] ?? '').toLowerCase())
    const status = api ? apiStatus : archiveStatus
    if (status !== undefined || !repository || 'status' in repository || (!api && !asset)) {
      response.writeHead(status ?? (repository && 'status' in repository ? repository.status : 404))
      response.end()
      return true
    }
    if (api) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify([{ sha: repository.head ?? repository.commit }]))
      return true
    }
    if (asset![2] !== repository.commit) {
      response.writeHead(404)
      response.end()
      return true
    }
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(await archive(asset![1]!, repository.commit, repository.files))
    return true
  }
  return {
    requests,
    handle,
    setRepository: (repository: string, value: FakeGithubRepository) => repositories.set(repository.toLowerCase(), value),
    setApiStatus: (status: number | undefined) => {
      apiStatus = status
    },
    setArchiveStatus: (status: number | undefined) => {
      archiveStatus = status
    },
  }
}

/** Runs the production packing script with host Node and npm instead of the isolated container. */
export const hostPluginSourcePacker: PluginSourcePackerPort = {
  async pack(sourceArchive, directory, signal) {
    const output = join(directory, 'output'),
      scratch = join(directory, 'scratch')
    await mkdir(output)
    await mkdir(scratch)
    try {
      const result = await execFileText(process.execPath, ['--input-type=module', '-e', pluginSourcePacking, '--', '--pack', sourceArchive, output, scratch], {
        signal,
        timeout: 120_000,
        env: { PATH: process.env.PATH ?? '' },
      })
      return packedPlugin(result, output)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  },
}
