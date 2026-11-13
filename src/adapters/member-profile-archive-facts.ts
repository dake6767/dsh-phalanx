import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'
import { PLUGIN_UPLOAD_MAX_BYTES } from '../domain/plugin-library.js'
import type { NativePluginArchiveFacts } from '../domain/plugin-preinstall.js'
import { DSH_CONTAINER_PROFILE, DSH_PROFILE_LOCK, DSH_PROFILE_MANIFEST, dshWebProfilePath } from '../dsh/profile-layout.js'
import { MEMBER_PLUGIN_ARCHIVE_DIRECTORY } from '../dsh/native-plugin-replacement.js'
import { retainedMemberPluginArchiveIntegrity } from './member-plugin-archive.js'
import { memberProfileBundles, pluginFileReader } from './plugin-coordination.js'
import { prepareCommunityProfile } from './community-profile.js'
import { CommunityRuntimeUnavailableError } from '../ports/community-runtime.js'

export async function prepareMemberProfileInventory(home: string, provider: string, model: string, inspect: boolean, verify: boolean) {
  try {
    await prepareCommunityProfile(home, provider, model)
    const installed = inspect ? await memberProfileBundles(home) : []
    const archives = verify ? await memberProfileArchiveFacts(home, installed) : undefined
    return { installed, archives }
  } catch (error) {
    throw new CommunityRuntimeUnavailableError('profile-unavailable', 'Private DSH profile could not be prepared; repair its configuration before retrying', {
      cause: error,
    })
  }
}

/** Startup uses the native manifest, lock, installed version and retained bytes before projecting catalog resources. */
async function memberProfileArchiveFacts(home: string, names: readonly string[]): Promise<NativePluginArchiveFacts> {
  if (!names.length) return {}
  const profile = dshWebProfilePath(home)
  const canonicalProfile = await realpath(profile)
  const read = await pluginFileReader(home)
  const dependencies = (JSON.parse(await read(join(profile, DSH_PROFILE_MANIFEST), '{}')) as { dependencies?: Record<string, string> }).dependencies ?? {}
  const candidates = names.flatMap(packageName => {
    const spec = dependencies[packageName]
    if (typeof spec !== 'string' || !spec.startsWith('file:')) return []
    const path = resolve(DSH_CONTAINER_PROFILE, spec.slice(5))
    const integrity = retainedMemberPluginArchiveIntegrity('file:' + path)
    return integrity ? [{ packageName, spec, integrity, path }] : []
  })
  if (!candidates.length) return {}
  let lock: {
    importers?: Record<string, { dependencies?: Record<string, { specifier?: string; version?: string }> }>
    packages?: Record<string, { resolution?: { integrity?: string } }>
  }
  try {
    lock = parse(await read(join(profile, DSH_PROFILE_LOCK), '{}'), { maxAliasCount: 0 }) ?? {}
  } catch {
    return {}
  }
  const verified = []
  for (const { packageName, integrity, path } of candidates) {
    const { specifier, version: lockedVersion } = lock.importers?.['.']?.dependencies?.[packageName] ?? {}
    if (
      typeof specifier !== 'string' ||
      !specifier.startsWith('file:') ||
      resolve(DSH_CONTAINER_PROFILE, specifier.slice(5)) !== path ||
      typeof lockedVersion !== 'string' ||
      !lockedVersion.startsWith('file:')
    )
      continue
    const locator = packageName + '@' + lockedVersion
    const pin = Object.entries(lock.packages ?? {}).find(
      ([key]) => key === locator || (key.startsWith(packageName + '@file:') && locator.startsWith(key + '(')),
    )?.[1]
    if (pin?.resolution?.integrity !== integrity) continue
    try {
      const { name, version } = JSON.parse(await read(join(profile, 'node_modules', packageName, 'package.json'))) as { name?: string; version?: string }
      const archive = join(profile, '.phalanx-market', path.slice(MEMBER_PLUGIN_ARCHIVE_DIRECTORY.length + 1))
      if (
        name === packageName &&
        typeof version === 'string' &&
        (await realpath(dirname(archive))) === join(canonicalProfile, '.phalanx-market') &&
        (await archiveMatches(archive, integrity))
      )
        verified.push([packageName, { version, integrity }] as const)
    } catch {
      // A missing or damaged member copy must not obtain fixed catalog resources.
    }
  }
  return Object.fromEntries(verified)
}

async function archiveMatches(path: string, integrity: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > PLUGIN_UPLOAD_MAX_BYTES) return false
    const hash = createHash('sha512')
    let bytes = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length
      if (bytes > stat.size) return false
      hash.update(chunk)
    }
    return bytes === stat.size && 'sha512-' + hash.digest('base64') === integrity
  } finally {
    await file.close()
  }
}
