import { randomBytes, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Keeps the machine identity of a persistent member home across container replacement. */
export class FileContainerHostnames {
  constructor(private readonly directory: string) {}

  async get(userId: string): Promise<string> {
    return await this.remember(userId, `phalanx-${randomBytes(12).toString('hex')}`)
  }

  /** Existing owned containers supply the identity when upgrading an older installation. */
  async remember(userId: string, hostname: string): Promise<string> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(userId)) throw new Error('Invalid container owner')
    this.validate(hostname)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = join(this.directory, userId)
    const temporary = `${path}.${randomUUID()}`
    try {
      await writeFile(temporary, hostname, { flag: 'wx', mode: 0o600 })
      try { await link(temporary, path) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    } finally { await rm(temporary, { force: true }) }
    const saved = await readFile(path, 'utf8')
    this.validate(saved)
    return saved
  }

  private validate(hostname: string): void {
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,62}[a-zA-Z0-9])?$/u.test(hostname)) throw new Error('Invalid saved container hostname')
  }
}
