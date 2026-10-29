import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

type Failure = { attempt: string; step: string; interrupted?: boolean }
type Progress = {
  identity: Record<string, string>
  plan: readonly string[]
  attempt: string
  status: 'running' | 'failed' | 'passed'
  resumeFrom?: string
  current?: string
  firstFailure?: Failure
  failures: Failure[]
  completed: Record<string, { value: unknown }>
}

/** Only resume an unchanged, retained environment at the failed step. Values must be credential-free acceptance facts. */
export async function acceptanceProgress(path: string, identity: Record<string, string>, plan: readonly string[], resumeFrom?: string) {
  if (!plan.length || new Set(plan).size !== plan.length) throw Error('Acceptance steps must be nonempty and unique')
  const existing = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  let state: Progress
  const resumeIndex = resumeFrom === undefined ? 0 : plan.indexOf(resumeFrom)
  if (resumeFrom === undefined) {
    if (existing !== undefined) throw Error('Use a new progress file for a fresh acceptance environment')
    state = { identity, plan, attempt: randomUUID(), status: 'running', failures: [], completed: {} }
  } else {
    if (existing === undefined || resumeIndex < 0) throw Error('Resume requires a recorded failed step')
    state = JSON.parse(existing) as Progress
    if (
      JSON.stringify(state.identity) !== JSON.stringify(identity) ||
      state.status === 'passed' ||
      state.current !== resumeFrom ||
      plan.slice(0, resumeIndex).some((step, index) => state.plan[index] !== step || !state.completed[step])
    ) {
      throw Error('Resume does not match the retained acceptance environment and passed prefix')
    }
    if (state.status === 'running') {
      const failure = { attempt: state.attempt, step: resumeFrom, interrupted: true }
      state.firstFailure ??= failure
      state.failures.push(failure)
    }
    state = { ...state, plan, attempt: randomUUID(), status: 'running', resumeFrom }
  }
  const save = async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = path + '.tmp'
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    await rename(temporary, path)
  }
  await save()
  let cursor = 0
  return {
    report() {
      return { attempt: state.attempt, resumeFrom: state.resumeFrom ?? null, firstFailure: state.firstFailure ?? null }
    },
    saved<T>(step: string): T | undefined {
      return state.completed[step]?.value as T | undefined
    },
    async step<T>(name: string, run: () => Promise<T>): Promise<T> {
      if (plan[cursor] !== name) throw Error('Acceptance steps must follow the recorded plan')
      const skip = cursor++ < resumeIndex
      if (skip) return state.completed[name]!.value as T
      state.current = name
      await save()
      try {
        const value = await run()
        state.completed[name] = { value }
        await save()
        return value
      } catch (error) {
        const failure = { attempt: state.attempt, step: name }
        state.status = 'failed'
        state.firstFailure ??= failure
        state.failures.push(failure)
        await save()
        throw error
      }
    },
    async finish() {
      if (cursor !== plan.length || plan.some(step => !state.completed[step])) throw Error('Acceptance has unfinished steps')
      state.status = 'passed'
      delete state.current
      await save()
    },
  }
}
