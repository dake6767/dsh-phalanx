import { expect, it } from 'vitest'
import { busySuiteDependents, suiteInstallView } from '../src/use-cases/suite-catalog-state.js'
import type { SuiteInstallRecord } from '../src/domain/suite-install.js'

const installed: SuiteInstallRecord = {
  id: 'suite',
  version: '1.0.0',
  status: 'installed',
  entries: [
    { kind: 'execution', name: 'writing' },
    { kind: 'execution', name: 'review' },
  ],
  updatedAt: 1,
  log: '',
}

it('projects committed delegated credential and enablement state', async () => {
  expect(
    await suiteInstallView(installed, [], {
      suiteExecutionStatus: async owner => ({ enabled: owner !== 'skill:review', configuredVariables: ['TOKEN'], missingCredentials: ['KEY'] }),
    }),
  ).toMatchObject({ status: 'installed', category: 'suite', execution: { enabled: false, configuredVariables: ['TOKEN'] }, missingCredentials: ['KEY'] })
})

it('blocks shared dependency changes for live install and recovery tasks, while settled or failed dependents do not block', () => {
  const dependent = { ...installed, dependencies: ['dependency'] }
  expect(
    busySuiteDependents(
      [
        { ...dependent, id: 'installing', status: 'installing' },
        { ...dependent, id: 'removing', status: 'uninstalling' },
        { ...dependent, id: 'settled' },
        { ...dependent, id: 'failed', status: 'failed' },
        { ...dependent, id: 'dependency', status: 'installing' },
      ],
      'dependency',
    ),
  ).toEqual(['installing', 'removing'])
})
