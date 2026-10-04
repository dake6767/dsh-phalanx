export type CommunityCommand = { readonly kind: 'serve' }
  | { readonly kind: 'bootstrap-link', readonly dataRoot: string, readonly origin: URL, readonly renew: boolean }
  | { readonly kind: 'migrate-user-storage', readonly targetRoot: string, readonly mount: string }

/** Parse operator input before constructing the long-running service. */
export function parseCommunityCommand(args: readonly string[]): CommunityCommand {
  if (args.length === 0) return { kind: 'serve' }
  if (args[0] === 'migrate-user-storage') {
    const values = new Map<string, string>()
    for (let index = 1; index < args.length; index++) {
      const flag = args[index]!, value = args[++index]
      if (!['--target-root', '--mount'].includes(flag) || values.has(flag) || value === undefined || value.trim() === '' || value.startsWith('--')) throw new Error('Usage: migrate-user-storage --target-root PATH --mount PATH')
      values.set(flag, value)
    }
    const targetRoot = values.get('--target-root'), mount = values.get('--mount')
    if (targetRoot === undefined || mount === undefined) throw new Error('Usage: migrate-user-storage --target-root PATH --mount PATH')
    return { kind: 'migrate-user-storage', targetRoot, mount }
  }
  const usage = 'Usage: dsh-phalanx [bootstrap-link --data-root PATH --origin URL [--renew]]'
  if (args[0] !== 'bootstrap-link') throw new Error(usage)
  const values = new Map<string, string>()
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!
    if (!['--data-root', '--origin', '--renew'].includes(flag) || values.has(flag)) throw new Error(usage)
    const value = flag === '--renew' ? 'true' : args[++index]
    if (value === undefined || value.trim() === '' || value.startsWith('--')) throw new Error(usage)
    values.set(flag, value)
  }
  const dataRoot = values.get('--data-root'), address = values.get('--origin')
  if (dataRoot === undefined || address === undefined) throw new Error(usage)
  const origin = new URL(address)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username !== '' || origin.password !== ''
    || origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') throw new Error('Initialization requires an HTTP(S) origin without a path or credentials')
  return { kind: 'bootstrap-link', dataRoot, origin, renew: values.has('--renew') }
}
