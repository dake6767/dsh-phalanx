import type { CommunitySkillImportInput, CommunitySkillImportPreview } from '../../src/domain/admin-contract'
interface ImportDraft {
  names: readonly string[]
  removals: readonly string[]
  replacements: readonly string[]
  note: string
  showInternal: boolean
  packs: readonly { name: string; description: string; enabled: boolean; skills: readonly string[] | null }[]
}
export function importDraft(preview: CommunitySkillImportPreview): ImportDraft {
  const note = preview.candidates.find(row => row.orchestration && !row.internal)
  return {
    removals: [],
    names: preview.candidates.filter(row => !row.internal && row.name !== note?.name && row.change !== 'unchanged').map(row => row.name),
    replacements: [],
    note: note?.name ?? '',
    showInternal: false,
    packs: preview.packs.length
      ? preview.packs.map(pack => ({ ...pack, enabled: !preview.updating }))
      : [
          {
            name: preview.defaultPackName,
            description: note?.description ?? preview.candidates[0]?.description ?? '',
            enabled: !preview.updating && !preview.candidates.some(row => row.source),
            skills: null,
          },
        ],
  }
}
export function importInput(preview: CommunitySkillImportPreview, draft: ImportDraft): CommunitySkillImportInput {
  const names = draft.names.filter(name => name !== draft.note)
  return {
    token: preview.token,
    names,
    ...(preview.updating ? { removals: draft.removals } : {}),
    replacements: draft.replacements,
    packs: draft.packs
      .filter(pack => pack.enabled)
      .map((pack, index) => ({
        name: pack.name,
        description: pack.description,
        skills: names.filter(name => pack.skills === null || pack.skills.includes(name)),
        ...(index === 0 && draft.note ? { note: draft.note } : {}),
      })),
  }
}
