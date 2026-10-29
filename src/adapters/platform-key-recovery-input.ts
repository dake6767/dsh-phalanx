import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

/** Plain connection passwords exist only in an explicit, owner-protected recovery input. */
export function readPlatformRecoveryPasswords(
  path: string,
  dataRoot: string,
  owner: number | undefined = process.getuid?.(),
): { activePassword: string; builtinPassword: string } {
  const inside = relative(realpathSync(dataRoot), realpathSync(path))
  if (inside === '' || (inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside)))
    throw Error('Recovery passwords must remain outside the platform data root')
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(file)
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== owner || stat.size > 65536)
      throw Error('Recovery passwords require an owner-only regular 0600 file')
    let value: { activePassword?: unknown; builtinPassword?: unknown }
    try {
      value = JSON.parse(readFileSync(file, 'utf8')) as typeof value
    } catch {
      throw Error('Recovery passwords must be a valid protected JSON object')
    }
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.activePassword !== 'string' ||
      typeof value.builtinPassword !== 'string' ||
      !value.activePassword ||
      !value.builtinPassword
    )
      throw Error('Recovery requires activePassword and builtinPassword')
    return { activePassword: value.activePassword, builtinPassword: value.builtinPassword }
  } finally {
    closeSync(file)
  }
}
