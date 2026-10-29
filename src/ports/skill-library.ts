import type { SkillImportCandidates, SkillImportPolicy } from '../domain/skill-import.js'
import type { LibrarySkill, SkillContents, UploadedSkill } from '../domain/skill-library.js'

/** Published facts for synchronous member expansion and execution admission. */
export interface SkillLibraryView {
  ready?(): Promise<void>
  list(): readonly LibrarySkill[]
}
export interface SkillLibraryStorePort {
  list(): Promise<readonly LibrarySkill[]>
  save(skill: LibrarySkill, expectedRevision?: number | 'none'): Promise<void>
  remove(name: string, expectedRevision?: number): Promise<void>
}
export interface SkillArtifactsPort {
  recover?(): Promise<void>
  acceptGit?(source: import('../domain/skill-git-source.js').SkillGitTarget, signal: AbortSignal, policy?: SkillImportPolicy): Promise<SkillImportCandidates>
  acceptImport?(content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<SkillImportCandidates>
  createNote?(name: string, description: string, instructions: string): Promise<UploadedSkill>
  accept(content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<UploadedSkill>
  read(hash: string): Promise<SkillContents>
  collect(retained: readonly string[]): Promise<void>
  newToken(): string
}
