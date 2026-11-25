import { spawn, execFileSync } from 'node:child_process'
import { createServer as httpsServer } from 'node:https'
import { createServer as httpServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

/** Local HTTPS smart-Git service reached through an explicit platform proxy; the host must be allow-listed by the checks. */
export async function gitFixture(options: { readonly host?: string; readonly repository?: string } = {}) {
  const host = options.host ?? 'git.example'
  // The repository path is part of the clone URL, so tests that parse GitHub owner/repository need two segments.
  const repository = options.repository ?? 'repository'
  const root = await mkdtemp(join(tmpdir(), 'skill-git-fixture-')),
    repo = join(root, repository),
    marker = join(root, 'executed')
  await mkdir(repo, { recursive: true })
  const git = (args: string[], cwd = repo) =>
    execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim()
  git(['init', '-b', 'main'])
  git(['config', 'uploadpack.allowReachableSHA1InWant', 'true'])
  git(['config', 'user.name', 'Fixture'])
  git(['config', 'user.email', 'fixture@example.test'])
  let fastImported = false
  let commitSeq = 0
  const formatFastImportPath = (rawPath: string): string => {
    const normalized = rawPath.replace(/^(?:\.\/)+/u, '').replace(/\/+/gu, '/')
    if (
      normalized === '' ||
      normalized.startsWith('/') ||
      normalized.endsWith('/') ||
      normalized.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new Error(`Invalid git fast-import path: ${rawPath}`)
    }
    let quoted = '"'
    for (const byte of Buffer.from(normalized, 'utf8')) {
      if (byte === 0x5c) quoted += '\\\\'
      else if (byte === 0x22) quoted += '\\"'
      else if (byte === 0x0a) quoted += '\\n'
      else if (byte === 0x0d) quoted += '\\r'
      else if (byte === 0x09) quoted += '\\t'
      else if (byte < 0x20 || byte >= 0x7f) quoted += `\\${byte.toString(8).padStart(3, '0')}`
      else quoted += String.fromCharCode(byte)
    }
    return `${quoted}"`
  }
  const fastImportCommit = (files: Record<string, string | null>) => {
    const headRef = git(['symbolic-ref', 'HEAD'])
    let parentSha: string | undefined
    try {
      parentSha = git(['rev-parse', '--verify', '--quiet', `${headRef}^{commit}`])
    } catch {
      parentSha = undefined
    }
    const timestamp = 1700000000 + ++commitSeq
    const chunks: Buffer[] = [Buffer.from(`commit ${headRef}\ncommitter Fixture <fixture@example.test> ${timestamp} +0000\ndata 7\nFixture\n`, 'utf8')]
    if (parentSha) chunks.push(Buffer.from(`from ${parentSha}\n`, 'utf8'))
    for (const [path, contents] of Object.entries(files)) {
      const formattedPath = formatFastImportPath(path)
      if (contents === null) {
        chunks.push(Buffer.from(`D ${formattedPath}\n`, 'utf8'))
      } else {
        const bytes = Buffer.from(contents, 'utf8')
        chunks.push(Buffer.from(`M 100644 inline ${formattedPath}\ndata ${bytes.length}\n`, 'utf8'), bytes, Buffer.from('\n', 'utf8'))
      }
    }
    execFileSync('git', ['fast-import', '--quiet'], {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      input: Buffer.concat(chunks),
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    })
    fastImported = true
    return git(['rev-parse', headRef])
  }
  const commit = async (files: Record<string, string | null>) => {
    const entries = Object.entries(files)
    if (fastImported) {
      if (entries.length === 0) throw new Error('Cannot mix empty working-tree commit with a fast-imported git fixture')
      return fastImportCommit(files)
    }
    if (entries.length >= 256) {
      return fastImportCommit(files)
    }
    for (const [path, contents] of entries) {
      const target = join(repo, path)
      if (contents === null) await rm(target, { force: true })
      else {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, contents)
      }
    }
    git(['add', '.'])
    git(['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'Fixture'])
    return git(['rev-parse', 'HEAD'])
  }
  await writeFile(
    join(root, 'cert.cnf'),
    `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${host}\n[ext]\nsubjectAltName=DNS:${host}\nbasicConstraints=critical,CA:TRUE\n`,
  )
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-config',
      join(root, 'cert.cnf'),
      '-keyout',
      join(root, 'key.pem'),
      '-out',
      join(root, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  )
  const backend = join(git(['--exec-path']), 'git-http-backend')
  let stall = false,
    entered!: () => void
  let requestStarted = new Promise<void>(resolve => {
    entered = resolve
  })
  const server = httpsServer({ key: await readFile(join(root, 'key.pem')), cert: await readFile(join(root, 'cert.pem')) }, (request, response) => {
    entered()
    if (stall) return
    const url = new URL(request.url!, `https://${host}`)
    const process = spawn(backend, [], {
      env: {
        PATH: '/usr/bin:/bin',
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        REQUEST_METHOD: request.method,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        CONTENT_LENGTH: request.headers['content-length'] ?? '',
        REMOTE_ADDR: '127.0.0.1',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    request.pipe(process.stdin)
    process.stdin.on('error', () => {})
    let buffer = Buffer.alloc(0),
      headers = false
    process.stdout.on('data', (chunk: Buffer) => {
      if (headers) {
        response.write(chunk)
        return
      }
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      for (const line of buffer.subarray(0, end).toString().split('\r\n')) {
        const separator = line.indexOf(':')
        const key = line.slice(0, separator),
          value = line.slice(separator + 1).trim()
        if (key.toLowerCase() === 'status') response.statusCode = Number(value.split(' ')[0])
        else response.setHeader(key, value)
      }
      headers = true
      response.write(buffer.subarray(end + 4))
    })
    process.on('close', () => response.end())
    process.on('error', () => {
      response.statusCode = 500
      response.end()
    })
    response.on('close', () => process.kill())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const proxy = httpServer()
  let connects = 0
  proxy.on('connect', (request, client, head) => {
    connects++
    if (request.url !== `${host}:443`) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const upstream = connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream).pipe(client)
    })
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
    client.on('close', () => upstream.destroy())
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  return {
    root,
    repo,
    marker,
    git,
    commit,
    caFile: join(root, 'cert.pem'),
    proxy: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
    url: `https://${host}/${repository}`,
    connects: () => connects,
    stall: () => {
      stall = true
      requestStarted = new Promise<void>(resolve => {
        entered = resolve
      })
      return requestStarted
    },
    close: async () => {
      server.closeAllConnections()
      proxy.closeAllConnections()
      await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))])
      await rm(root, { recursive: true, force: true })
    },
  }
}
