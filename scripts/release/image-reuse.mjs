import { compareVersions } from './compatibility.mjs'

export function supportsImageReuse(version, compatibility) {
  return compareVersions(version, '0.1.18') >= 0 && compareVersions(compatibility.source.min, '0.1.17') >= 0
}

export function validateImageSelection(selection, manifest) {
  const reused = selection?.mode === 'reuse'
  const reasons = ['forced', 'legacy-baseline', 'not-found', 'development-platform', 'local-build']
  if (
    !selection ||
    !manifest.imageIdentity ||
    typeof selection.rehearsal !== 'boolean' ||
    !['build', 'reuse'].includes(selection.mode) ||
    selection.inputHash !== manifest.imageIdentity.inputHash ||
    selection.dshRevision !== manifest.dshRevision ||
    selection.platform !== manifest.platform ||
    (reused
      ? selection.reason !== 'input-match' || selection.digest !== manifest.image.digest || selection.reference !== manifest.image.reference
      : !reasons.includes(selection.reason) ||
        selection.digest !== undefined ||
        selection.reference !== undefined ||
        manifest.imageIdentity.buildCommit !== manifest.commit)
  ) {
    throw Error('Invalid image reuse selection')
  }
  if (reused && !selection.rehearsal && !supportsImageReuse(manifest.targetVersion, manifest.compatibility)) {
    throw Error('Image reuse requires every supported baseline updater to understand independent image identity')
  }
}
