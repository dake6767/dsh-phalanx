import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { createCommunityApplication, type CommunityApplicationOptions } from '../support/community-application.js'
import { readBootstrapCredential } from '../../src/adapters/bootstrap-credential.js'
import { FileSkillArtifacts } from '../../src/adapters/skill-artifacts.js'
import { skillZip } from './skills/archive.js'
import { cleanupOwned } from './owned-cleanup.js'

/** Public management transport against a real application and its temporary PostgreSQL database. */
export async function expertApplication(options: CommunityApplicationOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'expert-management-'))
  let app: ReturnType<typeof createCommunityApplication> | undefined
  const close = () =>
    cleanupOwned(
      async () => app?.stop(),
      () => new FileSkillArtifacts(join(root, 'skills/artifacts'), []).collect([]),
      () => rm(root, { recursive: true, force: true }),
    )
  try {
    app = createCommunityApplication(
      {
        listen: { host: '127.0.0.1', port: 0 },
        sessionSecret: 'expert-management-fictional-session-secret',
        runtime: {
          command: '/unavailable-dsh',
          args: [],
          dataRoot: root,
          defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
        },
      },
      options,
    )
    const origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }),
    })
    expect(bootstrap.status).toBe(303)
    const cookie = bootstrap.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ')
    const request = (path: string, body?: object) =>
      fetch(origin + '/admin/api/' + path, {
        headers: { cookie, origin, 'content-type': 'application/json' },
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      })
    const api = async <T>(path: string, body?: object): Promise<T> => {
      const response = await request(path, body)
      expect(response.status).toBe(200)
      return (await response.json()) as T
    }
    const uploadSkill = async (name: string) => {
      const uploaded = await fetch(origin + '/admin/api/skills/upload', {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/zip' },
        body: new Uint8Array(skillZip([{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: Fixture skill\n---\nWrite reports.` }])),
      })
      expect(uploaded.status).toBe(200)
      const preview = (await uploaded.json()) as { token: string; revision: string }
      await api('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })
    }
    return { root, origin, request, api, uploadSkill, close }
  } catch (error) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Expert management fixture failed')
    }
    throw error
  }
}
