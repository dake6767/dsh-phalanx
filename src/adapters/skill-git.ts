import { outboundProxyEnvironment } from './outbound-proxy.js'
import { gitSupervisor } from './skill-git-supervisor.js'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, lstat, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillGitRepositoryPort } from '../ports/skill-git.js'
import type { SkillGitTarget } from '../domain/skill-git-source.js'
import { SkillArchiveError } from '../domain/skill-library.js'
import { SKILL_IMPORT_MAX_BYTES } from '../domain/skill-import.js'

const failure = (reason: string) => new SkillArchiveError('skill-archive-invalid', reason)
const flags = ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'credential.interactive=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false', '-c', 'filter.lfs.required=false', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'submodule.recurse=false']

/** Owns bounded anonymous Git subprocesses; never runs repository scripts or user Git configuration. */
export class GitSkillRepository implements SkillGitRepositoryPort {
  private recovery: Promise<void> | undefined
  constructor(private readonly root: string, private readonly options: { readonly timeoutMs?: number, readonly maxBytes?: number, readonly proxy?: string | undefined, readonly caFile?: string | undefined } = {}) {}
  async read(source: SkillGitTarget, outer: AbortSignal) {
    outer.throwIfAborted(); await this.recover()
    if (new URL(source.url).protocol !== 'https:') throw failure('Only public HTTPS repositories are supported.')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const stage = await mkdtemp(join(this.root, 'git-')), repository = join(stage, 'repository'), controller = new AbortController()
    const signal = AbortSignal.any([outer, controller.signal]), limit = Math.min(this.options.maxBytes ?? SKILL_IMPORT_MAX_BYTES, SKILL_IMPORT_MAX_BYTES)
    const timer = setTimeout(() => controller.abort(failure('Git import exceeded the 120 second deadline.')), Math.min(this.options.timeoutMs ?? 120_000, 120_000))
    // Git's pack limit is also monitored during transfer, before checkout can allocate more files.
    let checking: Promise<void> | undefined
    const monitor = setInterval(() => { checking ??= this.size(stage, signal).then(size => { if (size > limit) controller.abort(new SkillArchiveError('skill-upload-too-large', 'The repository must be at most 100 MB.')) }).catch(error => { if (!signal.aborted) controller.abort(error) }).finally(() => { checking = undefined }) }, 100)
    const marker = join(stage, 'process.pid')
    const env = { PATH: process.env.PATH, HOME: stage, XDG_CONFIG_HOME: stage, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false', GIT_LFS_SKIP_SMUDGE: '1', LC_ALL: 'C',
      ...outboundProxyEnvironment(this.options.proxy === undefined ? process.env : { ...process.env, HTTPS_PROXY: this.options.proxy, https_proxy: this.options.proxy }), ...(this.options.caFile ? { GIT_SSL_CAINFO: this.options.caFile } : {}) }
    try {
      if (source.tree) {
        const refs = (await this.run(['ls-remote', '--heads', '--tags', '--', source.url], stage, env, signal, marker)).toString('utf8').split('\n').map(line => line.split('\t')[1]?.replace(/^refs\/(?:heads|tags)\//u, '')).filter((ref): ref is string => !!ref && !ref.endsWith('^{}'))
        const ref = refs.filter(ref => source.tree === ref || source.tree!.startsWith(ref + '/')).sort((a, b) => b.length - a.length)[0]
        if (!ref) throw failure('The GitHub tree URL does not match a public branch or tag. Use owner/repo/subpath#ref for an exact revision.')
        source = { url: source.url, ref, subpath: source.tree.slice(ref.length).replace(/^\//u, '') }
      }
      const exactCommit = /^[a-f0-9]{40,64}$/iu.test(source.ref)
      if (exactCommit) {
        // A pinned import must not transfer the unrelated current default branch first.
        await this.run(['init', '--template=', repository], stage, env, signal, marker)
        await this.run(['fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--', source.url, source.ref], repository, env, signal, marker)
      } else await this.run(['clone', '--depth', '1', '--no-checkout', '--no-recurse-submodules', '--template=', ...(source.ref ? ['--branch', source.ref] : []), '--', source.url, repository], stage, env, signal, marker)
      const revision = exactCommit ? 'FETCH_HEAD' : 'HEAD'
      const commit = (await this.run(['rev-parse', revision], repository, env, signal, marker)).toString('utf8').trim()
      if (!/^[a-f0-9]{40,64}$/u.test(commit)) throw failure('Git did not resolve a commit.')
      await this.run(['checkout', '--detach', commit], repository, env, signal, marker)
      if (await this.size(stage, signal) > limit) throw new SkillArchiveError('skill-upload-too-large', 'The repository must be at most 100 MB.')
      const files: { path: string, bytes: Uint8Array }[] = [], paths = new Set<string>(), links: string[] = []; let bytes = 0
      const walk = async (relative: string): Promise<void> => {
        for (const entry of await readdir(join(repository, relative), { withFileTypes: true })) {
          signal.throwIfAborted()
          if (!relative && entry.name === '.git') continue
          const path = relative ? relative + '/' + entry.name : entry.name
          if (path.length > 1024 || /[\\:]/u.test(path) || [...path].some(char => char.charCodeAt(0) < 32) || paths.has(path.toLowerCase())) throw failure('The repository contains unsafe or case-conflicting paths.')
          paths.add(path.toLowerCase())
          if (paths.size > 10000) throw failure('The repository contains too many files.')
          if (entry.isDirectory()) await walk(path)
          else if (entry.isFile()) {
            const content = await readFile(join(repository, path)); bytes += content.length
            if (bytes > limit) throw new SkillArchiveError('skill-upload-too-large', 'The repository must be at most 100 MB.')
            files.push({ path, bytes: content })
          } else if (entry.isSymbolicLink()) links.push(path)
          else throw failure('Links and special files are not allowed in imported repositories.')
        }
      }
      await walk(''); signal.throwIfAborted()
      return { target: source, commit, files, links }
    } finally { clearTimeout(timer); clearInterval(monitor); await checking; await rm(stage, { recursive: true, force: true }) }
  }
  recover(): Promise<void> {
    this.recovery ??= this.cleanInterrupted().catch(error => { this.recovery = undefined; throw error })
    return this.recovery
  }
  private async cleanInterrupted(): Promise<void> {
    let entries
    try { entries = await readdir(this.root, { withFileTypes: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^git-[a-zA-Z0-9]{6}$/u.test(entry.name)) continue
      const stage = join(this.root, entry.name)
      let pid: number | undefined
      try { const value = await readFile(join(stage, 'process.pid'), 'utf8'); if (!/^[1-9][0-9]*$/u.test(value)) throw failure('Invalid interrupted Git process identity.'); pid = Number(value) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (pid !== undefined) {
        let alive = true
        try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error }
        if (alive) throw failure('An interrupted Git import is still stopping. Retry after its process exits.')
      }
      await rm(stage, { recursive: true, force: true })
    }
  }
  private async size(path: string, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted()
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error }
    let total = 0
    for (const entry of entries) {
      signal.throwIfAborted()
      const target = join(path, entry.name)
      if (entry.isDirectory()) total += await this.size(target, signal)
      else if (entry.isFile()) { try { total += (await lstat(target)).size } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
    }
    return total
  }
  private run(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, marker: string): Promise<Buffer> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', gitSupervisor, marker, ...flags, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'ignore', 'ipc'], detached: true })
      const chunks: Buffer[] = []; let size = 0, tooLarge = false
      const abort = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL') } } }
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
      child.stdout!.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) { tooLarge = true; abort() } else chunks.push(chunk) })
      child.once('error', () => { signal.removeEventListener('abort', abort); reject(failure('Git is unavailable. Install Git on the platform host.')) })
      child.once('close', code => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) reject(signal.reason)
        else if (code === 127) reject(failure('Git is unavailable. Install Git on the platform host.'))
        else if (code !== 0 || tooLarge) reject(failure('Cannot read this public repository or ref. Private repositories, authentication and redirects are unsupported.'))
        else resolve(Buffer.concat(chunks))
      })
    })
  }
}
