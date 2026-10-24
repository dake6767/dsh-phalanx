import assert from 'node:assert/strict'
import { suitePrepareCommands } from '../../src/domain/suite-prepare-commands.js'
import { normalizeSuiteCatalogDocument, withSuiteCatalogContentHash, type SuiteCatalogRuntimeDependencyItem } from '../../src/domain/suite-catalog-document.js'
import { suiteEntryViolations } from '../../src/domain/suite-catalog-checks.js'
import { createCatalogSigningKey, signCatalog } from './suite-catalog-signing.js'
import inputs from './office-inputs.json' with { type: 'json' }

/** Checks acceptance of the actual archive URL; complete resource-only catalog entries belong to later work. */
export function officeSdkDownloadFacts() {
  const sdk = inputs.onlyofficeSdk
  assert(sdk['sdk-a'] === sdk['sdk-b'], 'Two original archive downloads must match')
  const url = sdk.repository + '/archive/' + sdk.commit + '.tar.gz'
  const member = 'onlyoffice-web-comp-' + sdk.commit + '/' + sdk.directory
  const item: SuiteCatalogRuntimeDependencyItem = { kind: 'runtime-dependency', name: 'office-sdk-probe',
    paths: ['bin'], commands: ['office-sdk-probe'], downloads: [{ source: 'github-assets', url,
      sha256: { amd64: sdk['sdk-a'], arm64: sdk['sdk-a'] }, target: 'sdk.tar.gz',
      extract: { format: 'tar', directory: 'sdk', stripComponents: 4, member } }] }
  const text = { en: 'Office SDK source facts', 'zh-CN': 'Office SDK 来源事实' }
  const entry = withSuiteCatalogContentHash({ kind: 'dependency', id: 'office-sdk-probe', version: '1.0.0',
    engines: { platform: '>=0.1.0' }, adapters: [], title: text, description: text, source: text, items: [item] })
  const fixture = signCatalog([entry], createCatalogSigningKey())
  const normalized = normalizeSuiteCatalogDocument(fixture.document)
  assert(normalized.okay && normalized.document.entries.length === 1, 'Existing catalog parser rejected the archive download descriptor')
  const prepareCommands = suitePrepareCommands(item)
  const violations = suiteEntryViolations({ id: entry.id, category: 'dependency', items: [{ ...item, prepareCommands }] })
  assert.deepEqual(violations, [])
  for (const command of Object.values(prepareCommands)) {
    assert(command.includes('${GITHUB_ASSETS_PREFIX}' + url) && command.includes(sdk['sdk-a']), 'Rendered download must retain source prefix and pinned checksum')
    assert(command.includes('--strip-components=4 -C sdk ' + member), 'SDK-only archive extraction selector changed')
  }
  return { status: 'passed', url, archiveSha256: sdk['sdk-a'], archiveBytes: sdk.archiveBytes,
    originalDownloadsIdentical: true, sdkFiles: sdk.sdkFiles, sdkBytes: sdk.sdkBytes,
    existingCatalogDownloadAccepted: true, completeResourceOnlyEntryImplemented: false,
    officialPrefix: '', mainlandPrefixNotDownloadedByThisProbe: true, prepareCommands }
}
