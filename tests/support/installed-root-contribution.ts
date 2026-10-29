import { expect } from 'vitest'
import { skillZip } from '../fixtures/skills/archive.js'

type Json = Awaited<ReturnType<Response['json']>>

/** A real authenticated member submission and reviewed adoption populate contribution storage. */
export async function contributeInstalledSkill(input: {
  token: string
  groupId: string
  call(path: string, init: RequestInit): Promise<Response>
  api(path: string, value?: unknown): Promise<Json>
}) {
  const { token, groupId, call, api } = input
  const submitted = await call('/contributions?action=submit', {
    method: 'POST',
    headers: {
      'x-api-key': token,
      'content-type': 'application/zip',
      'x-contribution-declaration': Buffer.from(JSON.stringify({ purpose: 'Retain the reviewed installed contribution' })).toString('base64url'),
    },
    body: new Uint8Array(
      skillZip([{ path: 'SKILL.md', content: '---\nname: installed-contributed\ndescription: Reviewed installed contribution\n---\nKeep the team guide.' }]),
    ),
  })
  expect(submitted.status).toBe(200)
  const rows = (await api('contributions')).contributions as { id: string; name: string; revision: string }[]
  const row = rows.find(item => item.name === 'installed-contributed')
  expect(row).toBeDefined()
  const review = await api('contributions', { action: 'review', id: row!.id, revision: row!.revision })
  const grant = await api('groups/' + groupId + '/skills')
  await api('contributions', {
    action: 'adopt',
    id: row!.id,
    revision: row!.revision,
    token: review.token,
    setup: { published: true, groups: [{ id: groupId, revision: grant.revision }] },
  })
  expect((await api('contributions')).contributions.find((item: { id: string }) => item.id === row!.id)?.status).toBe('adopted')
}
