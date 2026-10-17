import type { SuiteInstallState } from '../domain/suite-install.js'

export interface SuiteInstallStorePort {
  read(): SuiteInstallState
  write(state: SuiteInstallState): void
}
