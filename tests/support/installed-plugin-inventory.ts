/** Preserve active module identities and multiplicity when comparing installed capabilities. */
export function installedPluginInventory(modules: readonly string[]): string[] {
  return modules
    .map(module =>
      module.replace(
        /^(file:\/\/)?(\/dsh-phalanx\/experts\/)generation-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(\/)/u,
        '$1$2generation-<snapshot>$3',
      ),
    )
    .sort()
}
