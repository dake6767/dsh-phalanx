import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemberVoicePreference, MemberVoicePreferencesPort } from '../ports/platform-voice.js'
import { nativeVoiceBundle } from '../dsh/native-voice.js'
import { DSH_PROFILE_MANIFEST, dshWebProfilePath } from '../dsh/profile-layout.js'

type Manifest = Record<string, unknown> & {
  dsh?: { profile?: { bundles?: readonly string[] } }
}

/** Reconcile the official bundle after the previous carrier stops and before native profile boot. */
export async function prepareMemberVoiceProfile(home: string, available: boolean, spaceId: string, preferences: MemberVoicePreferencesPort): Promise<boolean> {
  const path = join(dshWebProfilePath(home), DSH_PROFILE_MANIFEST)
  let manifest: Manifest | undefined
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid voice profile manifest')
      manifest = JSON.parse(await file.readFile('utf8')) as Manifest
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid voice profile manifest')
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const installed = manifest?.dsh?.profile?.bundles
  if (installed !== undefined && (!Array.isArray(installed) || installed.some(name => typeof name !== 'string')))
    throw new Error('Invalid native voice bundle selection')
  const bundles = installed ?? (manifest ? [] : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  const selected = bundles.includes(nativeVoiceBundle)
  const previous = await preferences.preference(spaceId)
  const remember = (state: MemberVoicePreference) => preferences.remember(spaceId, state)
  if (!available) {
    if (selected) {
      await remember('suspended')
      await writeBundles(bundles.filter(name => name !== nativeVoiceBundle))
    }
    return false
  }
  if (!selected) {
    if (previous === 'offered') return false
    if (previous !== 'offering') await remember('offering')
    await writeBundles([...bundles, nativeVoiceBundle])
  }
  if (previous !== 'offered') await remember('offered')
  return true

  async function writeBundles(next: readonly string[]) {
    if (!manifest) {
      // DSH skips profile initialization when our manifest already exists.
      await writeFile(join(dshWebProfilePath(home), 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', {
        flag: 'wx',
        mode: 0o600,
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    }
    const base: Manifest = manifest ?? { name: 'dsh-profile-web', private: true, dependencies: {} }
    await atomicWrite(path, JSON.stringify({ ...base, dsh: { ...base.dsh, profile: { ...base.dsh?.profile, bundles: next } } }, null, 2) + '\n')
  }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  const stage = path + '.tmp-' + randomUUID()
  try {
    await writeFile(stage, value, { flag: 'wx', mode: 0o600 })
    await rename(stage, path)
  } finally {
    await rm(stage, { force: true })
  }
}
