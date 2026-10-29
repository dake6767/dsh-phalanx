// Validation: T2; real credentials: none; current skill uploads and declared immutable Node dependencies in real containers.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { skillZip } from './fixtures/skills/archive.js'
import { cleanupOwned, removeCommunityFixture } from './fixtures/owned-cleanup.js'

it.skipIf(!runtimeSettings.containerImage)(
  'resolves declared Node libraries for skill scripts and executes changed skill sources',
  async () => {
    assertPinnedDshRevision(runtimeSettings)
    const root = await mkdtemp(join(tmpdir(), 'execution-runtime-modules-'))
    const runtime = runtimeSection(root, 'https://example.test', runtimeSettings)
    const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'execution-module-fixture-secret-32', runtime })
    const sources = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
    const archive = (prefix: string) =>
      skillZip([
        { path: 'SKILL.md', content: '---\nname: module-skill\ndescription: Prepared Node library fixture\n---\nRun scripts/main.js.' },
        { path: 'scripts/main.js', content: `console.log('${prefix}' + require('prepared-module').value)` },
      ])
    try {
      const origin = await app.start()
      const bootstrap = await fetch(origin + '/bootstrap', {
        method: 'POST',
        redirect: 'manual',
        headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }),
      })
      expect(bootstrap.status).toBe(303)
      const cookie = bootstrap.headers
        .getSetCookie()
        .map(value => value.split(';')[0])
        .join('; ')
      const api = async (path: string, input?: unknown) => {
        const response = await fetch(origin + '/admin/api/' + path, {
          method: input ? 'POST' : 'GET',
          headers: { origin, cookie, 'content-type': 'application/json' },
          ...(input ? { body: JSON.stringify(input) } : {}),
        })
        expect(response.ok, await response.clone().text()).toBe(true)
        return response.json()
      }
      const upload = async (prefix: string) => {
        const response = await fetch(origin + '/admin/api/skills/upload', {
          method: 'POST',
          headers: { origin, cookie, 'content-type': 'application/zip' },
          body: new Uint8Array(archive(prefix)),
        })
        expect(response.status).toBe(200)
        const preview = await response.json()
        await api('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })
      }
      await api('runtime-dependencies', {
        action: 'create',
        input: {
          name: 'node-tools',
          prepareCommand: `set -eu; mkdir -p node_modules/prepared-module bin; printf 'exports.value="MODULE_OK";\n' > node_modules/prepared-module/index.js; printf '#!/bin/sh\necho helper\n' > bin/module-helper; chmod +x bin/module-helper`,
          pathDirectories: ['bin'],
          checkCommand: 'module-helper',
        },
      })
      await expect.poll(async () => (await api('runtime-dependencies?name=node-tools')).stage, { timeout: 30000 }).toBe('ready')
      const dependency = (await api('runtime-dependencies?name=node-tools')).current.id
      await upload('OLD_')
      const group = (await api('groups')).find((row: { kind: string }) => row.kind === 'admin')
      const grantPath = `groups/${group.id}/skills`,
        grant = await api(grantPath)
      await api(grantPath, { action: 'save', names: ['module-skill'], revision: grant.revision, confirmed: true })
      await api('skills/execution?name=module-skill', {
        enabled: true,
        commands: [{ command: 'scripts/main.js', blocked: [] }],
        variables: [],
        runtimeDependencies: ['node-tools'],
      })
      await expect.poll(async () => (await api('skills/execution?name=module-skill')).preparation?.stage).toBe('ready')
      const preparation = (await api('skills/execution?name=module-skill')).preparation.identity
      expect(typeof preparation).toBe('string')
      const trial = () => api('execution/trial', { owner: 'skill:module-skill', line: 'scripts/main.js' })
      expect(await trial()).toMatchObject({ exitCode: 0, stdout: 'OLD_MODULE_OK\n' })
      await upload('NEW_')
      await expect
        .poll(
          async () => {
            const current = (await api('skills/execution?name=module-skill')).preparation
            return current?.stage === 'ready' && current.identity !== preparation
          },
          { timeout: 30000 },
        )
        .toBe(true)
      expect((await api('runtime-dependencies?name=node-tools')).current.id).toBe(dependency)
      expect(await trial()).toMatchObject({ exitCode: 0, stdout: 'NEW_MODULE_OK\n' })
    } finally {
      await cleanupOwned(
        () => app.stop(),
        () => new FileSkillDistribution(join(root, 'skills/members'), sources).synchronize([]),
        () => sources.collect([]),
        () => new FileExecutionArtifacts(join(root, 'runtime-dependencies/.trees')).collect([]),
        () => removeCommunityFixture(root),
      )
    }
  },
  120000,
)
