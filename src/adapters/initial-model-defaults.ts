import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { isProviderProtocol } from '../domain/shared-models.js'
import type { InitialModelDefaults, InitialModelDefaultsPort, InitialModelValues } from '../ports/initial-model-defaults.js'

/** Read a bounded, deployer-owned suggestion through one checked descriptor; errors contain no file contents. */
export class FileInitialModelDefaults implements InitialModelDefaultsPort {
  constructor(private readonly path = '/etc/dsh-phalanx/initial-model.json') {}
  read(): InitialModelDefaults {
    let fd: number
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'invalid' }
    }
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.size > 16384) return { status: 'invalid' }
      const buffer = Buffer.alloc(16385)
      let length = 0
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null)
        if (!count) break
        length += count
      }
      const after = fstatSync(fd)
      if (length > 16384 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || length !== stat.size)
        return { status: 'invalid' }
      const input: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'))
      if (!input || typeof input !== 'object' || Array.isArray(input)) return { status: 'invalid' }
      const values = input as InitialModelValues
      if (Object.entries(values).some(([key, value]) => !['name', 'baseUrl', 'apiFormat', 'model', 'apiKey'].includes(key) || typeof value !== 'string'))
        return { status: 'invalid' }
      if (
        (values.name !== undefined && values.name.length > 128) ||
        (values.model !== undefined && values.model.length > 256) ||
        (values.apiFormat !== undefined && !isProviderProtocol(values.apiFormat))
      )
        return { status: 'invalid' }
      if (values.apiKey !== undefined && (!values.apiKey.trim() || /[^\x20-\x7e]/u.test(values.apiKey))) return { status: 'invalid' }
      if (values.baseUrl !== undefined) {
        const url = new URL(values.baseUrl)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return { status: 'invalid' }
      }
      return { status: 'ready', values }
    } catch {
      return { status: 'invalid' }
    } finally {
      closeSync(fd)
    }
  }
}
