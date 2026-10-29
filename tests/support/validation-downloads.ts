import { downloadSourceSelection, resolveDownloadSources } from '../../src/domain/download-source.js'
import { ContainerPluginPreparer } from '../../src/adapters/plugin-preparer.js'
import { FilePluginContributionPreparation } from '../../src/adapters/plugin-contribution-preparation.js'
import { RuntimeDependencyPreparer } from '../../src/adapters/runtime-dependency-preparer.js'

export function validationDownloadSelection() {
  return downloadSourceSelection(JSON.parse(process.env.DSH_PHALANX_DOWNLOAD_SOURCES ?? '{"preset":"official"}'))
}
const reader = { current: () => resolveDownloadSources(validationDownloadSelection()) }
export function validationPluginPreparer(config: ConstructorParameters<typeof ContainerPluginPreparer>[0]) {
  return new ContainerPluginPreparer(config, false, reader)
}
export function validationContributionPreparer(config: ConstructorParameters<typeof FilePluginContributionPreparation>[0]) {
  return new FilePluginContributionPreparation(config, reader)
}
export function validationRuntimePreparer(
  process: ConstructorParameters<typeof RuntimeDependencyPreparer>[0],
  artifacts: ConstructorParameters<typeof RuntimeDependencyPreparer>[1],
) {
  return new RuntimeDependencyPreparer(process, artifacts, reader)
}
