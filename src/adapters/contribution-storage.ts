import {
  inspectContributionCredentials,
  excludedContributionFile,
  contributionDeclarationTexts,
  redactContributionContent,
} from '../domain/contribution-checks.js'
import { ContributionCheckError } from '../domain/contribution-check-error.js'
import { contributionCommandFindings } from '../domain/contribution-commands.js'
import type { ContributionCommandInventory } from '../ports/member-contributions.js'
import type { ContributionDeclaration, ContributionFinding } from '../domain/member-contribution.js'
import { readSkillUpload } from '../domain/skill-upload-stream.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContributionArtifacts } from '../ports/member-contributions.js'
import { SKILL_MAX_BYTES } from '../domain/skill-library.js'
import { inspectSkillArchive } from './skill-archive.js'

export class FileContributionArtifacts implements ContributionArtifacts {
  constructor(
    private readonly root: string,
    private readonly bundled: readonly string[],
    private readonly commands?: ContributionCommandInventory,
    private readonly canDiscard: () => boolean = () => true,
  ) {}
  async accept(content: AsyncIterable<Uint8Array>, signal: AbortSignal, declaration?: ContributionDeclaration, retainWarnings = false) {
    const bytes = await readSkillUpload(content, signal, SKILL_MAX_BYTES),
      inspected = await inspectSkillArchive(bytes, this.bundled)
    const findings: ContributionFinding[] = inspectContributionCredentials([
      ...inspected.files.map(file => ({ path: file.path, content: file.bytes.toString('utf8') })),
      ...contributionDeclarationTexts(declaration),
    ])
    for (const file of inspected.files)
      if (excludedContributionFile(file.path))
        findings.push({
          code: 'contribution-excluded-file',
          severity: 'reject',
          path: file.path,
          advice: 'Exclude .env, private keys and certificates before uploading.',
        })
    if (bytes.length > 10 * 1024 * 1024)
      findings.push({
        code: 'contribution-large',
        severity: 'warning',
        advice: 'Reduce generated files and unnecessary dependencies; the compressed limit is 20 MB.',
      })
    findings.push(
      ...contributionCommandFindings(
        new Map(inspected.files.map(file => [file.path, file.bytes.toString('utf8')])),
        declaration,
        (await this.commands?.commands(signal)) ?? [],
      ),
    )
    if (findings.some(row => row.severity === 'reject') || (findings.length && !retainWarnings)) throw new ContributionCheckError(findings)
    signal.throwIfAborted()
    const hash = createHash('sha256').update(bytes).digest('hex')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const staging = join(this.root, `${hash}.${randomUUID()}.tmp`)
    try {
      await writeFile(staging, bytes, { mode: 0o600, flag: 'wx' })
      await rename(staging, this.path(hash))
    } finally {
      await rm(staging, { force: true })
    }
    return {
      name: inspected.name,
      description: redactContributionContent(inspected.description),
      hash,
      markdown: redactContributionContent(inspected.markdown),
      files: inspected.files.map(file => file.path),
      fileHashes: Object.fromEntries(inspected.files.map(file => [file.path, createHash('sha256').update(file.bytes).digest('hex')])),
      findings,
    }
  }
  read(hash: string): Promise<Uint8Array> {
    return readFile(this.path(hash))
  }
  async collect(retained: readonly string[]): Promise<void> {
    if (!this.canDiscard()) return
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const keep = new Set(retained.map(hash => `${hash}.zip`))
    for (const name of names) if (/^[a-f0-9]{64}\.zip$/u.test(name) && !keep.has(name) && this.canDiscard()) await rm(join(this.root, name), { force: true })
  }
  newId(): string {
    return randomUUID()
  }
  private path(hash: string) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error('Invalid contribution artifact')
    return join(this.root, `${hash}.zip`)
  }
}
