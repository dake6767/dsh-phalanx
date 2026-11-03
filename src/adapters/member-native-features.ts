import { nativeFeatureProjection, type NativeFeaturePatch } from '../dsh/native-features.js'
import { parseDocument, isSeq, type Document } from 'yaml'
import type { NativePluginPolicyConfiguration } from '../dsh/native-plugin-policy.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface PreparedMemberNativeFeatures {
  readonly patch: string
  readonly volumes: readonly { readonly host: string; readonly mounted: string }[]
}

/** Startup owns a final immutable invocation patch, separate from member-writable profiles. */
export async function prepareMemberNativeFeatures(
  dataRoot: string,
  container: boolean,
  spaceId: string,
  patch: readonly NativeFeaturePatch[],
  canDiscardArtifacts: () => boolean = () => true,
  options?: { readonly policy: NativePluginPolicyConfiguration; readonly creatorPatch?: string },
): Promise<PreparedMemberNativeFeatures> {
  if (!/^[a-zA-Z0-9_-]+$/u.test(spaceId)) throw new TypeError('Invalid native feature member identity')
  const host = join(dataRoot, 'native-features', 'members', spaceId)
  const mounted = container ? '/dsh-phalanx/native-features' : host
  const generation = `generation-${randomUUID()}`
  const directory = join(host, generation)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const projection = nativeFeatureProjection(patch, join(mounted, generation), options?.policy)
  for (const [name, contents] of Object.entries(projection.files)) {
    const target = join(directory, name)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, contents, { mode: 0o600, flag: 'wx' })
  }
  const filename = options?.creatorPatch ? 'overlay.yml' : 'overlay.json'
  let overlay = JSON.stringify(projection.patch)
  if (options?.creatorPatch) {
    const document: Document = parseDocument(options.creatorPatch, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    if (document.errors.length || !isSeq(document.contents)) throw new Error('Invalid native Creator patch')
    document.contents.items.unshift(...projection.patch.map(row => document.createNode(row)))
    overlay = document.toString()
  }
  await writeFile(join(directory, filename), overlay, { mode: 0o600, flag: 'wx' })
  if (canDiscardArtifacts())
    for (const name of await readdir(host)) {
      if (!canDiscardArtifacts()) break
      if (name !== generation && /^generation-[a-f0-9-]+$/u.test(name)) await rm(join(host, name), { recursive: true, force: true })
    }
  return { patch: join(mounted, generation, filename), volumes: [{ host, mounted }] }
}
