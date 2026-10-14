import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { prepareCommunityPlatformPlugin } from '../src/adapters/community-platform-plugin.js'

it('loads the shipped tool, identifies registry installation and sends only exact identity after foreground confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-generated-'))
  let tool!: { execute(args: object, exec: object): Promise<unknown> }, confirmed = false
  const requests: { url: string, body: string }[] = []
  const agent = { session: { header: { cwd: root } } }
  vi.stubEnv('DSH_HOME', join(root, '.dsh'))
  vi.stubEnv('DSH_PHALANX_MODEL_GATEWAY_URL', 'http://platform.invalid/model')
  vi.stubEnv('DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN', 'fixture-token')
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => { expect(confirmed).toBe(true); requests.push({ url: String(url), body: String(init?.body) }); return new Response(JSON.stringify({ status: 'pending' })) })
  try {
    const profile = join(root, '.dsh/profiles/web'), pkg = join(profile, 'node_modules/team-plugin')
    await mkdir(pkg, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'team-plugin': '^1.2.0' } }))
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'team-plugin', version: '1.2.3', dsh: { bundle: { patch: './patch.yml' } } }))
    await writeFile(join(pkg, 'patch.yml'), '- id: team\n  name: team-plugin')
    await prepareCommunityPlatformPlugin(root, false)
    const plugin = await import(pathToFileURL(join(root, 'platform-plugin/contributions.mjs')).href)
    plugin.apply({ skills: { register: () => {} }, tools: { register: (value: typeof tool) => { tool = value } }, agents: { roots: () => [agent] }, userQuestions: { ask: async (value: { questions: { detail: string }[] }) => {
      expect(requests).toEqual([]); expect(value.questions[0]?.detail).toContain('npm registry (exact version)'); confirmed = true
      return { answers: [{ selected: ['Submit / 提交'] }] }
    } } })
    expect(await tool.execute({ action: 'submit', kind: 'plugin', path: pkg, purpose: 'Share plugin' }, { agent, signal: new AbortController().signal })).toEqual({ status: 'pending' })
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0]!.url).searchParams.get('kind')).toBe('plugin')
    expect(JSON.parse(requests[0]!.body)).toEqual({ packageName: 'team-plugin', version: '1.2.3', declaration: { purpose: 'Share plugin' } })
  } finally { fetch.mockRestore(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
})
