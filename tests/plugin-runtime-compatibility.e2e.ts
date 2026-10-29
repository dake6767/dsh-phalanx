// Validation: T4 integration; real credentials: none; exact historical amd64 artifacts required. Not part of the approved T2 batch.
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { withPluginFacts } from './support/plugin-facts.js'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { validationPluginPreparer } from './support/validation-downloads.js'

it.skipIf(!runtimeSettings.containerImage || !process.env.DSH_PHALANX_019_CONTAINER_IMAGE)(
  'retains old plugin bytes but blocks an incompatible published plugin after the runtime upgrade',
  async () => {
    assertPinnedDshRevision(runtimeSettings)
    const root = await mkdtemp(join(tmpdir(), 'plugin-runtime-compatibility-'))
    const runtime: CommunityRuntimeConfig = runtimeSection(root, 'https://example.test', runtimeSettings)
    const oldImage = process.env.DSH_PHALANX_019_CONTAINER_IMAGE!
    expect((await execFileText('podman', ['image', 'inspect', oldImage, '--format', '{{index .Config.Labels "dsh.revision"}}'])).trim()).toBe(
      '5badb15009ae1756c3afe0ae0cef1faafc290ccc',
    )
    const old = validationPluginPreparer({ ...runtime, container: { ...runtime.container!, image: oldImage } })
    let app: CommunityApplication | undefined
    try {
      const prepared = await old.prepare({ packageName: 'dsh-better-sidebar', version: '0.24.1' }, async () => {}, new AbortController().signal)
      const original = await readFile(join(root, 'plugins', prepared.artifact, 'original.tgz'))
      expect(`sha512-${createHash('sha512').update(original).digest('base64')}`).toBe(prepared.integrity)
      app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'compatibility-real-runtime-fixture-secret', runtime })
      let origin = await app.start()
      const response = await fetch(origin + '/bootstrap', {
        method: 'POST',
        redirect: 'manual',
        headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }),
      })
      expect(response.status).toBe(303)
      const cookie = response.headers
        .getSetCookie()
        .map(row => row.split(';')[0])
        .join('; ')
      const groups = (await (await fetch(origin + '/admin/api/groups', { headers: { cookie } })).json()) as Array<{ id: string; isDefault: boolean }>
      const groupId = groups.find(group => group.isDefault)!.id
      await app.stop()
      await withPluginFacts(root, async ({ library }) =>
        library.save({
          packageName: prepared.packageName,
          version: prepared.version,
          current: prepared,
          stage: 'available',
          published: true,
          checkedFor: 'previous-runtime',
        }),
      )
      await withPluginFacts(root, ({ grants }) => grants.set(groupId, [prepared.packageName]))
      const grantsBefore = await withPluginFacts(root, ({ grants }) => grants.get(groupId))
      // Upgrade readiness includes the real package download and compatibility preparation.
      app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'compatibility-real-runtime-fixture-secret', runtime }, 120000)
      origin = await app.start()
      const result = await fetch(origin + '/admin/api/plugins', { headers: { cookie } })
      expect(result.status).toBe(200)
      expect(await result.json()).toEqual([
        expect.objectContaining({ packageName: prepared.packageName, stage: 'failed', published: false, failureCode: 'plugin-incompatible' }),
      ])
      const retained = (await withPluginFacts(root, ({ library }) => library.list()))[0]!
      expect(await readFile(join(root, 'plugins', prepared.artifact, 'original.tgz'))).toEqual(original)
      expect(await withPluginFacts(root, ({ grants }) => grants.get(groupId))).toEqual(grantsBefore)
      expect(await withPluginFacts(root, ({ grants }) => grants.get(groupId))).toEqual([prepared.packageName])
      expect(retained).toMatchObject({ incompatible: true, restorePublication: true, current: { integrity: prepared.integrity, artifact: prepared.artifact } })
    } finally {
      await app?.stop()
      await old.recover()
      await removeCommunityFixture(root)
    }
  },
  1200000,
)
