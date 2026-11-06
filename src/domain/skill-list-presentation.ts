/** Packed skills stay reachable individually when any direct grant or choice references them. */
export function skillListPresentation(
  packs: readonly { readonly name: string; readonly skills: readonly string[] }[],
  directNames: readonly string[],
): ReadonlyMap<string, { readonly packs: readonly string[]; readonly topLevel: boolean }> {
  const direct = new Set(directNames),
    bySkill = new Map<string, string[]>()
  for (const pack of packs)
    for (const name of pack.skills) {
      const names = bySkill.get(name) ?? []
      names.push(pack.name)
      bySkill.set(name, names)
    }
  return new Map([...bySkill].map(([name, names]) => [name, { packs: names, topLevel: direct.has(name) }]))
}
