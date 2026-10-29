import { BusinessRuleError } from '../domain/business-error.js'
import {
  suiteRuntimeDependencyDefinition,
  type SuiteCatalogArchitecture,
  type SuiteCatalogItem,
  type SuiteCatalogPluginItem,
  type SuiteCatalogRuntimeDependencyItem,
  type SuiteCatalogSkillItem,
  type SuiteCatalogSkillPackItem,
  type SuiteCatalogExecutionItem,
} from '../domain/suite-catalog.js'
import type { SuiteExecutionSnapshot, SuiteInstalledEntry } from '../domain/suite-install.js'
import { RuntimeDependencyPreparationFailure, type RuntimeDependency, type RuntimeDependencyDefinition } from '../domain/runtime-dependency.js'
import type { LibrarySkill } from '../domain/skill-library.js'
import { PluginPreparationError, type LibraryPlugin } from '../domain/plugin-library.js'
import type { PluginAccessSettings } from '../domain/plugin-access.js'
import type { SkillPack } from '../domain/skill-pack.js'
import type { SkillGitTarget } from '../domain/skill-git-source.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'

export interface SuiteItemPlan {
  readonly name: string
  readonly commands?: readonly string[]
  readonly detail?: string
}
/** Confirmation facts held only by the external preparation owner until the transaction completes. */
export interface SuiteReplacementPlan {
  readonly dependencies: ReadonlyMap<string, RuntimeDependency>
  readonly skills: readonly LibrarySkill[]
  readonly executions: readonly SuiteExecutionSnapshot[]
  readonly plugins?: readonly { readonly row: LibraryPlugin; readonly revision: string }[]
}
/** Preview and reference operations never mutate ordinary library facts. */
export interface SuiteItemOperations<Item extends SuiteCatalogItem> {
  available(item: Item): boolean
  plan(item: Item): SuiteItemPlan
  references(entry: SuiteInstalledEntry): readonly { kind: string; name: string }[] | Promise<readonly { kind: string; name: string }[]>
}
export class RuntimeDependencySuiteKind implements SuiteItemOperations<SuiteCatalogRuntimeDependencyItem> {
  constructor(
    private readonly dependencies: Pick<RuntimeDependencies, 'dependencyReferences'>,
    private readonly architecture: () => SuiteCatalogArchitecture,
  ) {}
  available(item: SuiteCatalogRuntimeDependencyItem): boolean {
    return Boolean(suiteRuntimeDependencyDefinition(item, this.architecture()))
  }
  plan(item: SuiteCatalogRuntimeDependencyItem): SuiteItemPlan & { definition: RuntimeDependencyDefinition } {
    const definition = suiteRuntimeDependencyDefinition(item, this.architecture())
    if (!definition) throw new BusinessRuleError('invalid', 'This architecture is unavailable.', 'suite-arch-unavailable')
    return { name: definition.name, commands: item.commands, definition }
  }
  async references(entry: SuiteInstalledEntry) {
    return (await this.dependencies.dependencyReferences(entry.name)).map(({ kind, name }) => ({ kind, name }))
  }
}
export class SkillSuiteKind implements SuiteItemOperations<SuiteCatalogSkillItem> {
  constructor(private readonly packs: Pick<SkillPackSuitePort, 'manualPacksContaining'>) {}
  available(): boolean {
    return true
  }
  plan(item: SuiteCatalogSkillItem): SuiteItemPlan {
    return { name: `${item.names.length} skills`, detail: `${item.source.url.replace('https://github.com/', '')} @ ${item.source.commit.slice(0, 7)}` }
  }
  async references(entry: SuiteInstalledEntry) {
    return (await this.packs.manualPacksContaining(entry.name)).map(name => ({ kind: 'skill-pack', name }))
  }
}
export class SkillPackSuiteKind implements SuiteItemOperations<SuiteCatalogSkillPackItem> {
  available(): boolean {
    return true
  }
  plan(item: SuiteCatalogSkillPackItem): SuiteItemPlan {
    return { name: item.name, detail: `${item.skills.length} skills` }
  }
  references(): readonly { kind: string; name: string }[] {
    return []
  }
}
export class ExecutionSuiteKind implements SuiteItemOperations<SuiteCatalogExecutionItem> {
  constructor(private readonly execution: ExecutionSuitePort | undefined) {}
  available(): boolean {
    return this.execution !== undefined
  }
  plan(item: SuiteCatalogExecutionItem): SuiteItemPlan {
    return { name: item.delegated.map(row => row.command).join(', '), detail: item.variables.map(row => row.name).join(', ') }
  }
  references(): readonly { kind: string; name: string }[] {
    return []
  }
}
export class PluginSuiteKind implements SuiteItemOperations<SuiteCatalogPluginItem> {
  constructor(private readonly plugins: PluginSuitePort | undefined) {}
  available(): boolean {
    return this.plugins !== undefined
  }
  plan(item: SuiteCatalogPluginItem): SuiteItemPlan {
    return { name: `${item.packageName}@${item.version}`, detail: item.runtimeDependencies.join(', ') }
  }
  references(): readonly { kind: string; name: string }[] {
    return []
  }
}
export interface SkillSuitePort {
  prepareSuiteImport(
    origin: string,
    source: SkillGitTarget,
    names: readonly string[],
    log: (line: string) => Promise<void>,
    signal: AbortSignal,
    replacing?: readonly string[],
    stageId?: string,
  ): Promise<void>
  suiteSkillConflicts(origin: string, names: readonly string[]): Promise<readonly string[]>
  discardSuiteImport(origin: string): Promise<void>
  suiteReplaceable(names: readonly string[], url: string): Promise<readonly LibrarySkill[]>
}
export interface SkillSuiteUpdatePort {
  suiteSkills(origin: string): Promise<readonly LibrarySkill[]>
  suiteSkillConflicts(origin: string, names: readonly string[]): Promise<readonly string[]>
}
export interface SkillPackSuitePort {
  suiteImpact(
    name: string,
  ): Promise<
    { readonly groups: readonly { readonly id: string; readonly name: string }[]; readonly published: boolean; readonly selectedMembers: number } | undefined
  >
  manualPacksContaining(name: string): Promise<readonly string[]>
  suitePackConflicts(origin: string, names: readonly string[]): Promise<readonly string[]>
}
export interface SkillPackSuiteUpdatePort {
  suitePack(origin: string): Promise<SkillPack | undefined>
}
export interface ExecutionSuitePort {
  saveSuiteCredentials(origin: string, owner: string, credentials: Readonly<Record<string, string>>): Promise<void>
  suiteExecutionSnapshot(owner: string): Promise<SuiteExecutionSnapshot | undefined>
  suiteExecutionStatus(
    owner: string,
  ): Promise<{ readonly enabled: boolean; readonly configuredVariables: readonly string[]; readonly missingCredentials: readonly string[] }>
  delegatedCommandConflicts(owner: string, commands: readonly string[], replacing?: readonly string[]): Promise<readonly string[]>
}
export interface ExecutionSuiteUpdatePort {
  suiteOwnedSnapshot(origin: string, owner: string): Promise<SuiteExecutionSnapshot | undefined>
}
export interface PluginSuitePort {
  observeSuiteClaims?(claims: () => readonly { packageName: string; origin: string }[]): void
  assertSuiteAdmission(origin: string, packageName: string): Promise<void>
  suitePluginConflicts(origin: string, packageName: string): Promise<readonly string[]>
  suitePluginReplaceable(packageName: string): Promise<{ readonly row: LibraryPlugin; readonly revision: string } | undefined>
  suitePluginRow(origin: string): Promise<LibraryPlugin | undefined>
  suitePluginImpact(origin: string): Promise<
    | {
        readonly name: string
        readonly groups: readonly { readonly id: string; readonly name: string }[]
        readonly published: boolean
        readonly selectedMembers: number
      }
    | undefined
  >
  suitePluginAccess(origin: string): Promise<PluginAccessSettings | undefined>
  discardSuitePlugin(origin: string): Promise<void>
}
export type PluginSuiteUpdatePort = Pick<PluginSuitePort, 'suitePluginRow' | 'suitePluginAccess'>

/** Keeps only the values this execution item declares. */
export function credentialsFor(item: SuiteCatalogExecutionItem, credentials: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const names = new Set(item.variables.map(row => row.name))
  return Object.fromEntries(Object.entries(credentials).filter(([name]) => names.has(name)))
}

/** Resolves declarative dependency names to the library names selected by this task. */
export function resolvedPluginItem(item: SuiteCatalogPluginItem, names: readonly string[]): SuiteCatalogPluginItem {
  const declared = [...item.runtimeDependencies, ...item.catalogDependencies]
  return {
    ...item,
    access: {
      ...item.access,
      environment: item.access.environment.map(row => ({
        ...row,
        value: row.value.replace(/\{dependency:([^{}]+)\}/gu, (token, name: string) => {
          const index = declared.indexOf(name)
          return index < 0 ? token : `{dependency:${names[index]}}`
        }),
      })),
    },
  }
}

/** Stable preparation failures survive catalog transaction rollback without message inspection. */
export function suitePreparationFailure(error: unknown): string {
  return error instanceof RuntimeDependencyPreparationFailure || error instanceof BusinessRuleError || error instanceof PluginPreparationError
    ? error.code
    : 'prepare-failed'
}
