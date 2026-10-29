import { appendFile } from 'node:fs/promises'
import { expect } from 'vitest'

interface TrialApi {
  get(path: string): Promise<unknown>
  post(path: string, value: object): Promise<{ status(): number; json(): Promise<unknown> }>
}
interface Grants {
  revision: string
  skills: { name: string; granted: boolean }[]
  packs: { name: string; granted: boolean }[]
}

/** Run the baseline trial as an authorized user, then restore its original grants before taking upgrade snapshots. */
export async function withAdministratorSkill(api: TrialApi, name: string, run: () => Promise<void>): Promise<void> {
  const groups = (await api.get('groups')) as { id: string; kind: string }[]
  const group = groups.find(row => row.kind === 'admin')
  expect(group, 'The formal baseline must expose the administrator group').toBeDefined()
  const path = `groups/${group!.id}/skills`,
    original = (await api.get(path)) as Grants
  const names = original.skills.filter(row => row.granted).map(row => row.name)
  const packs = original.packs.filter(row => row.granted).map(row => row.name)
  if (names.includes(name)) {
    await run()
    return
  }
  expect((await api.post(path, { action: 'save', names: [...names, name], packs, revision: original.revision, confirmed: true })).status()).toBe(200)
  const failures: unknown[] = []
  try {
    await run()
  } catch (error) {
    failures.push(error)
  }
  try {
    const current = (await api.get(path)) as Grants
    expect((await api.post(path, { action: 'save', names, packs, revision: current.revision, confirmed: true })).status()).toBe(200)
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Trial and administrator grant restoration failed')
}

/** Persist the HTTP failure body before assertions; outer AssertionError formatting is not evidence. */
export async function retainedExecutionTrial(api: TrialApi, phase: string, evidence: string | undefined, redact: (text: string) => string): Promise<void> {
  const response = await api.post('execution/trial', { owner: 'skill:retained-skill', line: 'retained' })
  const result = await response.json()
  if (evidence)
    await appendFile(
      evidence,
      JSON.stringify({ phase, httpStatus: response.status(), result }, (_key, value: unknown) => (typeof value === 'string' ? redact(value) : value)) + '\n',
    )
  expect(response.status()).toBe(200)
  expect(result).toMatchObject({ exitCode: 0, stdout: 'retained\n' })
}
