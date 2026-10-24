import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RuntimeDependencyVersion } from '../domain/runtime-dependency.js'

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

/** A copied interpreter identifies this venv; its ordered .pth uses only the selected immutable libraries. */
export async function preparePythonLibraryEnvironment(directory: string, mounted: string, versions: readonly RuntimeDependencyVersion[]): Promise<boolean> {
  const libraries = versions.filter(version => version.python).sort((a, b) => a.python!.name < b.python!.name ? -1 : a.python!.name > b.python!.name ? 1 : 0)
  const first = libraries[0]
  if (!first) return false
  if (libraries.some(version => version.python!.abi !== first.python!.abi)) throw new Error('Python library interpreters have incompatible ABIs')
  const venv = join(directory, '.python'), mountedVenv = `${mounted}/.python`, interpreter = join(venv, 'bin/python3')
  await mkdir(dirname(interpreter), { recursive: true })
  await copyFile(join(first.directory, first.python!.interpreter), interpreter)
  await copyFile(join(first.directory, 'venv/pyvenv.cfg'), join(venv, 'pyvenv.cfg'))
  const sitePackages = join(venv, first.python!.sitePackages.slice('venv/'.length))
  await mkdir(sitePackages, { recursive: true })
  const paths = libraries.map(version => `${version.mountedPath}/${version.python!.sitePackages}`)
  await writeFile(join(sitePackages, 'phalanx-libraries.pth'), 'import site; ' + paths.map(path => `site.addsitedir(${JSON.stringify(path)})`).join('; ') + '\n')
  await writeFile(join(directory, 'python3'), `#!/bin/sh\nexec ${quote(mountedVenv + '/bin/python3')} "$@"\n`, { mode: 0o555 })
  return true
}

interface PythonLibraryMount { readonly host: string, readonly mounted: string, readonly readOnly: true }

/** Private per-call venvs share the process owner's reclamation barrier, including recovery after a restart. */
export class FilePythonLibraryEnvironments {
  private readonly active = new Set<string>()
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly root: string, private readonly canDiscard: () => boolean) {}
  async withEnvironment<T>(versions: readonly RuntimeDependencyVersion[], isolated: boolean, run: (mount?: PythonLibraryMount) => Promise<T>): Promise<T> {
    if (!versions.some(version => version.python)) return run()
    const host = await this.serial(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const directory = await mkdtemp(join(this.root, 'run-')); this.active.add(directory); return directory
    })
    const mount = { host, mounted: isolated ? '/dsh-phalanx/python-libraries' : host, readOnly: true as const }
    try { await preparePythonLibraryEnvironment(host, mount.mounted, versions); return await run(mount) }
    finally {
      await this.serial(async () => {
        try { if (this.canDiscard()) await rm(host, { recursive: true, force: true }) }
        finally { this.active.delete(host) }
      })
    }
  }
  collect(): Promise<void> {
    return this.serial(async () => {
      if (!this.canDiscard()) return
      let entries
      try { entries = await readdir(this.root, { withFileTypes: true }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      for (const entry of entries) {
        const directory = join(this.root, entry.name)
        if (entry.isDirectory() && /^run-[A-Za-z0-9]{6}$/u.test(entry.name) && !this.active.has(directory)) await rm(directory, { recursive: true, force: true })
      }
    })
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.pending.then(run); this.pending = result.catch(() => {}); return result
  }
}
