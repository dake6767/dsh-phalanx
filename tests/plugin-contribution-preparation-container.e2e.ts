// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { validationContributionPreparer } from './support/validation-downloads.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'

it.skipIf(!runtimeSettings.containerImage)(
  'keeps reports for each declaration on identical package bytes and rejects plaintext patch credentials before activation',
  async () => {
    assertPinnedDshRevision(runtimeSettings)
    const root = await mkdtemp(join(tmpdir(), 'contribution-private-check-'))
    try {
      const directory = join(root, 'fixture')
      await mkdir(directory)
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({
          name: '@example/private-check',
          version: '1.0.0',
          type: 'module',
          main: './index.js',
          scripts: { install: 'node -e "process.exit(99)"' },
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
      )
      await writeFile(join(directory, 'index.js'), "export const name='private-check';export function apply(){}")
      const patch = [{ insert: [{ id: 'private-check', name: '@example/private-check' }] }]
      await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify(patch))
      const pack = async () => {
        const rows = JSON.parse(await execFileText('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', root])) as {
          filename: string
        }[]
        const bytes = await readFile(join(root, rows[0]!.filename))
        return {
          source: 'upload' as const,
          filename: rows[0]!.filename,
          content: {
            async *[Symbol.asyncIterator]() {
              yield bytes
            },
          },
        }
      }
      const service = validationContributionPreparer(runtimeSection(root, 'http://127.0.0.1:9', runtimeSettings)),
        input = await pack(),
        signal = new AbortController().signal
      const base = {
        purpose: 'Share fixture',
        plugin: {
          upstreams: [{ name: 'search', baseUrl: 'https://provider.example', headers: [] }],
          environment: [],
          entriesYaml: 'private-check:\n  baseURL: https://provider.example',
        },
      }
      const first = await service.prepare(
        input,
        signal,
        { ...base, plugin: { ...base.plugin, upstreams: [{ ...base.plugin.upstreams[0]!, directReason: 'Public endpoint without authentication' }] } },
        true,
      )
      expect(first.findings).toContainEqual(expect.objectContaining({ code: 'contribution-plugin-upstream-unused', severity: 'warning' }))
      expect(first.findings).toContainEqual(expect.objectContaining({ code: 'contribution-plugin-install-script' }))
      const second = await service.prepare(
        input,
        signal,
        { ...base, plugin: { ...base.plugin, entriesYaml: 'private-check:\n  baseURL: "{upstream:search}"' } },
        true,
      )
      expect(second.hash).toBe(first.hash)
      expect(second.plugin.prepared.preparationId).not.toBe(first.plugin.prepared.preparationId)
      expect(second.findings!.some(row => row.code === 'contribution-plugin-upstream-unused')).toBe(false)
      const firstReport = JSON.parse(
        await readFile(
          join(
            root,
            'contributions/plugin-intake/plugins',
            first.plugin.prepared.artifact,
            'prepared',
            first.plugin.prepared.preparationId!,
            'contribution.json',
          ),
          'utf8',
        ),
      )
      expect(firstReport.findings).toEqual(first.findings)
      await writeFile(
        join(directory, 'cordis.patch.yml'),
        JSON.stringify([{ insert: [{ id: 'private-check', name: '@example/private-check', config: { apiKey: 'sk-' + 'Q'.repeat(48) } }] }]),
      )
      await expect(service.prepare(await pack(), signal, undefined, true)).rejects.toMatchObject({
        findings: expect.arrayContaining([expect.objectContaining({ code: 'contribution-credential-high', severity: 'reject', path: 'cordis.patch.yml' })]),
      })
    } finally {
      await removeCommunityFixture(root)
    }
  },
)
