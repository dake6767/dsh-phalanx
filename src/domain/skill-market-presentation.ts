import type { CommunityMarketPack } from './admin-contract.js'
import type { LibrarySkill } from './skill-library.js'
import type { SkillPack } from './skill-pack.js'

/** A member only learns about published packs or packs granted to their own group. */
export function visibleSkillPacks(
  packs: readonly SkillPack[],
  library: readonly LibrarySkill[],
  granted: readonly string[],
  selected: readonly string[],
): readonly CommunityMarketPack[] {
  const available = new Set(library.filter(skill => !skill.conflict).map(skill => skill.name))
  return packs.flatMap(pack => {
    const skills = pack.skills.filter(name => available.has(name))
    const source = granted.includes(pack.name) ? ('managed' as const) : pack.published && selected.includes(pack.name) ? ('selected' as const) : null
    return skills.length && (pack.published || source)
      ? [{ name: pack.name, description: pack.description, instructions: pack.instructions, skills, source }]
      : []
  })
}
