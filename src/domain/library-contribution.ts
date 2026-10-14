import { contributionDeclaration, redactContributionDeclaration } from './contribution-checks.js'
import type { CommunityAccountActor } from './community-account.js'
import type { ContributionDeclaration, MemberContribution } from './member-contribution.js'
import { BusinessRuleError } from './business-error.js'

export interface LibraryMaintainer { readonly username: string, readonly spaceId: string }
export interface ContributionMaintenance { readonly assignMaintainer?: boolean, readonly anonymous?: boolean }
export interface LibraryVersionRecord {
  readonly version: string
  readonly fingerprint: string
  readonly submittedAt: number
  readonly source: 'member' | 'administrator'
  readonly contributor?: LibraryMaintainer
  readonly declaration?: ContributionDeclaration
  readonly fileHashes?: Readonly<Record<string, string>>
}
export interface LibraryProvenance {
  readonly maintainer: LibraryMaintainer | null
  readonly anonymous: boolean
  readonly versions: readonly LibraryVersionRecord[]
}
export interface ContributionChanges { readonly added: readonly string[], readonly changed: readonly string[], readonly deleted: readonly string[], readonly declaration?: { readonly before?: ContributionDeclaration, readonly after: ContributionDeclaration } }
export interface ContributionMaintenanceReview { readonly maintainer: LibraryMaintainer | null, readonly canAssignMaintainer: boolean, readonly anonymous: boolean, readonly changes?: ContributionChanges }
export interface LibraryContributionAdoption { readonly runtimeDependencies?: readonly string[], readonly row: MemberContribution, readonly maintenance?: ContributionMaintenance }
export const sameMaintainer = (left: LibraryMaintainer, right: LibraryMaintainer) => left.username === right.username && left.spaceId === right.spaceId
export function assertContributionMaintainer(provenance: LibraryProvenance | undefined, actor: CommunityAccountActor): void {
  if (provenance?.maintainer && !sameMaintainer(provenance.maintainer, actor)) throw new BusinessRuleError('forbidden', 'Only the maintainer can submit an update.', 'contribution-maintainer-required', { maintainer: provenance.maintainer.username })
}
/** Exact SemVer ordering, with arbitrary-size numeric identifiers and ignored build metadata. */
export function comparePluginVersions(left: string, right: string): number {
  const parse = (value: string) => { const [core, prerelease] = value.split('+')[0]!.split('-'); return { core: core!.split('.').map(BigInt), prerelease: prerelease === undefined ? undefined : value.split('+')[0]!.slice(core!.length + 1).split('.') } }
  const a = parse(left), b = parse(right)
  for (let index = 0; index < 3; index++) if (a.core[index] !== b.core[index]) return a.core[index]! > b.core[index]! ? 1 : -1
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index], y = b.prerelease[index]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const numericX = /^\d+$/u.test(x), numericY = /^\d+$/u.test(y)
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1
    if (numericX !== numericY) return numericX ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}
export function assertPluginContributionVersion(version: string, current?: string): void {
  if (current && comparePluginVersions(version, current) <= 0) throw new BusinessRuleError('invalid', 'Increase the plugin version, for example its patch number, before submitting an update.', 'contribution-version-required', { current })
}
export function validateContributionMaintenance(value?: ContributionMaintenance): void {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['assignMaintainer', 'anonymous'].includes(key)) || value.assignMaintainer !== undefined && typeof value.assignMaintainer !== 'boolean' || value.anonymous !== undefined && typeof value.anonymous !== 'boolean')) throw new BusinessRuleError('invalid', 'Review contribution ownership and attribution.', 'contribution-invalid')
}
export function libraryContributionProvenance(existing: LibraryProvenance | undefined, adoption: LibraryContributionAdoption, replacing: boolean): LibraryProvenance {
  const { row, maintenance } = adoption; validateContributionMaintenance(maintenance)
  assertContributionMaintainer(existing, row.contributor)
  const identity = { username: row.contributor.username, spaceId: row.contributor.spaceId }
  return { maintainer: existing?.maintainer ?? (!replacing || maintenance?.assignMaintainer === true ? identity : null), anonymous: maintenance?.anonymous ?? existing?.anonymous ?? false,
    versions: [...existing?.versions ?? [], { version: row.kind === 'plugin' ? row.plugin!.prepared.version : row.hash, fingerprint: row.hash, submittedAt: row.submittedAt, source: 'member', contributor: identity, declaration: redactContributionDeclaration(row.declaration, new Set(row.declaration.plugin?.environment.map(variable => variable.name) ?? [])), ...(row.fileHashes ? { fileHashes: row.fileHashes } : {}) }] }
}
export function administratorLibraryVersion(existing: LibraryProvenance | undefined, version: string, fingerprint: string, actor: CommunityAccountActor, time: number, fileHashes?: Readonly<Record<string, string>>): LibraryProvenance {
  return { maintainer: existing?.maintainer ?? null, anonymous: existing?.anonymous ?? false, versions: [...existing?.versions ?? [], { version, fingerprint, submittedAt: time, source: 'administrator', contributor: { username: actor.username, spaceId: actor.spaceId }, ...(fileHashes ? { fileHashes } : {}) }] }
}
export function libraryContributionCredit(provenance: LibraryProvenance | undefined): { readonly name?: string, readonly anonymous: boolean } | undefined {
  const latest = provenance?.versions.at(-1)
  if (!provenance || !latest || !provenance.maintainer && latest.source !== 'member') return undefined
  return provenance.anonymous ? { anonymous: true } : { ...(provenance.maintainer?.username ?? latest.contributor?.username ? { name: provenance.maintainer?.username ?? latest.contributor!.username } : {}), anonymous: false }
}
export function contributionFileChanges(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>, previous: ContributionDeclaration | undefined, declaration: ContributionDeclaration): ContributionChanges {
  previous = previous ? contributionDeclaration(previous) : undefined
  declaration = contributionDeclaration(declaration)
  const own = (object: Readonly<Record<string, string>>, name: string) => Object.hasOwn(object, name)
  return { added: Object.keys(after).filter(name => !own(before, name)).sort(), changed: Object.keys(after).filter(name => own(before, name) && before[name] !== after[name]).sort(), deleted: Object.keys(before).filter(name => !own(after, name)).sort(), ...(JSON.stringify(previous) !== JSON.stringify(declaration) ? { declaration: { ...(previous ? { before: previous } : {}), after: declaration } } : {}) }
}

export function libraryProvenanceRevision(value: LibraryProvenance | undefined) { return value ? [value.maintainer, value.anonymous, value.versions.length, value.versions.at(-1)?.fingerprint] : null }

/** Complete a persisted first-add intent in either normal preparation or compatibility recovery. */
export function completeAdministratorPluginSource(row: import('./plugin-library.js').LibraryPlugin): import('./plugin-library.js').LibraryPlugin {
  if (!row.pendingAdministrator || !row.current || row.stage !== 'available') return row
  const { pendingAdministrator, ...selected } = row
  return { ...selected, provenance: administratorLibraryVersion(row.provenance, row.current.version, row.current.integrity, pendingAdministrator.actor, pendingAdministrator.submittedAt) }
}
