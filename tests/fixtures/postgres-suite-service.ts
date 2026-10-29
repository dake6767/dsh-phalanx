import { mkdir, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { expect } from 'vitest'
import { postgresSkillService } from './postgres-skill-service.js'
import { fixtureGallery } from './suite-gallery.js'
import { delegatedPreset } from './suite-catalog.js'
import { createRuntimeStorage } from '../../src/composition/runtime-storage.js'
import { createSuiteStorage } from '../../src/composition/suite-storage.js'
import { RuntimeDependencies } from '../../src/use-cases/runtime-dependencies.js'
import { ExecutionAdministration } from '../../src/use-cases/execution-administration.js'
import { SuiteCatalog } from '../../src/use-cases/suite-catalog.js'
import type { SuiteCatalogEntry, SuiteCatalogSuiteEntry } from '../../src/domain/suite-catalog.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export function suiteVersion(version: 1 | 2): SuiteCatalogSuiteEntry {
  const base = delegatedPreset() as SuiteCatalogSuiteEntry,
    names = version === 1 ? ['one', 'obsolete'] : ['one', 'two']
  return {
    ...base,
    version: String(version),
    items: base.items.map(item =>
      item.kind === 'skill'
        ? { ...item, source: { ...item.source, commit: (version === 1 ? 'a' : 'b').repeat(40) }, names }
        : item.kind === 'skill-pack'
          ? { ...item, skills: names }
          : item.kind === 'runtime-dependency'
            ? { ...item, prepareCommands: { amd64: 'prepare-suite-cli-' + version } }
            : item.kind === 'execution' && version === 2
              ? { ...item, delegated: [{ command: 'suite-cli', blocked: ['auth', 'config', 'new-block'] }] }
              : item,
    ),
  }
}

/** Public catalog operations with real PostgreSQL facts; external Git/runtime preparation supplies fixed artifacts. */
export async function postgresSuiteService() {
  const hooks: { beforeGit?: () => Promise<void>; beforeCollect?: (retained: readonly string[]) => Promise<void>; beforeRuntime?: () => Promise<void> } = {},
    preparedArtifacts = new Set<string>(),
    preparedSkillArtifacts = new Set<string>()
  const skillArtifactLocation: { root?: string } = {}
  const prepareSkill = async (hash: string) => {
    if (!skillArtifactLocation.root) throw Error('Skill fixture is not initialized')
    await mkdir(join(skillArtifactLocation.root, hash), { recursive: true })
    await writeFile(join(skillArtifactLocation.root, hash, 'prepared'), 'prepared skill fixture')
    preparedSkillArtifacts.add(hash)
  }
  const f = await postgresSkillService({
    accept: async () => {
      throw Error('only catalog Git preparation')
    },
    read: async () => ({ markdown: '# Guide', files: ['SKILL.md'] }),
    newToken: () => 'unused',
    collect: async retained => {
      if (!skillArtifactLocation.root) return
      for (const hash of preparedSkillArtifacts)
        if (!retained.includes(hash)) {
          await rm(join(skillArtifactLocation.root, hash), { recursive: true, force: true })
          preparedSkillArtifacts.delete(hash)
        }
    },
    createNote: async (name, description, markdown) => {
      const hash = digest(name + markdown)
      await prepareSkill(hash)
      return { name, description, markdown, files: ['SKILL.md'], hash }
    },
    acceptGit: async source => {
      await hooks.beforeGit?.()
      const result = {
        packs: [],
        candidates: (source.ref === 'a'.repeat(40) ? ['one', 'obsolete'] : ['one', 'two']).map(name => ({
          name,
          description: name,
          markdown: '# ' + name,
          files: ['SKILL.md'],
          hash: digest(name + source.ref),
          path: name,
          internal: false,
          orchestration: false,
          warnings: [],
          source: { ...source, path: name, commit: source.ref, contentHash: digest(name + source.ref) },
        })),
      }
      for (const candidate of result.candidates) await prepareSkill(candidate.hash)
      return result
    },
  })
  skillArtifactLocation.root = join(f.root, 'skill-artifacts')
  const runtime = createRuntimeStorage(f.database)
  try {
    await runtime.initialize()
    const dependencies = new RuntimeDependencies(
      f.accounts,
      runtime.store,
      {
        isolated: true,
        recover: async () => {},
        collect: async retained => {
          await hooks.beforeCollect?.(retained)
          for (const id of preparedArtifacts)
            if (!retained.includes(id)) {
              await rm(join(f.root, 'runtime-artifacts', id), { recursive: true, force: true })
              preparedArtifacts.delete(id)
            }
        },
        identity: definition => definition.prepareCommand,
        prepare: async definition => {
          await hooks.beforeRuntime?.()
          const directory = join(f.root, 'runtime-artifacts', digest(definition.prepareCommand))
          await mkdir(directory, { recursive: true })
          await writeFile(join(directory, 'prepared'), 'prepared runtime fixture')
          preparedArtifacts.add(digest(definition.prepareCommand))
          return {
            id: digest(definition.prepareCommand),
            identity: definition.prepareCommand,
            directory: join(f.root, 'runtime-artifacts', digest(definition.prepareCommand)),
            mountedPath: '/runtime/suite-cli',
            commands: definition.type === 'resource' ? [] : [definition.name],
            commandPaths: definition.type === 'resource' ? {} : { [definition.name]: 'bin/' + definition.name },
            pathDirectories: definition.pathDirectories,
            bytes: 1,
            isolated: true,
            checks: [],
            log: 'Prepared fixture.',
          }
        },
      },
      { now: () => 1 },
      runtime.references,
    )
    const execution = new ExecutionAdministration(
      f.accounts,
      {
        get: id => {
          const skill = f.storage.library.view.list().find(row => id === 'skill:' + row.name)
          return skill ? { id, version: skill.hash } : undefined
        },
        owns: async () => true,
      },
      runtime.execution,
      async () => {},
      undefined,
      undefined,
      dependencies,
    )
    const store = createSuiteStorage(f.database)
    let entries: readonly SuiteCatalogEntry[] = [suiteVersion(1)]
    const gallery = { ...fixtureGallery(entries), entries: () => entries }
    const suites = new SuiteCatalog(f.accounts, gallery, store, dependencies, { now: () => 1 }, 'amd64', f.library, f.packs, execution)
    return {
      ...f,
      runtime,
      dependencies,
      execution,
      store,
      suites,
      hooks,
      preparedArtifacts,
      preparedSkillArtifacts,
      skillArtifactPath: (hash: string) => join(skillArtifactLocation.root!, hash, 'prepared'),
      upgrade: (entry: SuiteCatalogEntry) => {
        entries = [entry]
      },
      record: async () => (await store.installs.get('fixture-suite'))?.record,
      settled: async () => {
        await expect.poll(async () => (await store.installs.get('fixture-suite'))?.record.status, { timeout: 10000 }).toBe('installed')
      },
      close: async () => {
        try {
          await suites.stop()
        } finally {
          try {
            await dependencies.stop()
          } finally {
            try {
              await runtime.close()
            } finally {
              await f.close()
            }
          }
        }
      },
    }
  } catch (error) {
    await runtime.close()
    await f.close()
    throw error
  }
}
