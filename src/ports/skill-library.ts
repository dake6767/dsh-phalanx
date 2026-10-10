import type { LibrarySkill, SkillContents, UploadedSkill } from '../domain/skill-library.js'

export interface SkillLibraryStorePort {
  list(): readonly LibrarySkill[]
  save(skill: LibrarySkill): void
  remove(name: string): void
}
export interface SkillArtifactsPort {
  accept(content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<UploadedSkill>
  read(hash: string): Promise<SkillContents>
  collect(retained: readonly string[]): Promise<void>
  newToken(): string
}
