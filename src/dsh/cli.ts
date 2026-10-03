/** Frozen DSH web command, shared by process and rootless-container launchers. */
export function webServiceArgs(base: readonly string[], patches: readonly string[], port: number, authority: string): string[] {
  return [...base, ...patches.flatMap(path => ['--patch', path]),
    '--host', '127.0.0.1', '--no-open', '--port', String(port), '--trusted-host', authority]
}

/** Default image command; the generated container recipe derives it here. */
export function containerWebCommand(): string[] {
  return ['node', '/opt/dsh/apps/cli/lib/bin.js', '--profile', 'web']
}
