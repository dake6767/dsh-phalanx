export function formalInstallerIdentity(
  source: string,
  tag: string,
  acceptance: { status: string; commit: string },
): {
  tag: string
  tagCommit: string
  builtSource: string
  installerSha256: string
  changedPaths: string[]
}
