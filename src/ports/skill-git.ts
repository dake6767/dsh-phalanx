import type { SkillImportPolicy } from '../domain/skill-import.js'
import type { SkillGitTarget } from '../domain/skill-git-source.js'
export interface SkillGitRepositoryPort {
  recover?(): Promise<void>
  read(
    source: SkillGitTarget,
    signal: AbortSignal,
    policy?: SkillImportPolicy,
  ): Promise<{
    readonly target?: SkillGitTarget
    readonly commit: string
    readonly links?: readonly string[]
    readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[]
  }>
}
