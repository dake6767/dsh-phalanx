import { readFile } from 'node:fs/promises'
import ts from 'typescript'

function moduleCompiler(names) {
  const bundled = new Set(names)
  const built = new Map()
  async function module(name) {
    if (built.has(name)) return built.get(name)
    let text = ts.transpileModule(await readFile(new URL(`../../src/adapters/${name}.ts`, import.meta.url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
    for (const match of [...text.matchAll(/import \{([^}]+)\} from ['"](\.\/|\.\.\/domain\/)([^'"]+)\.js['"];?/gu)]) {
      const [, names, prefix, dependency] = match
      const expression =
        prefix === './' && bundled.has(dependency)
          ? `import(${JSON.stringify(await module(dependency))})`
          : `import(pathToFileURL(process.argv[2] + '/dist/${prefix === './' ? 'adapters' : 'domain'}/${dependency}.js').href)`
      text = text.replace(match[0], `const {${names}} = await ${expression};`)
    }
    const result = 'data:text/javascript;base64,' + Buffer.from("import { pathToFileURL } from 'node:url';\n" + text).toString('base64')
    built.set(name, result)
    return result
  }
  return module
}

/** Compile the same platform adapters into the small executor: no second SQL or crypto implementation. */
export async function databaseProgram() {
  const module = moduleCompiler([
    'platform-upgrade-database',
    'postgres-upgrade-connection',
    'postgres-upgrade-tools',
    'platform-schema-versions',
    'platform-schema-registry',
  ])
  const database = await module('platform-upgrade-database'),
    tools = await module('postgres-upgrade-tools')
  return `// Generated from platform adapters. Uses the verified source package's connection and key owners.
import { readFileSync, fstatSync, readlinkSync } from 'node:fs';
const request = JSON.parse(readFileSync(0, 'utf8'));
if (request.installLockFd !== undefined) {
  const file=fstatSync(request.installLockFd);
  if (!file.isFile() || file.uid!==process.getuid() || (file.mode&511)!==384 || readlinkSync('/proc/self/fd/'+request.installLockFd)!==request.installLockPath) throw Error('Invalid upgrade installation lease');
  process.env.PHALANX_INSTALL_LOCK_FD=String(request.installLockFd);
} else if (request.action!=='inspect') throw Error('Database writes require the shared installation lease');
const database = await import(${JSON.stringify(database)});
const tools = await import(${JSON.stringify(tools)});
try {
  let result;
  if (request.action === 'prepare-tools') {
    const facts = request.facts;
    const tool = await tools.preparePostgresUpgradeTools(facts.serverMajor, facts.selection, request.pin, request.mirror);
    result = { tool };
  } else if (request.action === 'inspect') {
    result = await database.inspectUpgradeDatabase(request.configFile, request.dataRoot, request.schemas);
    if (request.sourceSchemas && result.schemas.some(row => !request.sourceSchemas.includes(row.name) && row.present)) throw Error('A target-only schema already exists outside the source registry');
  } else if (request.action === 'backup') {
    result = await database.backupUpgradeDatabase(request.configFile, request.dataRoot, request.facts, request.directory, new tools.PostgresUpgradeTools(request.tool));
  } else if (request.action === 'restore') {
    await database.restoreUpgradeDatabase(request.configFile, request.dataRoot, request.receipt, request.directory, new tools.PostgresUpgradeTools(request.tool));
    result = { restored: true };
  } else throw Error('Unsupported upgrade database operation');
  console.log(JSON.stringify(result));
} catch {
  console.error('Upgrade database operation failed; keep admission closed and inspect the selected connection, archive and tool identity');
  process.exitCode = 1;
}
`
}

/** Keep read-only control facts independent of the platform composition and migrations. */
export async function executorFactsProgram() {
  const module = moduleCompiler(['platform-executor-facts', 'postgres-download-sources', 'platform-schema-versions', 'platform-schema-registry'])
  return `// Generated from platform adapters. The source release owns its connection, key and TLS interpretation.
import { readFileSync } from 'node:fs';
try {
  const request = JSON.parse(readFileSync(0, 'utf8'));
  const { readExecutorFacts } = await import(${JSON.stringify(await module('platform-executor-facts'))});
  const result = await readExecutorFacts(request.configFile, request.dataRoot, request.fact, request.schemas);
  console.log(JSON.stringify(result));
} catch {
  console.error('Platform database facts are unavailable; inspect the selected connection and master-key file');
  process.exitCode = 2;
}
`
}
