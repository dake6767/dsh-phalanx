export function formalUpgradeScope(
  records: readonly string[],
  target: string,
  source: { readonly min: string; readonly maxExclusive: string },
  freshInstallThrough?: string,
): { target: string; previous: string | undefined; upgrade: boolean; freshInstall?: true }
