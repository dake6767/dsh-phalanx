/** Resolve only already-prepared executables; runtime launches never invoke a package installer. */
export function preparedMcpCommand(config: { directory: string, command: string, args: readonly string[] }, system: {
  node: string, read(path: string): string, exists(path: string): boolean, join(...paths: string[]): string, resolve(...paths: string[]): string,
}): { command: string, args: string[] } {
  let command = config.command.replaceAll('{dependencies}', config.directory)
  const args = config.args.map(value => value.replaceAll('{dependencies}', config.directory))
  if (command === 'npx') {
    while (args[0] === '-y' || args[0] === '--yes') args.shift()
    const match = /^(?:(@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)|([a-zA-Z0-9_.-]+))(?:@[^/]+)?$/u.exec(args.shift() ?? '')
    if (!match) throw Error('Use a prepared npm package name with npx')
    const directory = system.join(config.directory, 'node_modules', match[1] ?? match[2]!)
    const manifest = JSON.parse(system.read(system.join(directory, 'package.json'))) as { bin?: string | Record<string, string> }
    const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {})
    if (bins.length !== 1 || typeof bins[0] !== 'string') throw Error('Select a prepared executable explicitly')
    command = system.node; args.unshift(system.resolve(directory, bins[0]))
  } else if (command.includes('/') && !command.startsWith('/')) command = system.resolve(config.directory, command)
  else if (['npm', 'pnpm', 'yarn', 'uvx'].includes(command)) throw Error('Run a prepared executable, not a package installer')
  if (command.includes('/') && !system.exists(command)) throw Error('Prepared executable is missing')
  return { command, args }
}
