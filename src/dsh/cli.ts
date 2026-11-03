/** Common official configuration arguments, before any app-specific flags. */
export function configurationArgs(base: readonly string[], patches: readonly string[]): string[] {
  return [...base, ...patches.flatMap(path => ['--patch', path])]
}

/** Frozen DSH web command, shared by process and rootless-container launchers. */
export function webServiceArgs(base: readonly string[], patches: readonly string[], port: number, authority: string, publicUrl?: string): string[] {
  return [
    ...configurationArgs(base, patches),
    '--host',
    '127.0.0.1',
    '--no-open',
    '--port',
    String(port),
    '--trusted-host',
    authority,
    ...(publicUrl === undefined ? [] : ['--public-url', publicUrl]),
  ]
}

/** Default image command; the generated container recipe derives it here. */
export function containerWebCommand(): string[] {
  return ['node', '/opt/dsh/apps/cli/lib/bin.js', '--profile', 'web']
}

/** Official composed-profile export exits before app startup and keeps lazy values unevaluated. */
export function configurationDumpArgs(base: readonly string[], patches: readonly string[]): string[] {
  return [...configurationArgs(base, patches), '--dump-config']
}
