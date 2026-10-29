import type { TestProject } from 'vitest/node'
import { startPostgresFixture, type PostgresFixtureInfo } from './postgres-runtime.js'

declare module 'vitest' {
  export interface ProvidedContext {
    postgres: PostgresFixtureInfo
  }
}

export default async function setup(project: TestProject) {
  const fixture = await startPostgresFixture()
  project.provide('postgres', fixture.info)
  return fixture.stop
}
