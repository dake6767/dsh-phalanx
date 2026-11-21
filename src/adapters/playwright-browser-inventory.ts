import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { PreparedBrowserBuild } from '../domain/runtime-dependency.js'

const browserBuildDirectory = /^[a-z][a-z0-9_]{0,63}-([1-9][0-9]{0,7})$/u
const browserExecutables = new Set(['chrome', 'chrome-headless-shell', 'headless_shell'])

/** Count checked browser files by revision without following projections or other symlinks. */
export async function preparedPlaywrightBuilds(root: string): Promise<readonly PreparedBrowserBuild[]> {
  const builds = new Map<string, number>()

  async function visit(directory: string, found?: { bytes: number; executable: boolean }): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const location = join(directory, entry.name)
      if (entry.isDirectory()) {
        const build = found ? undefined : browserBuildDirectory.exec(entry.name)?.[1]
        if (build === undefined) {
          await visit(location, found)
        } else {
          const candidate = { bytes: 0, executable: false }
          await visit(location, candidate)
          if (candidate.executable) builds.set(build, (builds.get(build) ?? 0) + candidate.bytes)
        }
      } else if (entry.isFile() && found) {
        const info = await lstat(location)
        found.bytes += info.size
        if (browserExecutables.has(entry.name) && (info.mode & 0o111) !== 0) found.executable = true
      }
    }
  }

  await visit(root)
  return [...builds].sort(([left], [right]) => Number(left) - Number(right)).map(([build, bytes]) => ({ build, bytes }))
}
